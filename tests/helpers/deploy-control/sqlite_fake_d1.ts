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
 * 2. A 50-byte LIKE/GLOB pattern ceiling. D1 measures UTF-8 bytes, not
 *    JavaScript string length, and the complete concatenated pattern is subject
 *    to the cap. Only operands of LIKE/GLOB count: unrelated string bindings,
 *    quoted identifiers named LIKE/GLOB, and comments must not be rejected.
 *
 * Both constants are exported so the root `scripts/check-d1-safety.mjs` gate can
 * discover this file as an enforcing harness and compare its predicate — with
 * bare `const` it was invisible to the gate and drifted unobserved.
 */
export const D1_MAX_BOUND_PARAMS = 100;
export const D1_MAX_LIKE_COMPLEXITY = 50;

const TRANSACTION_CONTROL = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "SAVEPOINT",
  "ROLLBACK",
  "RELEASE",
]);
const UTF8_ENCODER = new TextEncoder();

export class SqliteFakeD1 implements D1Database {
  readonly #db: Database;

  constructor() {
    this.#db = new Database(":memory:");
    // D1 always enforces foreign keys. bun:sqlite defaults them to OFF.
    this.#db.exec("PRAGMA foreign_keys = ON");
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteFakeStatement(this.#db, query);
  }

  /** Accounts D1 bootstrap uses the native multi-statement exec surface. */
  exec(
    query: string,
  ): Promise<{ readonly count: number; readonly duration: number }> {
    enforceD1Statement(query);
    this.#db.exec(query);
    return Promise.resolve({
      count: query.split(";").filter((part) => part.trim().length > 0).length,
      duration: 0,
    });
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
        results.push(
          statement instanceof SqliteFakeStatement
            ? await statement.runInBatch<T>()
            : ((await statement.run<T>()) as D1Result<T>),
        );
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
  constructor(
    private readonly db: Database,
    private readonly query: string,
    private readonly bound: readonly unknown[] = [],
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    assertD1BoundValues(values);
    return new SqliteFakeStatement(this.db, this.query, [...values]);
  }

  first<T = unknown>(): Promise<T | null> {
    const row = this.db.query(this.query).get(...this.#params()) as
      T | null | undefined;
    return Promise.resolve(row ?? null);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.db.query(this.query).all(...this.#params()) as T[];
    return Promise.resolve({ results: rows, success: true });
  }

  raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.db.query(this.query).values(...this.#params()) as T[];
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

  /**
   * D1 `batch()` returns `results` for read statements. Calling `run()` for
   * every statement (the old fake behavior) silently discarded SELECT rows and
   * made production-valid read batches impossible to exercise locally.
   */
  runInBatch<T = unknown>(): Promise<D1Result<T>> {
    if (/^(?:select|pragma)\b/iu.test(this.query.trim())) {
      return this.all<T>();
    }
    return this.run<T>();
  }

  // The cast is safe after the D1 validation: callers bind the scalar values
  // accepted by D1 and undefined is rejected rather than normalized to NULL.
  #params(): SQLQueryBindings[] {
    enforceD1Statement(this.query, this.bound);
    return this.bound as SQLQueryBindings[];
  }
}

function assertD1BoundValues(values: readonly unknown[]): void {
  if (values.some((value) => value === undefined)) {
    throw new TypeError(
      "D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'",
    );
  }
}

function enforceD1Statement(
  query: string,
  bound: readonly unknown[] = [],
): void {
  if (bound.length > D1_MAX_BOUND_PARAMS) {
    throw new Error(
      `D1_ERROR: too many SQL variables: statement bound ${bound.length} ` +
        `parameters but D1 allows at most ${D1_MAX_BOUND_PARAMS} per query ` +
        `(chunk the IN (...) / id list)`,
    );
  }
  assertD1BoundValues(bound);

  for (const statement of sqlStatements(sqlTokens(query))) {
    const first = statement[0];
    if (first?.kind === "word" && TRANSACTION_CONTROL.has(first.value)) {
      throw new Error(
        `D1_ERROR: explicit transaction control is not supported; use batch() ` +
          `for atomic writes`,
      );
    }

    if (disablesForeignKeys(statement)) {
      throw new Error(
        "D1_ERROR: PRAGMA foreign_keys = OFF is not supported; D1 always " +
          "enforces foreign keys",
      );
    }
  }

  for (const pattern of likeGlobPatterns(query, bound)) {
    const bytes = UTF8_ENCODER.encode(pattern).byteLength;
    if (bytes > D1_MAX_LIKE_COMPLEXITY) {
      throw new Error(
        `D1_ERROR: LIKE/GLOB pattern of ${bytes} bytes exceeds the D1 cap of ` +
          `${D1_MAX_LIKE_COMPLEXITY} bytes. Use instr(lower(col), lower(q)) > 0 ` +
          `for literal substring search.`,
      );
    }
  }
}

type SqlToken =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "parameter"; readonly index: number }
  | { readonly kind: "symbol"; readonly value: string };

function sqlStatements(tokens: readonly SqlToken[]): readonly SqlToken[][] {
  const statements: SqlToken[][] = [];
  let statement: SqlToken[] = [];
  let inTriggerBody = false;
  let triggerCaseDepth = 0;
  let triggerEnded = false;

  for (const token of tokens) {
    statement.push(token);

    if (
      !inTriggerBody &&
      token.kind === "word" &&
      token.value === "BEGIN" &&
      isCreateTriggerStatement(statement)
    ) {
      inTriggerBody = true;
      continue;
    }

    if (inTriggerBody && token.kind === "word") {
      if (token.value === "CASE") {
        triggerCaseDepth += 1;
      } else if (token.value === "END" && triggerCaseDepth > 0) {
        triggerCaseDepth -= 1;
      } else if (token.value === "END") {
        triggerEnded = true;
      }
    }

    if (token.kind === "symbol" && token.value === ";") {
      if (inTriggerBody && !triggerEnded) continue;
      statements.push(statement);
      statement = [];
      inTriggerBody = false;
      triggerCaseDepth = 0;
      triggerEnded = false;
    }
  }

  if (statement.length > 0) statements.push(statement);
  return statements;
}

function isCreateTriggerStatement(tokens: readonly SqlToken[]): boolean {
  const words = tokens
    .filter(
      (token): token is Extract<SqlToken, { readonly kind: "word" }> =>
        token.kind === "word",
    )
    .map((token) => token.value);
  return (
    words[0] === "CREATE" &&
    (words[1] === "TRIGGER" ||
      ((words[1] === "TEMP" || words[1] === "TEMPORARY") &&
        words[2] === "TRIGGER"))
  );
}

function disablesForeignKeys(tokens: readonly SqlToken[]): boolean {
  if (
    tokens[0]?.kind !== "word" ||
    tokens[0].value !== "PRAGMA" ||
    tokens[1]?.kind !== "word" ||
    tokens[1].value !== "FOREIGN_KEYS"
  ) {
    return false;
  }

  const value = tokens.find(
    (token, index) =>
      index > 1 &&
      (token.kind === "word" ||
        token.kind === "string" ||
        (token.kind === "symbol" && token.value === "0")),
  );
  return (
    value !== undefined &&
    (((value.kind === "word" || value.kind === "string") &&
      (value.value === "OFF" || value.value === "FALSE")) ||
      (value.kind === "symbol" && value.value === "0"))
  );
}

function likeGlobPatterns(
  query: string,
  bound: readonly unknown[],
): readonly string[] {
  const tokens = sqlTokens(query);
  const patterns: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const operator = tokens[index];
    if (
      operator?.kind !== "word" ||
      (operator.value !== "LIKE" && operator.value !== "GLOB")
    ) {
      continue;
    }
    const pattern = patternExpression(tokens, index + 1, bound);
    if (pattern !== undefined) patterns.push(pattern);
  }
  return patterns;
}

function patternExpression(
  tokens: readonly SqlToken[],
  start: number,
  bound: readonly unknown[],
): string | undefined {
  const first = patternAtom(tokens[start], bound);
  if (first === undefined) return undefined;
  let value = first;
  let index = start + 1;
  while (tokens[index]?.kind === "symbol" && tokens[index].value === "||") {
    const next = patternAtom(tokens[index + 1], bound);
    if (next === undefined) break;
    value += next;
    index += 2;
  }
  return value;
}

function patternAtom(
  token: SqlToken | undefined,
  bound: readonly unknown[],
): string | undefined {
  if (token?.kind === "string") return token.value;
  if (token?.kind !== "parameter") return undefined;
  const value = bound[token.index];
  return typeof value === "string" ? value : undefined;
}

function sqlTokens(query: string): readonly SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  let largestParameter = 0;
  while (index < query.length) {
    const character = query[index]!;
    const next = query[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      index = skipLineComment(query, index + 2);
      continue;
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(query, index + 2);
      continue;
    }
    if (character === "'") {
      const literal = readQuoted(query, index, "'", true);
      tokens.push({ kind: "string", value: literal.value });
      index = literal.next;
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      index = readQuoted(
        query,
        index,
        character === "[" ? "]" : character,
        character !== "[",
      ).next;
      continue;
    }
    if (character === "?") {
      const match = /^\?([0-9]*)/u.exec(query.slice(index))!;
      const explicit = match[1] ? Number(match[1]) : undefined;
      const parameter = explicit ?? largestParameter + 1;
      largestParameter = Math.max(largestParameter, parameter);
      tokens.push({ kind: "parameter", index: parameter - 1 });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(query.slice(index))!;
      tokens.push({ kind: "word", value: match[0].toUpperCase() });
      index += match[0].length;
      continue;
    }
    if (character === "|" && next === "|") {
      tokens.push({ kind: "symbol", value: "||" });
      index += 2;
      continue;
    }
    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }
  return tokens;
}

function readQuoted(
  text: string,
  start: number,
  end: string,
  doubledEscape: boolean,
): { readonly value: string; readonly next: number } {
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const character = text[index]!;
    if (character === end && doubledEscape && text[index + 1] === end) {
      value += end;
      index += 2;
      continue;
    }
    if (character === end) return { value, next: index + 1 };
    value += character;
    index += 1;
  }
  return { value, next: index };
}

function skipLineComment(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline < 0 ? text.length : newline + 1;
}

function skipBlockComment(text: string, start: number): number {
  const close = text.indexOf("*/", start);
  return close < 0 ? text.length : close + 2;
}
