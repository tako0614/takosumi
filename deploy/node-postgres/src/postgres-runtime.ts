/** Shared Postgres transport; importing this module starts no server or pool. */
import pgModule from "pg";
import type { PostgresQueryClient } from "@takosjp/takosumi-accounts-service";
import type { SqlClient, SqlParameters, SqlTransaction } from "../../../core/adapters/storage/sql.ts";

interface PgPoolConfig {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statement_timeout?: number;
  ssl?: false | { rejectUnauthorized: boolean; ca?: string };
}

interface PgQueryResult {
  rows: unknown[];
  rowCount?: number;
}

interface PgPoolClient {
  query(sql: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  release(): void;
}

export interface PgPool {
  query(sql: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

type PgPoolConstructor = new (cfg: PgPoolConfig) => PgPool;
function resolvePoolCtor(): PgPoolConstructor {
  const pg = pgModule as unknown as {
    default?: { Pool?: PgPoolConstructor };
    Pool?: PgPoolConstructor;
  };
  const candidate = pg.default?.Pool ?? pg.Pool;
  if (!candidate) throw new Error("npm:pg Pool export missing");
  return candidate;
}

export function createPostgresPool(config: { readonly databaseUrl: string }, env: Record<string, string | undefined>): PgPool {
  const PoolCtor = resolvePoolCtor();
  const cfg: PgPoolConfig = {
    connectionString: config.databaseUrl,
    max: parsePoolSize(env),
    idleTimeoutMillis:
      parseInteger(env, "TAKOSUMI_ACCOUNTS_PG_IDLE_TIMEOUT_MS") ?? 30000,
    connectionTimeoutMillis:
      parseInteger(env, "TAKOSUMI_ACCOUNTS_PG_CONNECT_TIMEOUT_MS") ?? 5000,
    statement_timeout:
      parseInteger(env, "TAKOSUMI_ACCOUNTS_PG_STATEMENT_TIMEOUT_MS") ?? 30000,
    ssl: parseSslConfig(env),
  };
  return new PoolCtor(cfg);
}

export function wrapPool(pool: PgPool): PostgresQueryClient {
  return {
    async queryObject<T>(
      sql: string,
      args: readonly unknown[] = [],
    ): Promise<{ rows: T[] }> {
      const result = await pool.query(sql, args);
      return { rows: result.rows as T[] };
    },
  };
}

export function wrapServiceSqlClient(pool: PgPool): SqlClient {
  const runQuery = async <Row extends Record<string, unknown>>(
    runner: Pick<PgPool, "query">,
    sql: string,
    parameters?: SqlParameters,
  ): Promise<{ rows: readonly Row[]; rowCount: number }> => {
    if (parameters !== undefined && !Array.isArray(parameters)) {
      throw new TypeError(
        "node-postgres service SQL adapter expects positional parameters",
      );
    }
    const result = await runner.query(sql, parameters as readonly unknown[]);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  };
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: SqlParameters,
    ): Promise<{ rows: readonly Row[]; rowCount: number }> {
      return await runQuery<Row>(pool, sql, parameters);
    },
    // Interactive transaction over a pinned connection: BEGIN / COMMIT, with a
    // best-effort ROLLBACK on any throw, mirroring core/index.ts. Atomic
    // ledger commits (commitRunState) run their whole write set here so
    // a mid-sequence failure rolls back instead of leaving torn state.
    async transaction<T>(
      fn: (transaction: SqlTransaction) => T | Promise<T>,
    ): Promise<T> {
      const conn = await pool.connect();
      // The pinned-connection handle is itself a transaction. A nested
      // transaction(fn) runs fn against the same connection — the ledger commit
      // never nests, so flat re-entry is the correct (no savepoint) behavior.
      const tx: SqlTransaction = {
        query: (sql, parameters) => runQuery(conn, sql, parameters),
        transaction: (nested) => Promise.resolve(nested(tx)),
      };
      try {
        await conn.query("begin");
        const value = await fn(tx);
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
}

function parsePoolSize(env: Record<string, string | undefined>): number {
  return parseInteger(env, "TAKOSUMI_ACCOUNTS_PG_POOL_MAX") ?? 20;
}

function parseInteger(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

/**
 * Read TAKOSUMI_ACCOUNTS_PG_SSL_MODE (`disable` | `require` | `verify-ca`
 * | `verify-full`) plus optional TAKOSUMI_ACCOUNTS_PG_SSL_ROOT_CERT and
 * return a `pg`-style ssl option. Defaults to `disable` for backwards
 * compatibility with the docker-compose stack where Postgres runs on the
 * same network.
 */
function parseSslConfig(
  env: Record<string, string | undefined>,
): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode =
    env.TAKOSUMI_ACCOUNTS_PG_SSL_MODE?.trim().toLowerCase() ?? "disable";
  if (mode === "" || mode === "disable" || mode === "off") return false;
  const ca = env.TAKOSUMI_ACCOUNTS_PG_SSL_ROOT_CERT?.trim();
  if (mode === "require") {
    return ca
      ? { rejectUnauthorized: false, ca }
      : { rejectUnauthorized: false };
  }
  if (mode === "verify-ca" || mode === "verify-full") {
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  }
  throw new TypeError(
    `TAKOSUMI_ACCOUNTS_PG_SSL_MODE must be one of disable|require|verify-ca|verify-full, got ${mode}`,
  );
}
