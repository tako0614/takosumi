import assert from "node:assert/strict";
import {
  InMemoryMigrationLedgerStore,
  InMemoryResourceBindingStore,
  InMemoryResourceInstanceStore,
  type MigrationLedgerEntry,
  type ResourceBinding,
  type ResourceInstance,
} from "./mod.ts";

Deno.test("resources store bindings and migration ledger entries by claim and resource", async () => {
  const instances = new InMemoryResourceInstanceStore();
  const bindings = new InMemoryResourceBindingStore();
  const ledger = new InMemoryMigrationLedgerStore();

  const instance: ResourceInstance = {
    id: "resource_db",
    spaceId: "space_a",
    groupId: "group_a",
    contract: "postgres.v1",
    origin: "managed",
    sharingMode: "exclusive",
    lifecycle: {
      status: "ready",
      generation: 1,
      updatedAt: "2026-04-27T00:00:00.000Z",
    },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  };
  const binding: ResourceBinding = {
    id: "binding_db",
    spaceId: "space_a",
    groupId: "group_a",
    claimAddress: "claims.db",
    instanceId: instance.id,
    role: "owner",
    createdAt: "2026-04-27T00:00:01.000Z",
    updatedAt: "2026-04-27T00:00:01.000Z",
  };
  const migration: MigrationLedgerEntry = {
    id: "migration_1",
    spaceId: "space_a",
    resourceInstanceId: instance.id,
    migrationRef: "postgres:init",
    toVersion: "1",
    status: "completed",
    checkpoints: [{
      name: "schema-created",
      recordedAt: "2026-04-27T00:00:02.000Z",
    }],
    startedAt: "2026-04-27T00:00:02.000Z",
    completedAt: "2026-04-27T00:00:03.000Z",
  };

  await instances.create(instance);
  await bindings.create(binding);
  await ledger.append(migration);

  assert.equal(
    (await bindings.findByClaim("group_a", "claims.db"))?.id,
    "binding_db",
  );
  assert.deepEqual(
    (await bindings.listByInstance(instance.id)).map((item) => item.id),
    ["binding_db"],
  );
  assert.deepEqual(
    (await ledger.listByResource(instance.id)).map((item) => item.id),
    ["migration_1"],
  );

  const duplicate = await instances.create({
    ...instance,
    lifecycle: { ...instance.lifecycle, status: "degraded", generation: 2 },
  });
  assert.equal(duplicate.lifecycle.status, "ready");
});
