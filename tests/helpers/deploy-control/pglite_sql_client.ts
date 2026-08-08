/**
 * Test-only {@link SqlClient} backed by an in-process PGlite (WASM Postgres).
 *
 * The {@link SqlOpenTofuControlStore} drives a real Postgres dialect through
 * the drizzle pg-proxy: positional `$N` parameters and jsonb / bigint columns.
 * Running those statements against PGlite exercises the store's actual SQL and
 * the canonical migration DDL — a far stronger guarantee than a hand-rolled
 * in-memory fake — without needing a live Postgres server.
 *
 * `transaction` opens a real PGlite transaction (BEGIN / COMMIT, ROLLBACK on
 * throw) so the atomic `commitRunState` path gets genuine all-or-
 * nothing semantics under test.
 */
import {
  PGlite,
  type Transaction as PGliteTransaction,
} from "@electric-sql/pglite";

import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../../core/adapters/storage/sql.ts";
import { postgresStorageMigrationStatements } from "../../../core/adapters/storage/migrations.ts";

type PGliteQueryRunner = Pick<PGlite, "query"> | PGliteTransaction;

/** Splits a multi-statement migration body on SQL `;` boundaries. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let dollarTag: string | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (singleQuoted) {
      if (char === "'" && sql[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      if (char === '"' && sql[index + 1] === '"') {
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = undefined;
      }
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      continue;
    }
    if (char === '"') {
      doubleQuoted = true;
      continue;
    }
    if (char === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length - 1;
      }
      continue;
    }
    if (char === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement.length > 0) statements.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

function toParamArray(parameters?: SqlParameters): unknown[] | undefined {
  if (parameters === undefined) return undefined;
  if (Array.isArray(parameters)) return [...parameters] as unknown[];
  // The store only ever emits positional ($N) params through drizzle pg-proxy;
  // a named-param map would be a bug, so surface it loudly rather than silently
  // dropping bindings.
  throw new TypeError("PGlite SqlClient adapter expects positional parameters");
}

async function runQuery<Row extends Record<string, unknown>>(
  runner: PGliteQueryRunner,
  sql: string,
  parameters?: SqlParameters,
): Promise<SqlQueryResult<Row>> {
  const params = toParamArray(parameters);
  const result = await runner.query<Row>(sql, params);
  return {
    rows: result.rows,
    rowCount: result.affectedRows ?? result.rows.length,
  };
}

export class PGliteSqlClient implements SqlClient {
  static #latestMigrationSnapshot: Promise<Blob> | undefined;

  readonly #db: PGlite;

  private constructor(db: PGlite) {
    this.#db = db;
  }

  /**
   * Loads an isolated database from the canonical, fully migrated snapshot.
   * The snapshot is built once per test process; every caller gets its own
   * PGlite filesystem, so writes cannot leak across tests.
   */
  static async create(): Promise<PGliteSqlClient> {
    const snapshot = await PGliteSqlClient.latestMigrationSnapshot();
    const db = await PGlite.create({ loadDataDir: snapshot });
    return new PGliteSqlClient(db);
  }

  /**
   * Provisions a historical catalog boundary so upgrade tests can populate the
   * previous public schema before applying the next migration.
   */
  static async createThroughMigrationVersion(
    maximumVersion: number,
  ): Promise<PGliteSqlClient> {
    return await PGliteSqlClient.createFreshThroughMigrationVersion(
      maximumVersion,
    );
  }

  private static async createFreshThroughMigrationVersion(
    maximumVersion: number,
  ): Promise<PGliteSqlClient> {
    const db = new PGlite();
    try {
      for (const migration of postgresStorageMigrationStatements.filter(
        (entry) => entry.version <= maximumVersion,
      )) {
        for (const statement of splitSqlStatements(migration.sql)) {
          try {
            await db.exec(statement);
          } catch (error) {
            throw new Error(
              `PGlite migration ${migration.id} failed on statement: ` +
                `${statement.slice(0, 120)} — ${(error as Error).message}`,
            );
          }
        }
      }
      return new PGliteSqlClient(db);
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  /**
   * Builds the latest migration snapshot once per test process. The source
   * client is closed as soon as the immutable data archive is ready; each
   * caller receives a fresh PGlite database loaded from that archive.
   */
  private static async latestMigrationSnapshot(): Promise<Blob> {
    const existing = PGliteSqlClient.#latestMigrationSnapshot;
    if (existing) return await existing;

    const snapshotPromise = PGliteSqlClient.createMigrationSnapshot();
    PGliteSqlClient.#latestMigrationSnapshot = snapshotPromise;
    try {
      return await snapshotPromise;
    } catch (error) {
      if (PGliteSqlClient.#latestMigrationSnapshot === snapshotPromise) {
        PGliteSqlClient.#latestMigrationSnapshot = undefined;
      }
      throw error;
    }
  }

  private static async createMigrationSnapshot(): Promise<Blob> {
    const client = await PGliteSqlClient.createFreshThroughMigrationVersion(
      Number.POSITIVE_INFINITY,
    );
    try {
      return await client.#db.dumpDataDir("none");
    } finally {
      await client.close();
    }
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return runQuery<Row>(this.#db, sql, parameters);
  }

  async transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    const result = await this.#db.transaction(async (tx) => {
      const handle: SqlTransaction = {
        query: (sql, parameters) => runQuery(tx, sql, parameters),
        // The pinned tx is itself a SqlTransaction; the store never nests, so a
        // nested transaction runs the body flat against the same tx.
        transaction: (nested) => Promise.resolve(nested(handle)),
      };
      return await fn(handle);
    });
    return result as T;
  }

  /** Direct DDL/DML escape hatch for introspection assertions. */
  exec(sql: string): Promise<unknown> {
    return this.#db.exec(sql);
  }

  rawQuery<Row extends Record<string, unknown>>(
    sql: string,
  ): Promise<{ readonly rows: readonly Row[] }> {
    return this.#db.query<Row>(sql);
  }

  get closed(): boolean {
    return this.#db.closed;
  }

  close(): Promise<void> {
    return this.#db.close();
  }
}
