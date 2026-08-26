import { expect, test } from "bun:test";

import {
  CloudflareD1RestTransport,
  D1RestTransportError,
} from "../../../deploy/cloudflare/d1-rest-transport.ts";

test("neutral D1 REST transport preserves ordered parameterized query and atomic batch payloads", async () => {
  const requests: unknown[] = [];
  const database = new CloudflareD1RestTransport({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "must-not-appear",
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      const body = requests.at(-1) as { readonly batch?: readonly unknown[] };
      return Response.json({
        success: true,
        result: (body.batch ?? [null]).map(() => ({ success: true, results: [] })),
      });
    },
  });

  await database.prepare("select ?").bind("ready").all();
  await database.batch([
    database.prepare("insert into demo values (?)").bind("one"),
    database.prepare("insert into demo values (?)").bind("two"),
  ]);

  expect(requests).toEqual([
    { sql: "select ?", params: ["ready"] },
    {
      batch: [
        { sql: "insert into demo values (?)", params: ["one"] },
        { sql: "insert into demo values (?)", params: ["two"] },
      ],
    },
  ]);
  expect(JSON.stringify(requests)).not.toContain("must-not-appear");
});

test("neutral D1 REST transport exposes fixed secret-safe failures", async () => {
  const database = new CloudflareD1RestTransport({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "must-not-appear",
    fetch: async () =>
      Response.json(
        { success: false, errors: [{ message: "must-not-appear remote row" }] },
        { status: 500 },
      ),
  });

  let failure: unknown;
  try {
    await database.prepare("select 1").all();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(D1RestTransportError);
  expect(String(failure)).toBe("D1RestTransportError: cloudflare_d1_query_failed");
  expect(String(failure)).not.toContain("must-not-appear");
  expect(String(failure)).not.toContain("remote row");
});

test("neutral D1 REST transport rejects malformed successful query envelopes", async () => {
  const invalidEnvelopes: readonly unknown[] = [
    { success: true },
    { success: true, result: null },
    { success: true, result: [] },
    { success: true, result: [{}] },
    { success: true, result: [{ success: true }] },
    { success: true, result: [{ success: false, results: [] }] },
    { success: true, result: [{ success: true, results: null }] },
    {
      success: true,
      result: [
        { success: true, results: [] },
        { success: true, results: [] },
      ],
    },
  ];

  for (const envelope of invalidEnvelopes) {
    const database = new CloudflareD1RestTransport({
      accountId: "account_123",
      databaseId: "database_456",
      apiToken: "must-not-appear",
      fetch: async () => Response.json(envelope),
    });
    await expect(database.prepare("select 1").all()).rejects.toThrow(
      /^cloudflare_d1_(?:query_failed|response_invalid)$/u,
    );
  }
});

test("neutral D1 REST transport preserves a valid SELECT with zero rows", async () => {
  const database = new CloudflareD1RestTransport({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "must-not-appear",
    fetch: async () =>
      Response.json({
        success: true,
        result: [{ success: true, results: [] }],
      }),
  });

  await expect(database.prepare("select 1 where 0").all()).resolves.toEqual({
    success: true,
    results: [],
  });
});

test("neutral D1 REST transport requires one result per batched statement", async () => {
  const database = new CloudflareD1RestTransport({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "must-not-appear",
    fetch: async () =>
      Response.json({
        success: true,
        result: [{ success: true, results: [] }],
      }),
  });

  await expect(
    database.batch([
      database.prepare("insert into demo values (1)"),
      database.prepare("insert into demo values (2)"),
    ]),
  ).rejects.toThrow("cloudflare_d1_response_invalid");
});

test("neutral D1 REST transport reads the current Time Travel bookmark without a write", async () => {
  const requests: Array<{ readonly url: string; readonly method?: string }> = [];
  const database = new CloudflareD1RestTransport({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "must-not-appear",
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return Response.json({
        success: true,
        result: { bookmark: "opaque-bookmark-private" },
      });
    },
  });

  await expect(database.readTimeTravelBookmark()).resolves.toBe(
    "opaque-bookmark-private",
  );
  expect(requests).toEqual([
    {
      url: "https://api.cloudflare.com/client/v4/accounts/account_123/d1/database/database_456/time_travel/bookmark",
      method: "GET",
    },
  ]);
});
