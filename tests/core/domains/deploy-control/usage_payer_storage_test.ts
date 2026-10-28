import { afterEach, expect, test } from "bun:test";
import type { UsageEvent } from "takosumi-contract/billing";
import type { SqlClient, SqlParameters } from "../../../../core/adapters/storage/sql.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const pgClients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

function usage(
  id: string,
  payerAccountId?: string,
  createdAt = "2026-10-28T00:00:00.000Z",
): UsageEvent {
  return {
    id,
    workspaceId: `workspace_${id}`,
    capsuleId: `capsule_${id}`,
    kind: "runner_minute",
    quantity: 1,
    usdMicros: 3,
    ratingStatus: "rated",
    source: "runner",
    idempotencyKey: `run_${id}:runner_minute`,
    createdAt,
    ...(payerAccountId ? { payerAccountId } : {}),
  } as UsageEvent;
}

test("in-memory payer history is isolated, keyset-paged, and keeps the idempotent winner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const winner = usage("paid-1", "account_a", "2026-10-28T00:00:03.000Z");
  await store.putUsageEvent(winner);
  await store.putUsageEvent(usage("other", "account_b", "2026-10-28T00:00:02.000Z"));
  await store.putUsageEvent(usage("paid-2", "account_a", "2026-10-28T00:00:01.000Z"));
  const replay = Object.assign(usage("replay", "account_b", winner.createdAt), {
    idempotencyKey: winner.idempotencyKey,
  }) as UsageEvent;
  expect(await store.putUsageEvent(replay)).toHaveProperty("payerAccountId", "account_a");
  const first = await store.listUsageEventsForPayerPage("account_a", { limit: 1 });
  const second = await store.listUsageEventsForPayerPage("account_a", {
    limit: 1,
    cursor: first.nextCursor,
  });
  expect(first.items.map((row) => row.id)).toEqual(["paid-1"]);
  expect(second.items.map((row) => row.id)).toEqual(["paid-2"]);
  expect(first.items[0]).toHaveProperty("payerAccountId", "account_a");
});

test("D1 v77 payer filtering and legacy schema reads", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.listUsageEvents("schema_bootstrap");
  await db.exec("alter table usage_events add column payer_account_id text");
  await exercisePayerPagination(store);

  const legacyDb = new SqliteFakeD1();
  const legacyStore = new CloudflareD1OpenTofuControlStore(legacyDb);
  expect(await legacyStore.putUsageEvent(usage("legacy", "account_a")))
    .not.toHaveProperty("payerAccountId");
  expect(await legacyStore.listUsageEventsForPayerPage("account_a", { limit: 1 }))
    .toEqual({ items: [] });
  await legacyDb.exec("alter table usage_events add column payer_account_id text");
  expect(await legacyStore.putUsageEvent(usage("upgraded", "account_a")))
    .toHaveProperty("payerAccountId", "account_a");
  expect((await legacyStore.listUsageEvents("workspace_upgraded"))[0])
    .toHaveProperty("payerAccountId", "account_a");
  expect(await legacyStore.listUsageEvents("workspace_legacy")).toHaveLength(1);
});

test("PostgreSQL v77 payer filtering and legacy schema reads", async () => {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const store = new SqlOpenTofuControlStore({ client });
  await client.query("alter table takosumi_usage_events add column payer_account_id text");
  await exercisePayerPagination(store);

  const legacyClient = await PGliteSqlClient.create();
  pgClients.push(legacyClient);
  const legacyStore = new SqlOpenTofuControlStore({ client: legacyClient });
  expect(await legacyStore.putUsageEvent(usage("legacy", "account_a")))
    .not.toHaveProperty("payerAccountId");
  expect(await legacyStore.listUsageEventsForPayerPage("account_a", { limit: 1 }))
    .toEqual({ items: [] });
  await legacyClient.query("alter table takosumi_usage_events add column payer_account_id text");
  expect(await legacyStore.putUsageEvent(usage("upgraded", "account_a")))
    .toHaveProperty("payerAccountId", "account_a");
  expect((await legacyStore.listUsageEvents("workspace_upgraded"))[0])
    .toHaveProperty("payerAccountId", "account_a");
  expect(await legacyStore.listUsageEvents("workspace_legacy")).toHaveLength(1);
});

test("a transient payer-column probe failure does not poison PostgreSQL store capability", async () => {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  let failProbe = true;
  const flakyClient: SqlClient = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: SqlParameters,
    ) {
      if (failProbe && sql.includes("information_schema.columns")) {
        failProbe = false;
        throw new Error("temporary schema catalog outage");
      }
      return await client.query<Row>(sql, parameters);
    },
    transaction: (fn) => client.transaction(fn),
  };
  const store = new SqlOpenTofuControlStore({ client: flakyClient });
  await expect(store.putUsageEvent(usage("retry"))).rejects.toThrow(
    "temporary schema catalog outage",
  );
  expect(await store.putUsageEvent(usage("retry"))).toHaveProperty("id", "retry");
});

async function exercisePayerPagination(store: OpenTofuControlStore) {
  const winner = usage("paid-1", "account_a", "2026-10-28T00:00:03.000Z");
  await store.putUsageEvent(winner);
  await store.putUsageEvent(usage("other", "account_b", "2026-10-28T00:00:02.000Z"));
  await store.putUsageEvent(usage("paid-2", "account_a", "2026-10-28T00:00:01.000Z"));
  const replay = Object.assign(usage("replay", "account_b", winner.createdAt), {
    idempotencyKey: winner.idempotencyKey,
  }) as UsageEvent;
  expect(await store.putUsageEvent(replay))
    .toHaveProperty("payerAccountId", "account_a");
  const first = await store.listUsageEventsForPayerPage("account_a", { limit: 1 });
  const second = await store.listUsageEventsForPayerPage("account_a", {
    limit: 1,
    cursor: first.nextCursor,
  });
  expect(first.items.map((row) => row.id)).toEqual(["paid-1"]);
  expect(second.items.map((row) => row.id)).toEqual(["paid-2"]);
  expect(first.items[0]).toHaveProperty("payerAccountId", "account_a");
}
