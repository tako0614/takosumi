import { afterEach, expect, test } from "bun:test";
import { D1AppOwnershipStore, SqlAppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { appBillingOwnership } from "../../../../core/domains/deploy-control/billing_workspace_compat.ts";
import type { UsageEvent } from "takosumi-contract/billing";
import type { SqlClient, SqlParameters } from "../../../../core/adapters/storage/sql.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { listPayerUsage } from "../../../../core/domains/deploy-control/usage_service.ts";
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
  await exercisePayerPagination(store);

  const legacyDb = new SqliteFakeD1();
  const legacyStore = new CloudflareD1OpenTofuControlStore(legacyDb);
  await legacyStore.listUsageEvents("schema_bootstrap");
  await legacyDb.exec("alter table usage_events drop column payer_account_id");
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
  await exercisePayerPagination(store);

  const legacyClient = await PGliteSqlClient.createThroughMigrationVersion(122);
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

test("PostgreSQL payer history decodes pg-style numeric strings including unrated zero", async () => {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const writer = new SqlOpenTofuControlStore({ client });
  await writer.putUsageEvent({ ...usage("unrated", "account_a"), quantity: 1.25, usdMicros: 0, ratingStatus: "unrated" });
  await writer.putUsageEvent(usage("rated", "account_a"));
  let stringRows = 0;
  const pgStyleClient: SqlClient = {
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: SqlParameters) {
      const result = await client.query<Row>(sql, parameters);
      if (!sql.includes('usd_micros as "usdMicros"')) return result;
      // node-postgres returns int8/numeric text on raw queries. PGlite alone
      // returns numbers and would hide a string-zero validation failure.
      return {
        ...result,
        rows: result.rows.map((row) => {
          stringRows++;
          return { ...row, usdMicros: String(row.usdMicros), quantity: String(row.quantity) } as Row;
        }),
      };
    },
    transaction: (fn) => client.transaction(fn),
  };
  const history = await listPayerUsage(new SqlOpenTofuControlStore({ client: pgStyleClient }), "account_a");
  expect(stringRows).toBe(2);
  expect(history.usageEvents.find((row) => row.id === "unrated")).toMatchObject({
    payerAccountId: "account_a", quantity: 1.25, usdMicros: 0, ratingStatus: "unrated",
  });
  expect(history.usageEvents.find((row) => row.id === "rated")).toMatchObject({ quantity: 1, usdMicros: 3 });
});

for (const backend of ["D1", "PostgreSQL"] as const) {
  test(`${backend} billing reads canonical owner and epoch after a real ownership transfer`, async () => {
    const db = new SqliteFakeD1();
    const client = backend === "PostgreSQL" ? await PGliteSqlClient.create() : undefined;
    if (client) pgClients.push(client);
    const store = client
      ? new SqlOpenTofuControlStore({ client })
      : new CloudflareD1OpenTofuControlStore(db);
    const ownership = client ? new SqlAppOwnershipStore(client, store) : new D1AppOwnershipStore(db, store);
    const { capsule } = await seedCapsuleModel(store);
    expect(await ownership.initializeOwnershipIfMissing({
      capsuleId: capsule.id, ownerAccountId: "user_test", ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsule.id}`,
    })).toBe(true);
    expect(await appBillingOwnership(store, capsule.id)).toEqual({
      identity: { capsuleId: capsule.id, payerAccountId: "user_test" }, ownershipEpoch: 0,
    });
    const previous = (await ownership.getOwnership(capsule.id))!;
    expect(await ownership.putOwnership({ ...previous, ownerAccountId: "recipient", ownershipEpoch: 1 }, 0)).toBe(true);
    // Canonical ownership writes deliberately do not rewrite Capsule JSON.
    expect((await store.getCapsule(capsule.id))?.ownerAccountId).not.toBe("recipient");
    expect(await appBillingOwnership(store, capsule.id)).toEqual({
      identity: { capsuleId: capsule.id, payerAccountId: "recipient" }, ownershipEpoch: 1,
    });
    for (const invalidOwner of [null, ""]) {
      if (client) {
        await client.query("update takosumi_capsules set owner_account_id=$2 where id=$1", [capsule.id, invalidOwner]);
      } else {
        await db.prepare("update capsules set owner_account_id=? where id=?").bind(invalidOwner, capsule.id).run();
      }
      await expect(appBillingOwnership(store, capsule.id)).rejects.toThrow("App billing owner is unavailable");
    }
  });
}

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
  const { capsule } = await seedCapsuleModel(store);
  const unattributed = await store.putUsageEvent({
    ...usage("unattributed"), workspaceId: capsule.workspaceId, capsuleId: capsule.id,
  });
  expect(unattributed).not.toHaveProperty("payerAccountId");
  expect(await store.listUsageEventsForPayerPage("user_test", {})).toEqual({ items: [] });
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
