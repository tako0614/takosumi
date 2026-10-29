#!/usr/bin/env bun
/** Local PostgreSQL operator entrypoint. Dry-run by default; no schema bootstrap. */
import { readFile } from "node:fs/promises";
import pgModule from "pg";
import type { SqlClient, SqlParameters, SqlTransaction } from "../core/adapters/storage/sql.ts";
import { SqlOpenTofuControlStore } from "../core/domains/deploy-control/store_sql.ts";
import {
  applyPostgresSourceOwnershipBackfill,
  inspectPostgresSourceOwnershipBackfill,
  type SourceOwnershipBackfillReport,
} from "../deploy/node-postgres/src/source-ownership-backfill.ts";

interface PoolLike {
  query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[]; rowCount?: number | null }>;
  connect(): Promise<{ query: PoolLike["query"]; release(): void }>;
  end(): Promise<void>;
}

export interface PostgresBackfillCliOptions {
  readonly sourceId?: string;
  readonly applyFile?: string;
}

export function parsePostgresBackfillArgs(argv: readonly string[]): PostgresBackfillCliOptions {
  let sourceId: string | undefined;
  let applyFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "--source-id" && arg !== "--apply") throw new Error("invalid_source_ownership_backfill_argument");
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error("missing_source_ownership_backfill_argument");
    if (arg === "--source-id") {
      if (sourceId || !/^[A-Za-z][A-Za-z0-9_-]{2,127}$/u.test(value))
        throw new Error("invalid_source_ownership_backfill_source_id");
      sourceId = value;
    } else {
      if (applyFile) throw new Error("duplicate_source_ownership_backfill_apply_file");
      applyFile = value;
    }
  }
  return { ...(sourceId ? { sourceId } : {}), ...(applyFile ? { applyFile } : {}) };
}

function sqlClient(pool: PoolLike): SqlClient {
  const query = async <Row extends Record<string, unknown>>(
    runner: Pick<PoolLike, "query">, statement: string, parameters?: SqlParameters,
  ) => {
    if (parameters !== undefined && !Array.isArray(parameters))
      throw new TypeError("PostgreSQL backfill expects positional SQL parameters");
    const result = await runner.query(statement, parameters as readonly unknown[] | undefined);
    return { rows: result.rows as readonly Row[], rowCount: result.rowCount ?? result.rows.length };
  };
  return {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
      statement: string, parameters?: SqlParameters,
    ) { return query<Row>(pool, statement, parameters); },
    async transaction<T>(fn: (transaction: SqlTransaction) => T | Promise<T>): Promise<T> {
      const connection = await pool.connect();
      const tx: SqlTransaction = {
        query<Row extends Record<string, unknown> = Record<string, unknown>>(
          statement: string, parameters?: SqlParameters,
        ) { return query<Row>(connection, statement, parameters); },
        transaction: (nested) => Promise.resolve(nested(tx)),
      };
      try {
        await connection.query("begin");
        const result = await fn(tx);
        await connection.query("commit");
        return result;
      } catch (error) {
        await connection.query("rollback").catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

function reviewedReport(value: unknown): SourceOwnershipBackfillReport {
  const item = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof item !== "object" || item === null || Array.isArray(item))
    throw new Error("source_ownership_backfill_apply_requires_one_reviewed_report");
  return item as SourceOwnershipBackfillReport;
}

export async function runPostgresSourceOwnershipBackfill(
  store: SqlOpenTofuControlStore, options: PostgresBackfillCliOptions,
  readReport: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<unknown> {
  if (!options.applyFile) {
    return await inspectPostgresSourceOwnershipBackfill(store, { sourceId: options.sourceId });
  }
  const report = reviewedReport(JSON.parse(await readReport(options.applyFile)));
  if (options.sourceId && options.sourceId !== report.sourceId)
    throw new Error("source_ownership_backfill_source_id_mismatch");
  const status = await applyPostgresSourceOwnershipBackfill(store, report);
  return { sourceId: report.sourceId, status, planDigest: report.planDigest };
}

if (import.meta.main) {
  let pool: PoolLike | undefined;
  try {
    const options = parsePostgresBackfillArgs(process.argv.slice(2));
    const databaseUrl = process.env.TAKOSUMI_ACCOUNTS_DATABASE_URL;
    if (!databaseUrl) throw new Error("TAKOSUMI_ACCOUNTS_DATABASE_URL_required");
    const pg = pgModule as unknown as { default?: { Pool?: new (cfg: Record<string, unknown>) => PoolLike };
      Pool?: new (cfg: Record<string, unknown>) => PoolLike };
    const Pool = pg.default?.Pool ?? pg.Pool;
    if (!Pool) throw new Error("postgres_pool_unavailable");
    pool = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 30_000 });
    const store = new SqlOpenTofuControlStore({ client: sqlClient(pool) });
    console.log(JSON.stringify(await runPostgresSourceOwnershipBackfill(store, options), null, 2));
  } catch (error) {
    // Database diagnostics may embed connection strings. Print only controlled
    // operator reasons; all other failures are identified by class name.
    const message = error instanceof Error ? error.message : "";
    console.error(message.startsWith("source_ownership_backfill_") || message === "TAKOSUMI_ACCOUNTS_DATABASE_URL_required"
      ? message : error instanceof Error ? error.name : "source_ownership_backfill_failed");
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
