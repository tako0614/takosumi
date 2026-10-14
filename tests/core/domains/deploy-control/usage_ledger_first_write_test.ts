import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { UsageEvent } from "takosumi-contract/billing";
import type { SqlClient, SqlParameters } from "../../../../core/adapters/storage/sql.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);
const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function postgres() {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  return client;
}

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "usage_first",
    workspaceId: "workspace_first",
    capsuleId: "capsule_first",
    runId: "destroy_first",
    kind: "runner_minute",
    quantity: 2,
    usdMicros: 17,
    ratingStatus: "rated",
    source: "runner",
    idempotencyKey: "destroy_first:runner_minute",
    createdAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

// Both independent controllers observe the missing key before either insert.
// Only scheduling is controlled; PostgreSQL executes the real SQL/unique index.
function concurrentMissingReads(client: SqlClient): SqlClient {
  let readers = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  return {
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: SqlParameters) {
      const result = await client.query<Row>(sql, parameters);
      if (/^select\b/i.test(sql) && sql.includes('"takosumi_usage_events"') && result.rows.length === 0 && readers < 2) {
        readers += 1;
        if (readers === 2) release();
        await barrier;
      }
      return result;
    },
    transaction: (fn) => client.transaction(fn),
  };
}

for (const sameId of [false, true]) {
  test(`PostgreSQL competing recovery writers preserve and return one entire winner (same ID: ${sameId})`, async () => {
    const client = concurrentMissingReads(await postgres());
    const first = new SqlOpenTofuControlStore({ client });
    const second = new SqlOpenTofuControlStore({ client });
    const proposals = [event(), event({
      id: sameId ? "usage_first" : "usage_second",
      workspaceId: "workspace_second",
      capsuleId: "capsule_second",
      runId: "destroy_second",
      quantity: 91,
      usdMicros: 901,
      resourceFamily: "test-resource",
      resourceId: "resource_second",
      resourceMetadata: { label: "second" },
      createdAt: "2026-10-14T00:00:01.000Z",
    })];
    const results = await Promise.all([
      first.putUsageEvent(proposals[0]!), second.putUsageEvent(proposals[1]!),
    ]);
    const rows = [
      ...await first.listUsageEvents("workspace_first"),
      ...await first.listUsageEvents("workspace_second"),
    ];
    expect(rows).toHaveLength(1);
    expect(proposals).toContainEqual(rows[0]);
    expect(results).toEqual([rows[0], rows[0]]);
    // Reconstruct the controller and replay a different rating/identity.
    const restarted = new SqlOpenTofuControlStore({ client });
    expect(await restarted.putUsageEvent(event({ quantity: 777, usdMicros: 888 }))).toEqual(rows[0]);
    expect(await restarted.getCapsuleUsageTotals(rows[0]!.capsuleId!)).toEqual({
      usdMicros: rows[0]!.usdMicros, eventCount: 1, ratedEventCount: 1,
    });
  });
}

test("committed usage replay and independent keys retain storage parity", async () => {
  const stores = [
    new InMemoryOpenTofuControlStore(),
    new SqlOpenTofuControlStore({ client: await postgres() }),
    new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()),
  ];
  for (const store of stores) {
    const winner = await store.putUsageEvent(event());
    expect(await store.putUsageEvent(event({ id: "replay", quantity: 9, usdMicros: 700 }))).toEqual(winner);
    const independent = event({ id: "independent", idempotencyKey: "another_run:runner_minute" });
    expect(await store.putUsageEvent(independent)).toEqual(independent);
    expect(await store.listUsageEvents("workspace_first")).toHaveLength(2);
  }
});

test("PostgreSQL primary-key collision cannot masquerade as an idempotent settlement", async () => {
  const store = new SqlOpenTofuControlStore({ client: await postgres() });
  await store.putUsageEvent(event());
  await expect(store.putUsageEvent(event({ idempotencyKey: "different-key" }))).rejects.toThrow();
  expect(await store.listUsageEvents("workspace_first")).toEqual([event()]);
});

test("PostgreSQL insert failure preserves prior usage and remains retryable", async () => {
  const client = await postgres();
  let failInsert = true;
  const outage = new Error("test insert outage");
  const failing: SqlClient = {
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: SqlParameters) {
      if (failInsert && /^insert into "takosumi_usage_events"/i.test(sql)) throw outage;
      return await client.query<Row>(sql, parameters);
    },
    transaction: (fn) => client.transaction(fn),
  };
  const store = new SqlOpenTofuControlStore({ client: failing });
  await expect(store.putUsageEvent(event())).rejects.toHaveProperty("cause", outage);
  expect(await store.listUsageEvents("workspace_first")).toEqual([]);
  failInsert = false;
  expect(await store.putUsageEvent(event())).toEqual(event());
});

test("PostgreSQL committed usage survives lost winner readback and a fresh recovery caller", async () => {
  const client = await postgres();
  const outage = new Error("test winner readback outage");
  let inserted = false;
  const failing: SqlClient = {
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: SqlParameters) {
      if (inserted && /^select\b/i.test(sql) && sql.includes('"takosumi_usage_events"')) throw outage;
      const result = await client.query<Row>(sql, parameters);
      if (/^insert into "takosumi_usage_events"/i.test(sql)) inserted = true;
      return result;
    },
    transaction: (fn) => client.transaction(fn),
  };
  await expect(new SqlOpenTofuControlStore({ client: failing }).putUsageEvent(event()))
    .rejects.toHaveProperty("cause", outage);
  const restarted = new SqlOpenTofuControlStore({ client });
  expect(await restarted.putUsageEvent(event({ id: "recovered", quantity: 99, usdMicros: 900 })))
    .toEqual(event());
  expect(await restarted.listUsageEvents("workspace_first")).toEqual([event()]);
});
