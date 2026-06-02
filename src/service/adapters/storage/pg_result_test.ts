import { expect, test } from "bun:test";

import { wrapPgResult } from "./pg_result.ts";

test("wrapPgResult returns empty rows for DDL (rows=undefined, rowCount=null)", () => {
  // What npm:pg returns for `CREATE TABLE`, `ALTER TABLE`, etc.
  const result = wrapPgResult({ rows: undefined, rowCount: null });
  expect(result).toEqual({ rows: [], rowCount: 0 });
});

test("wrapPgResult returns empty rows for BEGIN/COMMIT (no fields at all)", () => {
  const result = wrapPgResult({});
  expect(result).toEqual({ rows: [], rowCount: 0 });
});

test("wrapPgResult preserves rows for SELECT", () => {
  const result = wrapPgResult<{ id: number }>({
    rows: [{ id: 1 }, { id: 2 }],
    rowCount: 2,
  });
  expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
  expect(result.rowCount).toEqual(2);
});

test("wrapPgResult prefers pg's rowCount over rows.length for INSERT-without-returning", () => {
  // pg sets rowCount even when rows is empty (the INSERT applied to N rows
  // but no RETURNING clause was given).
  const result = wrapPgResult({ rows: [], rowCount: 7 });
  expect(result).toEqual({ rows: [], rowCount: 7 });
});

test("wrapPgResult falls back to rows.length when rowCount is null", () => {
  const result = wrapPgResult<{ x: number }>({
    rows: [{ x: 1 }, { x: 2 }, { x: 3 }],
    rowCount: null,
  });
  expect(result.rowCount).toEqual(3);
});

test("wrapPgResult does not throw when both rows and rowCount are missing", () => {
  // Regression: pre-fix code threw `Cannot read properties of undefined
  // (reading 'length')` on the very first DDL during migration ledger setup,
  // silently swallowed by the caller, leaving the service without tables.
  const result = wrapPgResult({});
  expect(result.rows).toEqual([]);
  expect(result.rowCount).toEqual(0);
});
