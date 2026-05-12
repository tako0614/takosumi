#!/usr/bin/env -S deno run --allow-env --allow-read --allow-net
/**
 * Phase 11A: Takosumi DB migration runner CLI.
 *
 * Wraps the array-based StorageMigrationRunner so operators can apply the
 * canonical postgresStorageMigrationStatements catalog from a CLI:
 *
 *   deno task db:migrate                      # apply pending against $DATABASE_URL
 *   deno task db:migrate --env=staging        # apply pending against $TAKOSUMI_STAGING_DATABASE_URL
 *   deno task db:migrate --env=production     # apply pending against $TAKOSUMI_PRODUCTION_DATABASE_URL
 *   deno task db:migrate --env=local          # apply pending against an in-memory SqlClient
 *   deno task db:migrate:dry-run              # print SQL preview only, do not apply
 *
 * The script is intentionally small: catalog + checksum + ordering live in
 * StorageMigrationRunner. This file only routes a SqlClient and prints output.
 */

import {
  postgresStorageMigrationStatements,
  type StorageMigrationStatement,
} from "../src/adapters/storage/migrations.ts";
import { StorageMigrationRunner } from "../src/adapters/storage/migration-runner/mod.ts";
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

interface CliOptions {
  readonly env: EnvName;
  readonly dryRun: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let env: EnvName = "local";
  let dryRun = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--") {
      // Forwarded by `deno task <name> -- ...`; ignore.
      continue;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg.startsWith("--env=")) {
      const value = arg.slice("--env=".length);
      if (value === "local" || value === "staging" || value === "production") {
        env = value;
      } else {
        throw new Error(
          `unknown --env value: ${value} (expected local|staging|production)`,
        );
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { env, dryRun, help };
}

function printHelp(): void {
  console.log(
    [
      "takosumi db migrate runner",
      "",
      "Usage:",
      "  deno task db:migrate [--env=local|staging|production] [--dry-run]",
      "  deno task db:migrate:dry-run",
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
// ---------------------------------------------------------------------------

class InMemorySqlClient implements SqlClient, SqlTransaction {
  readonly #applied = new Map<string, AppliedRow>();
  #ledgerCreated = false;

  // deno-lint-ignore require-await
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase();
    if (
      normalized === "begin" ||
      normalized === "commit" ||
      normalized === "rollback"
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      normalized.startsWith("create table if not exists storage_migrations")
    ) {
      this.#ledgerCreated = true;
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
    // All other DDL/DML statements (the actual migration bodies) are accepted
    // unconditionally; the in-memory client doesn't model schema state.
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return await fn(this);
  }

  get ledgerCreated(): boolean {
    return this.#ledgerCreated;
  }
}

interface AppliedRow extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
  readonly checksum: string;
  readonly applied_at: string;
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
// Postgres SqlClient — staging/production. Opt-in: only loaded if
// DATABASE_URL is set. We import npm:pg lazily so local dev never needs it.
// ---------------------------------------------------------------------------

interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  connect(): Promise<{
    query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
}

async function createPostgresClient(databaseUrl: string): Promise<{
  client: SqlClient;
  close: () => Promise<void>;
}> {
  let pgModule: {
    default?: { Pool: new (cfg: { connectionString: string }) => PgPoolLike };
  };
  try {
    pgModule = await import("npm:pg@^8.11.0");
  } catch (error) {
    throw new Error(
      `failed to load npm:pg for --env=staging|production migrations: ${
        (error as Error).message
      }`,
    );
  }
  const Pool = pgModule.default?.Pool;
  if (!Pool) {
    throw new Error("npm:pg loaded but Pool export is missing");
  }
  const pool = new Pool({ connectionString: databaseUrl });

  const poolQuery = async <Row extends Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> => {
    const { sql: rendered, values } = renderNamedParams(sql, parameters);
    const result = await pool.query(rendered, values);
    return {
      rows: result.rows as Row[],
      rowCount: result.rows.length,
    };
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

function renderNamedParams(
  sql: string,
  parameters?: SqlParameters,
): { sql: string; values: unknown[] } {
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
}

// ---------------------------------------------------------------------------
// Resolve client per env
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  readonly client: SqlClient;
  readonly close: () => Promise<void>;
  readonly description: string;
}

async function resolveTarget(env: EnvName): Promise<ResolvedTarget> {
  if (env === "local") {
    const client = new InMemorySqlClient();
    return {
      client,
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
// Output helpers
// ---------------------------------------------------------------------------

function formatPreview(migration: StorageMigrationStatement): string {
  const sql = migration.sql.trim();
  const truncated = sql.length > 400 ? `${sql.slice(0, 400)}\n  ...` : sql;
  return [
    `--- migration ${migration.id} (version=${migration.version}, domain=${migration.domain})`,
    `--- ${migration.description}`,
    truncated,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(Deno.args);
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
    `[db-migrate] env=${options.env} dryRun=${options.dryRun} catalog=${postgresStorageMigrationStatements.length} migrations`,
  );

  // Dry-run never opens a real connection: it always plans against an empty
  // in-memory ledger to surface the full SQL preview deterministically.
  const target = options.dryRun
    ? {
      client: new InMemorySqlClient() as SqlClient,
      close: () => Promise.resolve(),
      description: "in-memory SqlClient (dry-run)",
    }
    : await resolveTarget(options.env);

  console.log(`[db-migrate] target: ${target.description}`);

  let exitCode = 0;
  try {
    const runner = new StorageMigrationRunner(target.client);
    const plan = await runner.plan();
    console.log(
      `[db-migrate] applied=${plan.applied.length} pending=${plan.pending.length}`,
    );
    if (plan.applied.length > 0) {
      for (const row of plan.applied) {
        console.log(`  - skip (already applied): ${row.id} v${row.version}`);
      }
    }
    if (plan.pending.length === 0) {
      console.log("[db-migrate] nothing to apply.");
      return 0;
    }
    if (options.dryRun) {
      console.log("[db-migrate] dry-run preview:");
      for (const pending of plan.pending) {
        console.log(formatPreview(pending.migration));
      }
      console.log(
        `[db-migrate] dry-run complete (${plan.pending.length} migration(s) would be applied).`,
      );
      return 0;
    }
    const result = await runner.applyPending();
    console.log(
      `[db-migrate] applied ${result.appliedNow.length} migration(s):`,
    );
    for (const entry of result.appliedNow) {
      console.log(
        `  + ${entry.migration.id} v${entry.migration.version} (${entry.migration.domain})`,
      );
    }
  } catch (error) {
    console.error(`[db-migrate] failed: ${(error as Error).message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
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
