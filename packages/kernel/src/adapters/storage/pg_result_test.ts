import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { wrapPgResult } from "./pg_result.ts";

Deno.test("wrapPgResult returns empty rows for DDL (rows=undefined, rowCount=null)", () => {
  // What npm:pg returns for `CREATE TABLE`, `ALTER TABLE`, etc.
  const result = wrapPgResult({ rows: undefined, rowCount: null });
  assertEquals(result, { rows: [], rowCount: 0 });
});

Deno.test("wrapPgResult returns empty rows for BEGIN/COMMIT (no fields at all)", () => {
  const result = wrapPgResult({});
  assertEquals(result, { rows: [], rowCount: 0 });
});

Deno.test("wrapPgResult preserves rows for SELECT", () => {
  const result = wrapPgResult<{ id: number }>({
    rows: [{ id: 1 }, { id: 2 }],
    rowCount: 2,
  });
  assertEquals(result.rows, [{ id: 1 }, { id: 2 }]);
  assertEquals(result.rowCount, 2);
});

Deno.test("wrapPgResult prefers pg's rowCount over rows.length for INSERT-without-returning", () => {
  // pg sets rowCount even when rows is empty (the INSERT applied to N rows
  // but no RETURNING clause was given).
  const result = wrapPgResult({ rows: [], rowCount: 7 });
  assertEquals(result, { rows: [], rowCount: 7 });
});

Deno.test("wrapPgResult falls back to rows.length when rowCount is null", () => {
  const result = wrapPgResult<{ x: number }>({
    rows: [{ x: 1 }, { x: 2 }, { x: 3 }],
    rowCount: null,
  });
  assertEquals(result.rowCount, 3);
});

Deno.test("wrapPgResult does not throw when both rows and rowCount are missing", () => {
  // Regression: pre-fix code threw `Cannot read properties of undefined
  // (reading 'length')` on the very first DDL during migration ledger setup,
  // silently swallowed by the caller, leaving the kernel without tables.
  const result = wrapPgResult({});
  assertEquals(result.rows, []);
  assertEquals(result.rowCount, 0);
});
