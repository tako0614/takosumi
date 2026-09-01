/**
 * Postgres `SqlClient` for the operator-facing storage CLIs.
 *
 * `pg` is imported lazily so a local checkout that never touches a real
 * database does not need the driver installed. The module resolves no
 * connection string of its own: every caller passes an explicit URL it has
 * already authorized.
 */

import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../adapters/storage/sql.ts";
import { wrapPgResult } from "../adapters/storage/pg_result.ts";

interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  connect(): Promise<{
    query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
}

export interface PostgresSqlClientHandle {
  readonly client: SqlClient;
  readonly close: () => Promise<void>;
}

export async function createPostgresSqlClient(
  databaseUrl: string,
): Promise<PostgresSqlClientHandle> {
  let pgModule: {
    default?: { Pool: new (cfg: { connectionString: string }) => PgPoolLike };
    Pool?: new (cfg: { connectionString: string }) => PgPoolLike;
  };
  const loadErrors: string[] = [];
  try {
    pgModule = await import("npm:pg@^8.11.0");
  } catch (error) {
    loadErrors.push(`npm:pg@^8.11.0: ${(error as Error).message}`);
    try {
      pgModule = await import("pg");
    } catch (fallbackError) {
      loadErrors.push(`pg: ${(fallbackError as Error).message}`);
      throw new Error(
        "failed to load pg for a Postgres storage CLI: " +
          loadErrors.join("; "),
      );
    }
  }
  const Pool = pgModule.default?.Pool ?? pgModule.Pool;
  if (!Pool) {
    throw new Error("pg loaded but Pool export is missing");
  }
  const pool = new Pool({ connectionString: databaseUrl });

  const poolQuery = async <Row extends Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> => {
    const { sql: rendered, values } = renderNamedParams(sql, parameters);
    return wrapPgResult<Row>(await pool.query(rendered, values));
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
        return wrapPgResult<Row>(await conn.query(rendered, values));
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

export function renderNamedParams(
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
