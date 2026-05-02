/**
 * Production-grade Postgres helpers for the self-hosted profile.
 *
 * Wraps the operator-injected `SelfHostedPostgresPoolClient` (see
 * `injected_clients.ts`) with the pieces a real deploy needs:
 *
 *   - migration runner with monotonic versioning (idempotent re-apply, dry-run)
 *   - retry / timeout utility around transient errors (network / serialization)
 *   - health probe usable from readiness / runtime-agent shutdown hooks
 *   - pool stats summary surfaced as `ProviderObservation`-style record
 *
 * The classes here intentionally stay pure (no `await Deno.sleep` polling) —
 * they take an injected `sleep` for testability and a `clock` for deterministic
 * timestamps.
 */
import { freezeClone } from "./common.ts";
import type { SelfHostedPostgresPoolClient } from "./injected_clients.ts";
import type { SelfHostedSqlClient, SelfHostedSqlValue } from "./sql.ts";

export type SelfHostedPostgresErrorCode =
  | "connection-refused"
  | "serialization-failure"
  | "timeout"
  | "permission-denied"
  | "unique-violation"
  | "syntax-error"
  | "unavailable"
  | "unknown";

export interface SelfHostedPostgresErrorOptions {
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly sqlState?: string;
  readonly details?: Record<string, unknown>;
}

export class SelfHostedPostgresError extends Error {
  readonly code: SelfHostedPostgresErrorCode;
  readonly retryable: boolean;
  readonly sqlState?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SelfHostedPostgresErrorCode,
    message: string,
    options: SelfHostedPostgresErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "SelfHostedPostgresError";
    this.code = code;
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.sqlState = options.sqlState;
    this.details = options.details;
  }
}

export interface SelfHostedPostgresMigration {
  readonly id: string;
  readonly description?: string;
  readonly statements: readonly string[];
}

export interface SelfHostedPostgresMigrationRecord {
  readonly id: string;
  readonly appliedAt: string;
  readonly checksum: string;
  readonly description?: string;
}

export interface SelfHostedPostgresMigrationOptions {
  readonly tableName?: string;
  readonly clock?: () => Date;
  readonly dryRun?: boolean;
}

export interface SelfHostedPostgresMigrationOutcome {
  readonly applied: readonly SelfHostedPostgresMigrationRecord[];
  readonly skipped: readonly string[];
  readonly dryRun: boolean;
}

const DEFAULT_MIGRATION_TABLE = "takos_paas_migrations";

/**
 * Migration runner. Walks `migrations` in order, applies each within a
 * transaction (when the client supports `transaction`), and skips ids already
 * recorded in the `<tableName>` ledger.
 */
export class SelfHostedPostgresMigrationRunner {
  readonly #client: SelfHostedSqlClient;
  readonly #tableName: string;
  readonly #clock: () => Date;
  readonly #dryRun: boolean;

  constructor(
    client: SelfHostedSqlClient,
    options: SelfHostedPostgresMigrationOptions = {},
  ) {
    this.#client = client;
    this.#tableName = options.tableName ?? DEFAULT_MIGRATION_TABLE;
    this.#clock = options.clock ?? (() => new Date());
    this.#dryRun = options.dryRun ?? false;
  }

  async ensureLedger(): Promise<void> {
    await this.#client.query(
      `create table if not exists ${this.#tableName} (
        id text primary key,
        description text,
        checksum text not null,
        applied_at text not null
      )`,
    );
  }

  async listApplied(): Promise<readonly SelfHostedPostgresMigrationRecord[]> {
    await this.ensureLedger();
    const result = await this.#client.query<{
      id?: string;
      description?: string;
      checksum?: string;
      applied_at?: string;
      appliedAt?: string;
    }>(
      `select id, description, checksum, applied_at as "appliedAt"
       from ${this.#tableName}
       order by applied_at asc`,
    );
    return result.rows.map((row) => ({
      id: String(row.id ?? ""),
      description: row.description ?? undefined,
      checksum: String(row.checksum ?? ""),
      appliedAt: String(row.appliedAt ?? row.applied_at ?? ""),
    }));
  }

  async apply(
    migrations: readonly SelfHostedPostgresMigration[],
  ): Promise<SelfHostedPostgresMigrationOutcome> {
    await this.ensureLedger();
    const applied: SelfHostedPostgresMigrationRecord[] = [];
    const skipped: string[] = [];
    const ledger = new Map(
      (await this.listApplied()).map((record) => [record.id, record]),
    );
    for (const migration of migrations) {
      const checksum = await checksumOf(migration);
      const existing = ledger.get(migration.id);
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new SelfHostedPostgresError(
            "unknown",
            `migration ${migration.id} checksum mismatch (already applied with different content)`,
            { details: { previous: existing.checksum, incoming: checksum } },
          );
        }
        skipped.push(migration.id);
        continue;
      }
      if (this.#dryRun) {
        skipped.push(migration.id);
        continue;
      }
      await this.#runMigration(migration, checksum);
      applied.push({
        id: migration.id,
        description: migration.description,
        checksum,
        appliedAt: this.#clock().toISOString(),
      });
    }
    return freezeClone({ applied, skipped, dryRun: this.#dryRun });
  }

  async #runMigration(
    migration: SelfHostedPostgresMigration,
    checksum: string,
  ): Promise<void> {
    const exec = async (client: SelfHostedSqlClient) => {
      for (const statement of migration.statements) {
        await client.query(statement);
      }
      await client.query(
        `insert into ${this.#tableName}
          (id, description, checksum, applied_at)
         values (:id, :description, :checksum, :appliedAt)`,
        {
          id: migration.id,
          description: migration.description ?? null,
          checksum,
          appliedAt: this.#clock().toISOString(),
        },
      );
    };
    if (this.#client.transaction) {
      await this.#client.transaction(async (tx) => await exec(tx));
      return;
    }
    await this.#client.query("begin");
    try {
      await exec(this.#client);
      await this.#client.query("commit");
    } catch (error) {
      await this.#client.query("rollback");
      throw error;
    }
  }
}

/**
 * Health probe with caller-controlled timeout. Returns the latency in ms.
 */
export async function probePostgresHealth(
  client: SelfHostedPostgresPoolClient,
  options: { readonly timeoutMs?: number; readonly clock?: () => Date } = {},
): Promise<{ readonly ok: boolean; readonly latencyMs: number }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const clock = options.clock ?? (() => new Date());
  const started = clock().getTime();
  const probe = client.healthcheck
    ? client.healthcheck()
    : client.query("select 1 as ok").then(() => ({ ok: true } as const));
  const result = await Promise.race([
    probe,
    timeoutAfter(timeoutMs),
  ]);
  const latencyMs = clock().getTime() - started;
  if (result === "timeout") {
    return { ok: false, latencyMs };
  }
  return {
    ok: (result as { ok?: boolean }).ok !== false,
    latencyMs: (result as { latencyMs?: number }).latencyMs ?? latencyMs,
  };
}

/**
 * Retry helper specialised for the self-hosted SQL surface. Maps unknown
 * errors into `SelfHostedPostgresError` and applies exponential backoff with
 * jitter capped by `maxBackoffMs`.
 */
export async function retryPostgres<T>(
  fn: () => Promise<T>,
  options: {
    readonly maxAttempts?: number;
    readonly initialBackoffMs?: number;
    readonly maxBackoffMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly classify?: (error: unknown) => SelfHostedPostgresError;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const initialBackoff = options.initialBackoffMs ?? 50;
  const maxBackoff = options.maxBackoffMs ?? 2_000;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const classify = options.classify ?? defaultClassifyError;
  let lastError: SelfHostedPostgresError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = classify(error);
      if (!lastError.retryable || attempt === maxAttempts) throw lastError;
      const delay = Math.min(
        initialBackoff * 2 ** (attempt - 1),
        maxBackoff,
      );
      await sleep(delay);
    }
  }
  throw lastError ??
    new SelfHostedPostgresError("unknown", "retry exhausted with no error");
}

function defaultClassifyError(error: unknown): SelfHostedPostgresError {
  if (error instanceof SelfHostedPostgresError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return new SelfHostedPostgresError("timeout", message, {
      cause: error,
      retryable: true,
    });
  }
  if (/serialization|deadlock/i.test(message)) {
    return new SelfHostedPostgresError("serialization-failure", message, {
      cause: error,
      retryable: true,
    });
  }
  if (/unique|duplicate key/i.test(message)) {
    return new SelfHostedPostgresError("unique-violation", message, {
      cause: error,
      retryable: false,
    });
  }
  if (/permission denied|not authorised|not authorized/i.test(message)) {
    return new SelfHostedPostgresError("permission-denied", message, {
      cause: error,
      retryable: false,
    });
  }
  if (/connect.*refused|ECONNREFUSED|connection terminated/i.test(message)) {
    return new SelfHostedPostgresError("connection-refused", message, {
      cause: error,
      retryable: true,
    });
  }
  return new SelfHostedPostgresError("unknown", message, {
    cause: error,
    retryable: false,
  });
}

function defaultRetryable(code: SelfHostedPostgresErrorCode): boolean {
  switch (code) {
    case "connection-refused":
    case "serialization-failure":
    case "timeout":
    case "unavailable":
      return true;
    default:
      return false;
  }
}

async function checksumOf(
  migration: SelfHostedPostgresMigration,
): Promise<string> {
  const payload = `${migration.id}\n${migration.description ?? ""}\n${
    migration.statements.join(";\n")
  }`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function timeoutAfter(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

export type _SelfHostedPostgresParameter = SelfHostedSqlValue; // re-export hint
