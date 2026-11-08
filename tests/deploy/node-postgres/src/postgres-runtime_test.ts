import { expect, test } from "bun:test";
import { createPostgresPool, wrapServiceSqlClient, type PgPool } from "../../../../deploy/node-postgres/src/postgres-runtime.ts";

test("shared PG transport keeps service TLS/timeouts and opens no connection at construction", async () => {
  const pool = createPostgresPool({ databaseUrl: "postgres://fixture@127.0.0.1:1/not-connected" }, {
    TAKOSUMI_ACCOUNTS_PG_SSL_MODE: "verify-full", TAKOSUMI_ACCOUNTS_PG_SSL_ROOT_CERT: "fixture-ca",
    TAKOSUMI_ACCOUNTS_PG_POOL_MAX: "3", TAKOSUMI_ACCOUNTS_PG_CONNECT_TIMEOUT_MS: "1234",
    TAKOSUMI_ACCOUNTS_PG_IDLE_TIMEOUT_MS: "2345", TAKOSUMI_ACCOUNTS_PG_STATEMENT_TIMEOUT_MS: "3456",
  });
  try {
    const actual = pool as PgPool & { options: Record<string, unknown>; totalCount: number };
    expect(actual.totalCount).toBe(0);
    expect(actual.options.ssl).toEqual({ rejectUnauthorized: true, ca: "fixture-ca" });
    expect(actual.options.max).toBe(3);
    expect(actual.options.connectionTimeoutMillis).toBe(1234);
    expect(actual.options.idleTimeoutMillis).toBe(2345);
    expect(actual.options.statement_timeout).toBe(3456);
  } finally { await pool.end(); }
});

test("shared PG SQL adapter pins the atomic transaction connection and preserves rollback/release", async () => {
  const calls: string[] = [];
  const conn = { async query(sql: string) { calls.push(sql); return { rows: [{ value: 1 }], rowCount: 1 }; },
    release() { calls.push("release"); } };
  const pool: PgPool = { async query(sql) { calls.push(`pool:${sql}`); return { rows: [] }; },
    async connect() { calls.push("connect"); return conn; }, async end() {} };
  const client = wrapServiceSqlClient(pool);
  const value = await client.transaction(async tx => {
    expect((await tx.query("inside", [1])).rowCount).toBe(1);
    return await tx.transaction(nested => nested.query("nested"));
  });
  expect(value.rows).toEqual([{ value: 1 }]);
  expect(calls).toEqual(["connect", "begin", "inside", "nested", "commit", "release"]);
  calls.length = 0;
  await expect(client.transaction(async tx => { await tx.query("before-error"); throw Error("fixture failure"); })).rejects.toThrow("fixture failure");
  expect(calls).toEqual(["connect", "begin", "before-error", "rollback", "release"]);
  calls.length = 0;
  await expect(client.query("not-executed", { named: 1 })).rejects.toThrow("positional parameters");
  expect(calls).toEqual([]);
});
