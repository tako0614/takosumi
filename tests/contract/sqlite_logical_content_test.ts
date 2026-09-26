import { expect, test } from "bun:test";

import {
  canonicalSqliteLogicalJson,
  canonicalSqliteLogicalRow,
  compareSqliteLogicalRows,
  SQLITE_LOGICAL_CONTENT_DIGEST_KIND,
  sqliteLogicalContentExcludedTables,
  sqliteLogicalRowsQuery,
} from "../../contract/sqlite-logical-content.ts";

test("SQLite logical-content v2 has one canonical JSON and exclusion contract", () => {
  expect(SQLITE_LOGICAL_CONTENT_DIGEST_KIND).toBe(
    "takosumi.sqlite-logical-content@v2",
  );
  expect(
    canonicalSqliteLogicalJson({ zebra: 1, alpha: { y: 2, x: 3 } }),
  ).toBe('{"alpha":{"x":3,"y":2},"zebra":1}');
  expect(sqliteLogicalContentExcludedTables()).toEqual([
    { table: "_cf_KV", reason: "cloudflare_internal" },
  ]);
});

test("SQLite logical-content v2 encodes storage classes and REAL binary64", () => {
  expect(
    canonicalSqliteLogicalRow(
      {
        __takosumi_logical_type_0: "null",
        __takosumi_logical_value_0: null,
        __takosumi_logical_type_1: "integer",
        __takosumi_logical_value_1: "9223372036854775807",
        __takosumi_logical_type_2: "real",
        __takosumi_logical_value_2: 0.3333333333333333,
        __takosumi_logical_type_3: "text",
        __takosumi_logical_value_3: "E99BAA",
        __takosumi_logical_type_4: "blob",
        __takosumi_logical_value_4: "00FF",
      },
      5,
    ),
  ).toBe(
    "1:N20:I922337203685477580717:R3fd55555555555557:TE99BAA5:B00FF",
  );
  expect(() =>
    canonicalSqliteLogicalRow(
      {
        __takosumi_logical_type_0: "integer",
        __takosumi_logical_value_0: "9223372036854775808",
      },
      1,
    ),
  ).toThrow("logical_row_cell_invalid:0");
});

test("SQLite logical-content v2 query is typed, deterministic, and pageable", () => {
  const query = sqliteLogicalRowsQuery("metrics", ["id", "value"], true);
  expect(query).toContain('typeof("value")');
  expect(query).toContain('when \'real\' then "value"');
  expect(query).toContain('order by "__takosumi_logical_type_0"');
  expect(query).toEndWith(" limit ? offset ?");
  expect(query).not.toContain("printf");
});

test("SQLite logical-content v2 compares rows in query order", () => {
  const integer = {
    __takosumi_logical_type_0: "integer",
    __takosumi_logical_value_0: "10",
  };
  const real = {
    __takosumi_logical_type_0: "real",
    __takosumi_logical_value_0: -1,
  };
  expect(compareSqliteLogicalRows(integer, real, 1)).toBeLessThan(0);
  expect(compareSqliteLogicalRows(real, real, 1)).toBe(0);
});
