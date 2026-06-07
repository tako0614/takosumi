/**
 * Test-only {@link D1Database} backed by `bun:sqlite`.
 *
 * The D1 OpenTofu store issues real §27 SQL (per-entity tables, parameterized
 * statements, `on conflict ... do update`). Rather than re-implement that SQL in
 * a hand-rolled fake, this adapter runs the statements against an in-memory
 * SQLite database so the store's actual DDL and queries are exercised. It only
 * implements the narrow `prepare(...).bind(...).first()/all()/run()` surface the
 * store uses.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";

import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";

export class SqliteFakeD1 implements D1Database {
  readonly #db = new Database(":memory:");

  prepare(query: string): D1PreparedStatement {
    return new SqliteFakeStatement(this.#db, query);
  }
}

class SqliteFakeStatement implements D1PreparedStatement {
  #bound: readonly unknown[] = [];

  constructor(
    private readonly db: Database,
    private readonly query: string,
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    this.#bound = values;
    return this;
  }

  first<T = unknown>(): Promise<T | null> {
    const row = this.db.query(this.query).get(...this.#params()) as
      | T
      | null
      | undefined;
    return Promise.resolve(row ?? null);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.db.query(this.query).all(...this.#params()) as T[];
    return Promise.resolve({ results: rows, success: true });
  }

  raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.db
      .query(this.query)
      .values(...this.#params()) as T[];
    return Promise.resolve(rows);
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.db.run(this.query, this.#params());
    return Promise.resolve({
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
      },
    });
  }

  // bun:sqlite binds undefined poorly; normalize to null so optional columns
  // round-trip as SQL NULL exactly like the real D1 binder does. The cast is
  // safe: the store only ever binds string | number | null.
  #params(): SQLQueryBindings[] {
    return this.#bound.map((value) =>
      value === undefined ? null : value
    ) as SQLQueryBindings[];
  }
}
