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
} from "../../../worker/src/bindings.ts";

/**
 * Cloudflare D1 enforces hard per-query limits that the in-process `bun:sqlite`
 * engine (like libsql / better-sqlite3) does NOT, so a query that exceeds them
 * passes tests but fails at runtime with a `D1_ERROR` 500. These guards
 * reproduce the two limits we have actually hit in production so violations fail
 * loudly in tests instead of leaking to prod.
 *
 * 1. At most 100 bound parameters per statement. Real D1 throws
 *    "D1_ERROR: too many SQL variables". A Drizzle/SQL `IN (...)` over an
 *    unbounded id list is the usual offender; it must be chunked (<=~90).
 * 2. A LIKE pattern-complexity ceiling. SQLite rejects overly complex patterns
 *    with "LIKE or GLOB pattern too complex"; D1's effective ceiling is far
 *    lower than bun:sqlite's, and a value-derived `%<long needle>%` pattern is
 *    the realistic trigger (use `instr()` for literal substring search instead).
 *    We approximate the limit with the project's documented heuristic —
 *    pattern length x wildcard (`%`/`_`) count — and reject above ~7500. A
 *    string with no wildcards has complexity 0, so plain params never trip.
 */
const D1_MAX_BOUND_PARAMS = 100;
const D1_MAX_LIKE_COMPLEXITY = 7500;

export class SqliteFakeD1 implements D1Database {
  readonly #db = new Database(":memory:");

  prepare(query: string): D1PreparedStatement {
    return new SqliteFakeStatement(this.#db, query);
  }

  /**
   * Atomic multi-statement batch, mirroring D1's `batch()`. Runs every statement
   * inside ONE SQLite transaction (BEGIN / COMMIT, ROLLBACK on any error) so the
   * store's atomic `commitRunState` path gets real all-or-nothing
   * semantics under test.
   */
  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.#db.run("BEGIN");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push((await statement.run<T>()) as D1Result<T>);
      }
      this.#db.run("COMMIT");
      return results;
    } catch (error) {
      this.#db.run("ROLLBACK");
      throw error;
    }
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
    this.#enforceD1Limits();
    return this.#bound.map((value) =>
      value === undefined ? null : value
    ) as SQLQueryBindings[];
  }

  // Reproduce the D1-only hard limits that bun:sqlite silently tolerates so a
  // query that would 500 on production D1 fails the test instead. Runs on the
  // single execution chokepoint (every first/all/run/raw path calls #params()).
  #enforceD1Limits(): void {
    // (1) Cloudflare D1: at most 100 bound parameters per statement.
    if (this.#bound.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(
        `D1_ERROR: too many SQL variables: statement bound ${this.#bound.length} ` +
          `parameters but D1 allows at most ${D1_MAX_BOUND_PARAMS} per query ` +
          `(chunk the IN (...) / id list)`,
      );
    }
    // (2) Cloudflare D1: LIKE pattern-complexity ceiling. Value-derived patterns
    // arrive as bound params; a literal pattern lives in the SQL text. Check
    // both. Complexity = length x wildcard count, so plain (wildcard-free)
    // strings score 0 and never trip; only an actual %...% / _..._ pattern can.
    if (/\bLIKE\b/i.test(this.query)) {
      const patterns: string[] = [];
      for (const value of this.#bound) {
        if (typeof value === "string") patterns.push(value);
      }
      for (const match of this.query.matchAll(/\bLIKE\s+'((?:[^']|'')*)'/gi)) {
        patterns.push(match[1] ?? "");
      }
      for (const pattern of patterns) {
        const wildcards = (pattern.match(/[%_]/g) ?? []).length;
        const complexity = pattern.length * wildcards;
        if (complexity > D1_MAX_LIKE_COMPLEXITY) {
          throw new Error(
            `D1_ERROR: LIKE or GLOB pattern too complex: pattern length ` +
              `${pattern.length} x ${wildcards} wildcards = ${complexity} ` +
              `exceeds the D1 cap of ${D1_MAX_LIKE_COMPLEXITY} ` +
              `(use instr() for literal substring search)`,
          );
        }
      }
    }
  }
}
