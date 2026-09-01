import { expect, test } from "bun:test";

const serverPath = new URL(
  "../../../deploy/node-postgres/src/server.ts",
  import.meta.url,
);

test("node-postgres pins authorization-code lifecycle transactions to one connection", async () => {
  const source = await Bun.file(serverPath).text();
  const start = source.indexOf("function wrapPool(");
  const end = source.indexOf("function wrapServiceSqlClient(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const wrapPool = source.slice(start, end);

  expect(wrapPool).toContain("const connection = await pool.connect()");
  expect(wrapPool).toContain("await connection.query(sql, args)");
  expect(wrapPool).toContain('await connection.query("BEGIN")');
  expect(wrapPool).toContain('await connection.query("COMMIT")');
  expect(wrapPool).toContain('await connection.query("ROLLBACK")');
  expect(wrapPool).toContain("finally {");
  expect(wrapPool).toContain("connection.release()");
  expect(wrapPool.indexOf("try {")).toBeLessThan(
    wrapPool.indexOf('connection.query("BEGIN")'),
  );
  expect(wrapPool.indexOf('connection.query("ROLLBACK")')).toBeLessThan(
    wrapPool.indexOf("connection.release()"),
  );
});
