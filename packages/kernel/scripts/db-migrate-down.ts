#!/usr/bin/env -S deno run --allow-env --allow-read --allow-net
/**
 * Phase 18.2 (H13): Takosumi DB rollback CLI.
 *
 * Companion to `scripts/db-migrate.ts`. Reverses applied migrations by running
 * their `down` clause and removing the corresponding row from
 * `storage_migrations`. Each migration is rolled back inside a transaction.
 *
 *   deno task db:migrate:down                       # rollback the most recent migration
 *   deno task db:migrate:down --target=<version>    # rollback every migration with version > <version>
 *   deno task db:migrate:rollback --steps=<n>       # rollback the N most recent migrations
 *   deno task db:migrate:down --dry-run             # preview only, no writes
 *
 * Safety:
 *   - The default `--env` is `local` (in-memory SqlClient — no I/O against any
 *     real database). This makes it safe to invoke during tests.
 *   - `--env=staging` requires `$TAKOSUMI_STAGING_DATABASE_URL` (or
 *     `$DATABASE_URL`), same as forward migration.
 *   - `--env=production` is **gated**: the CLI exits non-zero unless the
 *     operator passes `--allow-production-rollback`. Running interactively
 *     also requires typing `ROLLBACK` at the confirmation prompt; running
 *     non-interactively requires `--confirm=ROLLBACK`. CI scripts must opt
 *     in explicitly so an accidental `db:migrate:down` invocation cannot
 *     destroy production schema.
 */

import { postgresStorageMigrationStatements } from "../src/adapters/storage/migrations.ts";
import {
  StorageMigrationDownNotSupportedError,
  StorageMigrationRunner,
} from "../src/adapters/storage/migration-runner/mod.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../src/adapters/storage/sql.ts";

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

type EnvName = "local" | "staging" | "production";

export interface DownCliOptions {
  readonly env: EnvName;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly targetVersion?: number;
  readonly steps?: number;
  readonly allowProductionRollback: boolean;
  readonly confirm?: string;
}

export function parseDownArgs(argv: readonly string[]): DownCliOptions {
  let env: EnvName = "local";
  let dryRun = false;
  let help = false;
  let targetVersion: number | undefined;
  let steps: number | undefined;
  let allowProductionRollback = false;
  let confirm: string | undefined;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--allow-production-rollback") {
      allowProductionRollback = true;
    } else if (arg.startsWith("--env=")) {
      const value = arg.slice("--env=".length);
      if (value === "local" || value === "staging" || value === "production") {
        env = value;
      } else {
        throw new Error(
          `unknown --env value: ${value} (expected local|staging|production)`,
        );
      }
    } else if (arg.startsWith("--target=")) {
      const raw = arg.slice("--target=".length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error(
          `invalid --target value: ${raw} (expected a non-negative integer)`,
        );
      }
      targetVersion = parsed;
    } else if (arg.startsWith("--steps=")) {
      const raw = arg.slice("--steps=".length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        throw new Error(
          `invalid --steps value: ${raw} (expected a positive integer)`,
        );
      }
      steps = parsed;
    } else if (arg.startsWith("--confirm=")) {
      confirm = arg.slice("--confirm=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (typeof targetVersion === "number" && typeof steps === "number") {
    throw new Error(
      "cannot combine --target and --steps; use one or the other",
    );
  }
  return {
    env,
    dryRun,
    help,
    targetVersion,
    steps,
    allowProductionRollback,
    confirm,
  };
}

function printHelp(): void {
  console.log(
    [
      "takosumi db migrate-down runner",
      "",
      "Usage:",
      "  deno task db:migrate:down [--env=local|staging|production] [--target=<v>|--steps=<n>] [--dry-run]",
      "  deno task db:migrate:rollback --steps=<n>",
      "  deno task db:migrate:down --env=production --allow-production-rollback --confirm=ROLLBACK",
      "",
      "Options:",
      "  --target=<version>           rollback every applied migration with version > <version>",
      "  --steps=<n>                  rollback the N most recently applied migrations (default 1)",
      "  --dry-run                    print plan, do not modify the database",
      "  --allow-production-rollback  required for --env=production; absent it the CLI refuses",
      "  --confirm=ROLLBACK           non-interactive confirmation phrase (production only)",
      "",
      "Env vars (read by --env):",
      "  --env=production   $TAKOSUMI_PRODUCTION_DATABASE_URL or $DATABASE_URL",
      "  --env=staging      $TAKOSUMI_STAGING_DATABASE_URL or $DATABASE_URL",
      "  --env=local        in-memory SqlClient (no network)",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// In-memory SqlClient — used by --env=local and by --dry-run.
//
// The local client tracks which migrations have been applied. To make the
// down runner observable in --env=local we accept an optional pre-seeded
// `applied` set; tests use this to drive rollback flows without first
// running the forward migrations against the same client.
// ---------------------------------------------------------------------------

interface AppliedRow extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
  readonly checksum: string;
  readonly applied_at: string;
}

class InMemorySqlClient implements SqlClient, SqlTransaction {
  readonly #applied = new Map<string, AppliedRow>();

  constructor(seed?: readonly AppliedRow[]) {
    if (seed) {
      for (const row of seed) this.#applied.set(row.id, row);
    }
  }

  // deno-lint-ignore require-await
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase();
    if (
      normalized === "begin" || normalized === "commit" ||
      normalized === "rollback"
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      normalized.startsWith("create table if not exists storage_migrations")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("alter table storage_migrations")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("select id, version, checksum, applied_at")) {
      const rows = [...this.#applied.values()].sort((left, right) =>
        left.version === right.version
          ? left.id.localeCompare(right.id)
          : left.version - right.version
      );
      return ledgerRowsAs<Row>(rows);
    }
    if (normalized.startsWith("insert into storage_migrations")) {
      const params = asRecord(parameters);
      const id = String(params.id ?? "");
      this.#applied.set(id, {
        id,
        version: Number(params.version ?? 0),
        checksum: String(params.checksum ?? ""),
        applied_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("delete from storage_migrations where id")) {
      const params = asRecord(parameters);
      const id = String(params.id ?? "");
      const removed = this.#applied.delete(id) ? 1 : 0;
      return { rows: [], rowCount: removed };
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return await fn(this);
  }

  appliedIds(): readonly string[] {
    return [...this.#applied.keys()];
  }
}

function asRecord(
  value: SqlParameters | undefined,
): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return {};
}

// The in-memory ledger only ever serves one `select` (the storage_migrations
// ledger), and its row shape is `AppliedRow`. The `query<Row>` signature
// allows callers to choose a `Row` extending `Record<string, unknown>` —
// strictly broader than `AppliedRow`. The migration-runner is the only
// caller, and it asks for an `AppliedMigrationRow` (the same shape with
// `unknown` field types) and coerces every field with `String(...)` /
// `Number(...)` immediately. The named type-guard below documents that
// trust at the boundary.
function rowsSatisfyCallerRowType<Row extends Record<string, unknown>>(
  rows: readonly AppliedRow[],
): rows is readonly AppliedRow[] & readonly Row[] {
  return rows.every((row) =>
    typeof row.id === "string" &&
    typeof row.version === "number" &&
    typeof row.checksum === "string" &&
    typeof row.applied_at === "string"
  );
}

function ledgerRowsAs<Row extends Record<string, unknown>>(
  rows: readonly AppliedRow[],
): SqlQueryResult<Row> {
  if (!rowsSatisfyCallerRowType<Row>(rows)) {
    throw new Error("InMemorySqlClient ledger row shape drifted");
  }
  return { rows, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Postgres SqlClient — staging/production. Lazily imports npm:pg.
// ---------------------------------------------------------------------------

interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  connect(): Promise<{
    query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
}

async function createPostgresClient(
  databaseUrl: string,
): Promise<{ client: SqlClient; close: () => Promise<void> }> {
  let pgModule: {
    default?: { Pool: new (cfg: { connectionString: string }) => PgPoolLike };
  };
  try {
    pgModule = await import("npm:pg@^8.11.0");
  } catch (error) {
    throw new Error(
      `failed to load npm:pg for --env=staging|production rollback: ${
        (error as Error).message
      }`,
    );
  }
  const Pool = pgModule.default?.Pool;
  if (!Pool) throw new Error("npm:pg loaded but Pool export is missing");
  const pool = new Pool({ connectionString: databaseUrl });

  const renderNamedParams = (
    sql: string,
    parameters?: SqlParameters,
  ): { sql: string; values: unknown[] } => {
    if (!parameters) return { sql, values: [] };
    if (Array.isArray(parameters)) {
      return { sql, values: parameters as unknown[] };
    }
    const record = parameters as Readonly<Record<string, unknown>>;
    const order: string[] = [];
    const rendered = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      order.push(name as string);
      return `$${order.length}`;
    });
    return { sql: rendered, values: order.map((name) => record[name]) };
  };

  const poolQuery = async <Row extends Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> => {
    const { sql: rendered, values } = renderNamedParams(sql, parameters);
    const result = await pool.query(rendered, values);
    return { rows: result.rows as Row[], rowCount: result.rows.length };
  };

  const client: SqlClient = {
    query: poolQuery,
    async transaction<T>(
      fn: (transaction: SqlTransaction) => T | Promise<T>,
    ): Promise<T> {
      const conn = await pool.connect();
      const connQuery = async <Row extends Record<string, unknown>>(
        sql: string,
        parameters?: SqlParameters,
      ): Promise<SqlQueryResult<Row>> => {
        const { sql: rendered, values } = renderNamedParams(sql, parameters);
        const result = await conn.query(rendered, values);
        return { rows: result.rows as Row[], rowCount: result.rows.length };
      };
      try {
        await conn.query("begin");
        const txClient: SqlTransaction = {
          query: connQuery,
          async commit() {
            await conn.query("commit");
          },
          async rollback() {
            await conn.query("rollback");
          },
        };
        const value = await fn(txClient);
        await conn.query("commit");
        return value;
      } catch (error) {
        await conn.query("rollback").catch(() => {});
        throw error;
      } finally {
        conn.release();
      }
    },
  };
  return { client, close: () => pool.end() };
}

interface ResolvedTarget {
  readonly client: SqlClient;
  readonly close: () => Promise<void>;
  readonly description: string;
}

async function resolveTarget(env: EnvName): Promise<ResolvedTarget> {
  if (env === "local") {
    return {
      client: new InMemorySqlClient(),
      close: () => Promise.resolve(),
      description: "in-memory SqlClient (env=local)",
    };
  }
  const candidates = env === "production"
    ? ["TAKOSUMI_PRODUCTION_DATABASE_URL", "DATABASE_URL"]
    : ["TAKOSUMI_STAGING_DATABASE_URL", "DATABASE_URL"];
  let url: string | undefined;
  for (const key of candidates) {
    const value = Deno.env.get(key);
    if (value && value.length > 0) {
      url = value;
      break;
    }
  }
  if (!url) {
    throw new Error(
      `no database URL found for --env=${env} (set ${candidates.join(" or ")})`,
    );
  }
  const { client, close } = await createPostgresClient(url);
  return { client, close, description: `postgres (env=${env})` };
}

// ---------------------------------------------------------------------------
// Production safety guard
// ---------------------------------------------------------------------------

export interface ProductionGuardOptions {
  readonly env: EnvName;
  readonly dryRun: boolean;
  readonly allowProductionRollback: boolean;
  readonly confirm?: string;
  readonly prompt?: () => Promise<string | null>;
  readonly isInteractive?: boolean;
}

export interface ProductionGuardOutcome {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Pure gate logic; exported so the test suite can exercise it without an
 * actual TTY or database connection.
 */
export async function evaluateProductionGuard(
  options: ProductionGuardOptions,
): Promise<ProductionGuardOutcome> {
  if (options.env !== "production") return { allowed: true };
  if (options.dryRun) {
    // Dry-run is read-only; the gate does not block it.
    return { allowed: true };
  }
  if (!options.allowProductionRollback) {
    return {
      allowed: false,
      reason:
        "refusing to rollback against --env=production without --allow-production-rollback",
    };
  }
  const requiredPhrase = "ROLLBACK";
  if (options.confirm !== undefined) {
    if (options.confirm === requiredPhrase) return { allowed: true };
    return {
      allowed: false,
      reason:
        `--confirm value must be '${requiredPhrase}' for production rollback`,
    };
  }
  if (options.isInteractive && options.prompt) {
    const answer = (await options.prompt()) ?? "";
    if (answer.trim() === requiredPhrase) return { allowed: true };
    return {
      allowed: false,
      reason:
        `production rollback prompt: expected '${requiredPhrase}', got '${answer}'`,
    };
  }
  return {
    allowed: false,
    reason:
      `production rollback requires either an interactive prompt confirming '${requiredPhrase}' or --confirm=${requiredPhrase}`,
  };
}

function readLineFromStdin(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const buf = new Uint8Array(256);
    Deno.stdin.read(buf).then((n) => {
      if (n === null) {
        resolve(null);
        return;
      }
      resolve(new TextDecoder().decode(buf.subarray(0, n)).replace(/\n$/, ""));
    }).catch(() => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let options: DownCliOptions;
  try {
    options = parseDownArgs(Deno.args);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    printHelp();
    return 1;
  }
  if (options.help) {
    printHelp();
    return 0;
  }

  console.log(
    `[db-migrate-down] env=${options.env} dryRun=${options.dryRun} target=${
      options.targetVersion ?? "-"
    } steps=${
      options.steps ?? "-"
    } catalog=${postgresStorageMigrationStatements.length} migrations`,
  );

  const guard = await evaluateProductionGuard({
    env: options.env,
    dryRun: options.dryRun,
    allowProductionRollback: options.allowProductionRollback,
    confirm: options.confirm,
    prompt: () => {
      console.log(
        "[db-migrate-down] type 'ROLLBACK' to confirm production rollback:",
      );
      return readLineFromStdin();
    },
    isInteractive: Deno.stdin.isTerminal?.() ?? false,
  });
  if (!guard.allowed) {
    console.error(`[db-migrate-down] ${guard.reason}`);
    return 1;
  }

  const target = await resolveTarget(options.env);
  console.log(`[db-migrate-down] target: ${target.description}`);

  let exitCode = 0;
  try {
    const runner = new StorageMigrationRunner(target.client);
    const planned = await runner.planRollback({
      targetVersion: options.targetVersion,
      steps: options.steps,
    });
    if (planned.length === 0) {
      console.log("[db-migrate-down] nothing to rollback.");
      return 0;
    }
    console.log(`[db-migrate-down] planned ${planned.length} rollback(s):`);
    for (const entry of planned) {
      console.log(
        `  - ${entry.migration.id} v${entry.migration.version} (${entry.migration.domain})`,
      );
    }
    if (options.dryRun) {
      console.log("[db-migrate-down] dry-run complete (no rows modified).");
      return 0;
    }
    const result = await runner.rollback({
      targetVersion: options.targetVersion,
      steps: options.steps,
    });
    console.log(
      `[db-migrate-down] rolled back ${result.rolledBackNow.length} migration(s):`,
    );
    for (const entry of result.rolledBackNow) {
      console.log(
        `  - ${entry.migration.id} v${entry.migration.version} (${entry.migration.domain})`,
      );
    }
  } catch (error) {
    if (error instanceof StorageMigrationDownNotSupportedError) {
      console.error(
        `[db-migrate-down] cannot rollback: ${error.message}. ` +
          `Add a 'down' clause to the migration or pick an earlier --target.`,
      );
    } else {
      console.error(
        `[db-migrate-down] failed: ${(error as Error).message}`,
      );
      if (error instanceof Error && error.stack) console.error(error.stack);
    }
    exitCode = 1;
  } finally {
    await target.close().catch(() => {});
  }
  return exitCode;
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}
