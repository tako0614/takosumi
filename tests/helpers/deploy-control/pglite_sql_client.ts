/**
 * Test-only {@link SqlClient} backed by an in-process PGlite (WASM Postgres).
 *
 * The {@link SqlOpenTofuDeploymentStore} drives a real Postgres dialect through
 * the drizzle pg-proxy: positional `$N` parameters and jsonb / bigint columns.
 * Running those statements against PGlite exercises the store's actual SQL and
 * the canonical migration DDL — a far stronger guarantee than a hand-rolled
 * in-memory fake — without needing a live Postgres server.
 *
 * `transaction` opens a real PGlite transaction (BEGIN / COMMIT, ROLLBACK on
 * throw) so the atomic `commitAppliedDeployment` path gets genuine all-or-
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

/** Splits a multi-statement migration body on `;` boundaries. */
function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
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
  readonly #db: PGlite;

  private constructor(db: PGlite) {
    this.#db = db;
  }

  /**
   * Spins up a fresh PGlite database and provisions it with the canonical
   * Postgres migration DDL, applied statement-by-statement in catalog order
   * (the same order the migration runner uses). Each statement is additive /
   * `if not exists`, so the result is the migration end-state schema.
   *
   * The catalog must replay cleanly from an empty database. A migration failure
   * here is a product bug, not a test fixture concern.
   */
  static async create(): Promise<PGliteSqlClient> {
    const db = new PGlite();
    for (const migration of postgresStorageMigrationStatements) {
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

  close(): Promise<void> {
    return this.#db.close();
  }
}
