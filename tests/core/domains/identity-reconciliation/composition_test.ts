import { expect, test } from "bun:test";
import type { InterfaceBinding } from "takosumi-contract/interfaces";
import type { ControlIdentityAuthorityReader } from "../../../../contract/identity-reconciliation.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/stores.ts";
import { createSqlInterfaceStores } from "../../../../core/domains/interfaces/sql_stores.ts";
import { createD1InterfaceStores } from "../../../../core/domains/interfaces/d1_stores.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const authority: ControlIdentityAuthorityReader = {
  async readMergeAdmission() { return undefined; },
  async readUnlinkAdmission() { return undefined; },
  async readRecoveryAdmission() { return undefined; },
};
const runtimeEnv = { TAKOSUMI_DEV_MODE: "1" };

test("ordinary Core composition leaves identity reconciliation absent and reads no custody inventory", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let inventories = 0;
  store.captureIdentityReconciliationInventory = async () => { inventories++; throw new Error("Private feature is absent"); };
  const created = await createTakosumiService({ runtimeEnv, opentofuControlStore: store });
  expect(created.operations.identityReconciliation).toBeUndefined();
  expect(inventories).toBe(0);
});

test("private memory composition pairs the actual Principal store and rejects a structural substitute", async () => {
  const interfaces = createInMemoryInterfaceStores();
  const store = new InMemoryOpenTofuControlStore();
  const created = await createTakosumiService({ runtimeEnv, opentofuControlStore: store, interfaceStores: interfaces, identityReconciliationAuthority: authority });
  expect(created.operations.identityReconciliation).toBeDefined();
  expect((await store.captureIdentityReconciliationInventory(["root_a", "root_b"])).principalReferences).toEqual([]);
  const substitute = { ...interfaces, bindings: { ...interfaces.bindings, get: interfaces.bindings.get.bind(interfaces.bindings), create: interfaces.bindings.create.bind(interfaces.bindings), listByInterface: interfaces.bindings.listByInterface.bind(interfaces.bindings), compareAndSet: interfaces.bindings.compareAndSet.bind(interfaces.bindings) } };
  await expect(createTakosumiService({ runtimeEnv, opentofuControlStore: new InMemoryOpenTofuControlStore(), interfaceStores: substitute, identityReconciliationAuthority: authority })).rejects.toThrow("actual complete Principal inventory");
  expect(await store.listWorkspaceMembers("any")).toEqual([]);
});

test("private PostgreSQL composition proves the exact actual SqlClient and refuses another durable Principal database", async () => {
  const local = await PGliteSqlClient.create(), foreign = await PGliteSqlClient.create();
  try {
    const store = new SqlOpenTofuControlStore({ client: local });
    const same = createSqlInterfaceStores(local);
    const created = await createTakosumiService({ runtimeEnv, sqlClient: local, opentofuControlStore: store, interfaceStores: same, identityReconciliationAuthority: authority });
    expect(created.operations.identityReconciliation).toBeDefined();
    const external = createSqlInterfaceStores(foreign);
    const retained = {
      apiVersion: "takosumi.io/v1", kind: "InterfaceBinding",
      metadata: { id: "foreign_principal", workspaceId: "foreign_workspace", generation: 1, createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z" },
      spec: { interfaceId: "foreign_interface", subjectRef: { kind: "Principal", id: "root_b" }, permissions: [], delivery: { type: "none" } },
      status: { phase: "Revoked", conditions: [] },
    } as unknown as InterfaceBinding;
    expect(await external.bindings.create(retained)).toBe(true);
    let scans = 0, writes = 0;
    const capture = store.captureIdentityReconciliationInventory.bind(store);
    const mutate = store.commitIdentityReconciliation.bind(store);
    store.captureIdentityReconciliationInventory = async (ids) => { scans++; return await capture(ids); };
    store.commitIdentityReconciliation = async (input) => { writes++; return await mutate(input); };
    await expect(createTakosumiService({ runtimeEnv, sqlClient: local, opentofuControlStore: store, interfaceStores: external, identityReconciliationAuthority: authority })).rejects.toThrow("actual same-database Principal inventory");
    expect(scans).toBe(0);
    expect(writes).toBe(0);
    expect(await external.bindings.get(retained.metadata.id)).toEqual(retained);
    const structural = { ...same, bindings: { ...same.bindings, usesDatabase: () => true } };
    await expect(createTakosumiService({ runtimeEnv, sqlClient: local, opentofuControlStore: store, interfaceStores: structural as typeof same, identityReconciliationAuthority: authority })).rejects.toThrow("actual same-database Principal inventory");
  } finally { await local.close(); await foreign.close(); }
});

test("private D1 composition rejects another actual handle while the ordinary override stays usable", async () => {
  const local = new SqliteFakeD1(), foreign = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(local);
  await ensureD1OpenTofuLedgerSchema(foreign);
  const store = new CloudflareD1OpenTofuControlStore(local);
  const same = createD1InterfaceStores(local);
  const external = createD1InterfaceStores(foreign);
  const created = await createTakosumiService({ runtimeEnv, opentofuControlStore: store, interfaceStores: same, identityReconciliationAuthority: authority });
  expect(created.operations.identityReconciliation).toBeDefined();
  await expect(createTakosumiService({ runtimeEnv, opentofuControlStore: store, interfaceStores: external, identityReconciliationAuthority: authority })).rejects.toThrow("actual same-database Principal inventory");
  const ordinary = await createTakosumiService({ runtimeEnv, opentofuControlStore: store, interfaceStores: external });
  expect(ordinary.operations.identityReconciliation).toBeUndefined();
});
