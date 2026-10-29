import { afterEach, expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { ProviderConnection } from "takosumi-contract/connections";
import type { UsageEvent } from "takosumi-contract/billing";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type { Workspace } from "takosumi-contract/workspaces";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../../worker/src/d1_schema_maintenance.ts";
import { D1AppOwnershipStore, InMemoryAppOwnershipStore, SqlAppOwnershipStore, type AppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-28T00:00:00.000Z";
const clients: PGliteSqlClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

async function stores(): Promise<readonly { name: string; control: OpenTofuControlStore; ownership: AppOwnershipStore }[]> {
  const memory = new InMemoryOpenTofuControlStore();
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const postgres = new SqlOpenTofuControlStore({ client: pg });
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const d1 = new CloudflareD1OpenTofuControlStore(db);
  return [
    { name: "memory", control: memory, ownership: new InMemoryAppOwnershipStore(memory) },
    { name: "postgres", control: postgres, ownership: new SqlAppOwnershipStore(pg, postgres) },
    { name: "d1", control: d1, ownership: new D1AppOwnershipStore(db, d1) },
  ];
}

function workspace(): Workspace {
  return { id: "ws_app_owner", handle: "app-owner", displayName: "App owner", type: "personal",
    ownerUserId: "legacy-owner", createdAt: NOW, updatedAt: NOW };
}
function capsule(): Capsule {
  return { id: "cap_app_owner", workspaceId: "ws_app_owner", projectId: "prj_app_owner", name: "app-owner",
    slug: "app-owner", sourceId: "src_app_owner", installConfigId: "cfg_app_owner", environment: "production",
    currentStateGeneration: 0, status: "active", createdAt: NOW, updatedAt: NOW };
}
const initial = { capsuleId: "cap_app_owner", ownerAccountId: "legacy-owner", ownershipEpoch: 0,
  managementState: "active" as const, managementEpoch: 0, storageRoot: "workspaces/ws_app_owner/capsules/cap_app_owner" };

test("app ownership and members have memory/Postgres/D1 authority parity", async () => {
  for (const { name, control, ownership } of await stores()) {
    await control.putWorkspace(workspace());
    await control.putCapsule(capsule());
    expect(await ownership.resolveAppAccess("legacy-owner", "cap_app_owner")).toMatchObject({ role: "owner" });
    expect(await ownership.initializeOwnershipIfMissing(initial)).toBe(true);
    expect(await ownership.initializeOwnershipIfMissing({ ...initial, ownerAccountId: "intruder" })).toBe(false);
    expect(await ownership.getOwnership(initial.capsuleId)).toEqual(initial);
    expect(await ownership.putMember({ capsuleId: initial.capsuleId, accountId: "member", status: "active", addedBy: "legacy-owner", createdAt: NOW, updatedAt: NOW })).toBe(true);
    expect(await ownership.putMember({ capsuleId: initial.capsuleId, accountId: "legacy-owner", status: "active", createdAt: NOW, updatedAt: NOW })).toBe(false);
    expect(await ownership.resolveAppAccess("member", initial.capsuleId)).toMatchObject({ role: "member", ownerAccountId: "legacy-owner" });
    expect(await ownership.resolveAppAccess("stranger", initial.capsuleId)).toBeUndefined();
    expect((await ownership.listAccessibleApps("member", { limit: 1 })).apps).toMatchObject([{ capsuleId: initial.capsuleId, role: "member" }]);
    expect(await ownership.putOwnership({ ...initial, ownerAccountId: "member", ownershipEpoch: 1 }, 0)).toBe(true);
    expect(await ownership.getOwnership(initial.capsuleId)).toMatchObject({ ownerAccountId: "member", ownershipEpoch: 1 });
    expect(await ownership.resolveAppAccess("member", initial.capsuleId)).toMatchObject({ role: "owner", ownershipEpoch: 1 });
    expect(await ownership.listMembers(initial.capsuleId)).toEqual([]);
    expect(await ownership.resolveAppAccess("legacy-owner", initial.capsuleId)).toBeUndefined();
    // Capsule JSON is a source payload; ownership is read from its physical row.
    if (name !== "memory") {
      expect((await control.getCapsule(initial.capsuleId))?.ownerAccountId).toBeUndefined();
    }
    expect(await ownership.putOwnership({ ...initial, ownerAccountId: "stale-owner", ownershipEpoch: 1 }, 0)).toBe(false);
    expect(await ownership.putOwnership({ ...initial, ownerAccountId: "stale-owner", ownershipEpoch: 0 }, 1)).toBe(false);
    expect(await ownership.putOwnership({ ...initial, ownerAccountId: "stale-owner", ownershipEpoch: 1 }, 1)).toBe(false);
    expect(await ownership.getOwnership(initial.capsuleId)).toMatchObject({ ownerAccountId: "member", ownershipEpoch: 1 });
    expect(await ownership.resolveAppAccess("member", initial.capsuleId)).toMatchObject({ role: "owner", ownershipEpoch: 1 });
    expect(await ownership.resolveAppAccess("stale-owner", initial.capsuleId)).toBeUndefined();
    expect(name).toBeTruthy();
  }
});

test("concurrent transfers compare the old epoch and retain the losing recipient's member grant", async () => {
  for (const { name, control, ownership } of await stores()) {
    await control.putWorkspace(workspace());
    await control.putCapsule(capsule());
    expect(await ownership.initializeOwnershipIfMissing(initial)).toBe(true);
    for (const accountId of ["recipient-a", "recipient-b"]) {
      expect(await ownership.putMember({ capsuleId: initial.capsuleId, accountId,
        status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
    }
    const transferA = () => ownership.putOwnership({ ...initial, ownerAccountId: "recipient-a", ownershipEpoch: 1 }, 0);
    const transferB = () => ownership.putOwnership({ ...initial, ownerAccountId: "recipient-b", ownershipEpoch: 1 }, 0);
    // SqliteFakeD1 uses a single SQLite connection and cannot overlap BEGINs.
    // The D1 case still exercises the same stale-epoch CAS after the first batch.
    const [a, b] = name === "d1"
      ? [await transferA(), await transferB()]
      : await Promise.all([transferA(), transferB()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ? "recipient-a" : "recipient-b";
    const loser = a ? "recipient-b" : "recipient-a";
    expect(await ownership.getOwnership(initial.capsuleId)).toMatchObject({ ownerAccountId: winner, ownershipEpoch: 1 });
    expect((await ownership.listMembers(initial.capsuleId)).map((member) => member.accountId)).toEqual([loser]);
    expect(await ownership.putOwnership({ ...initial, ownerAccountId: loser, ownershipEpoch: 1 }, 0)).toBe(false);
    expect((await ownership.listMembers(initial.capsuleId)).map((member) => member.accountId)).toEqual([loser]);
    expect(name).toBeTruthy();
  }
});

test("transferred ownership comes from the physical row while Capsule JSON stays ownerless", async () => {
  for (const { name, control, ownership } of await stores()) {
    await control.putWorkspace(workspace());
    await control.putCapsule({ ...capsule(), ownerAccountId: initial.ownerAccountId,
      ownershipEpoch: 0, managementState: "active", managementEpoch: 0, storageRoot: initial.storageRoot });
    expect(await ownership.initializeOwnershipIfMissing(initial)).toBe(true);
    expect(await ownership.putOwnership({ ...initial, ownerAccountId: "new-owner", ownershipEpoch: 1 }, 0)).toBe(true);
    await control.putCapsule({ ...capsule(), ownerAccountId: "intruder", ownershipEpoch: 99,
      managementState: "frozen", managementEpoch: 99, storageRoot: "apps/intruder" });
    expect(await ownership.getOwnership(initial.capsuleId)).toMatchObject({ ownerAccountId: "new-owner", ownershipEpoch: 1 });
    expect(await control.getCapsuleStorageRoot(initial.capsuleId)).toBe(initial.storageRoot);
    expect(await ownership.resolveAppAccess("new-owner", initial.capsuleId)).toMatchObject({ role: "owner" });
    expect(await ownership.resolveAppAccess(initial.ownerAccountId, initial.capsuleId)).toBeUndefined();
    expect((await control.getCapsule(initial.capsuleId))?.ownerAccountId).toBeUndefined();
    expect((await control.getCapsule(initial.capsuleId))?.storageRoot).toBeUndefined();
    expect(name).toBeTruthy();
  }
});

test("owned Source sync admission uses physical owner and active app members", async () => {
  for (const { control, ownership } of await stores()) {
    await control.putWorkspace(workspace());
    await control.putCapsule(capsule());
    await control.putSource({ id: capsule().sourceId, workspaceId: workspace().id,
      ownerCapsuleId: capsule().id, name: "owned source",
      url: "https://example.com/source.git", defaultRef: "main", defaultPath: ".",
      status: "active", autoSync: false, hookSecretHash: "fixture-hash",
      createdAt: NOW, updatedAt: NOW });
    expect(await ownership.initializeOwnershipIfMissing(initial)).toBe(true);
    const queued: SourceSyncRun = {
      id: "sync_owned", kind: "source_sync", workspaceId: workspace().id,
      sourceId: capsule().sourceId, url: "https://example.com/source.git", ref: "main",
      path: ".", archiveRef: "archives/sync_owned", status: "queued",
      createdAt: NOW, updatedAt: NOW,
    };
    const authority = { workspaceId: workspace().id, managementState: "active" as const, managementEpoch: 1 };
    expect((await control.beginSourceSyncRun({ ...queued, actorAccountId: "stranger" }, authority)).status)
      .toBe("conflict");
    expect((await control.beginSourceSyncRun({ ...queued, actorAccountId: "legacy-owner" }, authority)).status)
      .toBe("created");
    expect(await ownership.putMember({ capsuleId: capsule().id, accountId: "member",
      status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
    expect((await control.beginSourceSyncRun({ ...queued, id: "sync_member", actorAccountId: "member" }, authority)).status)
      .toBe("created");
  }
});

test("backfill payer and connection owner remain visible after durable readback", async () => {
  for (const { name, control, ownership } of await stores()) {
    const connection = { id: "conn_owner", workspaceId: "ws_app_owner", scope: "workspace", provider: "example",
      providerSource: "example.com/example", status: "verified", materialization: "env", envNames: [], createdAt: NOW, updatedAt: NOW } as ProviderConnection;
    await control.putConnection(connection);
    const event: UsageEvent = { id: "usage_owner", workspaceId: "ws_app_owner", kind: "runner_minute", quantity: 1,
      usdMicros: 0, ratingStatus: "unrated", source: "runner", idempotencyKey: "usage_owner", createdAt: NOW };
    await control.putUsageEvent(event);
    await control.putWorkspace(workspace());
    expect(await ownership.setConnectionOwnerIfMissing(connection.id, "legacy-owner")).toBe(true);
    expect(await ownership.setUsagePayerIfMissing(event.id, "legacy-owner")).toBe(true);
    expect((await control.listConnections("ws_app_owner"))[0]?.ownerAccountId).toBe("legacy-owner");
    expect((await control.listUsageEvents("ws_app_owner"))[0]?.payerAccountId).toBe("legacy-owner");
    expect(await ownership.setConnectionOwnerIfMissing(connection.id, "other")).toBe(false);
    expect(await ownership.setUsagePayerIfMissing(event.id, "other")).toBe(false);
    const personal = { ...connection, id: "conn_personal_owner", workspaceId: undefined };
    await control.putConnection(personal);
    expect(await ownership.setConnectionOwnerIfMissing(personal.id, "personal-owner")).toBe(true);
    expect(await control.getConnection(personal.id)).toMatchObject({ ownerAccountId: "personal-owner" });
    const operator = { ...personal, id: "conn_operator_owner", scope: "operator" as const };
    await control.putConnection(operator);
    expect(await ownership.setConnectionOwnerIfMissing(operator.id, "personal-owner")).toBe(false);
    expect(name).toBeTruthy();
  }
});

test("account billing binding has memory/Postgres/D1 parity", async () => {
  for (const { name, ownership } of await stores()) {
    const binding = { accountId: "billing-owner", billingAuthority: "hosted", billingRef: "old-workspace-ref",
      organizationRef: "org-ref", createdAt: NOW, updatedAt: NOW };
    expect(await ownership.getAccountBillingBinding(binding.accountId)).toBeUndefined();
    expect([name, await ownership.putAccountBillingBinding(binding)]).toEqual([name, true]);
    expect(await ownership.getAccountBillingBinding(binding.accountId)).toEqual(binding);
  }
});

test("credential mint ownership audit columns persist on all backends", async () => {
  for (const { control } of await stores()) {
    const event = { id: "mint_owner", runId: "run_owner", workspaceId: "ws_app_owner", capsuleId: "cap_app_owner",
      connectionId: "conn_owner", phase: "apply" as const, capabilities: ["example"], actorId: "actor",
      actorAccountId: "member", connectionOwnerAccountId: "legacy-owner", ownershipEpoch: 4, createdAt: NOW };
    await control.putCredentialMintEvent(event);
    expect(await control.listCredentialMintEventsForRun(event.runId)).toEqual([event]);
  }
});

test("new Capsule, Connection, and usage writes assign owner and payer", async () => {
  for (const { control, ownership } of await stores()) {
    await control.putWorkspace(workspace());
    const app = { ...capsule(), ownerAccountId: "app-owner", storageRoot: "apps/cap_app_owner",
      ownershipEpoch: 0, managementState: "active" as const, managementEpoch: 0 };
    await control.putCapsule(app);
    expect(await ownership.initializeOwnershipIfMissing({ capsuleId: app.id, ownerAccountId: "app-owner",
      ownershipEpoch: 0, managementState: "active", managementEpoch: 0,
      storageRoot: "apps/cap_app_owner" })).toBe(true);
    expect(await ownership.getOwnership(app.id)).toMatchObject({ ownerAccountId: "app-owner", storageRoot: app.storageRoot });
    expect((await control.getCapsule(app.id))?.ownerAccountId).toBeUndefined();
    expect(await control.getCapsuleStorageRoot(app.id)).toBe(app.storageRoot);
    const connection = { id: "conn_new", workspaceId: workspace().id, scope: "workspace", provider: "example",
      providerSource: "example.com/example", status: "verified", materialization: "env", envNames: [],
      createdAt: NOW, updatedAt: NOW } as ProviderConnection;
    await control.putConnection(connection);
    expect(await control.getConnection(connection.id)).toMatchObject({ ownerAccountId: "legacy-owner" });
    const usage: UsageEvent = { id: "usage_new", workspaceId: workspace().id, capsuleId: app.id,
      kind: "runner_minute", quantity: 1, usdMicros: 0, ratingStatus: "unrated", source: "runner",
      idempotencyKey: "usage_new", createdAt: NOW };
    expect(await control.putUsageEvent(usage)).toMatchObject({ payerAccountId: "app-owner" });
    expect((await control.listUsageEvents(workspace().id))[0]).toMatchObject({ payerAccountId: "app-owner" });
  }
});

test("initial Capsule creation copies only active Workspace owner and admin grants once", async () => {
  for (const { name, control, ownership } of await stores()) {
    const ws = { ...workspace(), type: "organization" as const };
    await control.putWorkspace(ws);
    for (const [accountId, roles, status] of [
      ["legacy-owner", ["owner"], "active"],
      ["co-owner", ["owner"], "active"],
      ["admin", ["admin"], "active"],
      ["ordinary", ["member"], "active"],
      ["viewer", ["viewer"], "active"],
      ["suspended-admin", ["admin"], "suspended"],
      ["invited-admin", ["admin"], "invited"],
    ] as const) {
      await control.putWorkspaceMember({ id: `wm_${accountId}`, workspaceId: ws.id,
        accountId, roles, status, createdAt: NOW, updatedAt: NOW });
    }
    const source = { id: "src_initial_owner", workspaceId: ws.id, name: "initial-owner",
      url: "https://example.com/source.git", defaultRef: "main", defaultPath: ".",
      status: "active" as const, hookSecretHash: "fixture-hash", autoSync: false,
      createdAt: NOW, updatedAt: NOW };
    await control.putSource(source);
    const app = { ...capsule(), id: "cap_initial_owner", name: "initial-owner", slug: "initial-owner",
      sourceId: source.id, installConfigId: "cfg_initial_owner", status: "pending" as const,
    };
    const input = {
      installConfig: { id: app.installConfigId, workspaceId: ws.id, name: "initial-owner",
        variableMapping: {}, outputAllowlist: {}, policy: {}, createdAt: NOW, updatedAt: NOW },
      capsule: app,
      initialOwnership: { capsuleId: app.id, ownerAccountId: ws.ownerUserId,
        ownershipEpoch: 0, managementState: "active" as const, managementEpoch: 0,
        storageRoot: "apps/cap_initial_owner" },
      providerBindingSet: { id: "pbs_initial_owner", workspaceId: ws.id, capsuleId: app.id,
        environment: app.environment, bindings: [], createdAt: NOW, updatedAt: NOW },
    };
    expect((await control.createCapsuleInitialAuthority(input)).status).toBe("created");
    expect((await ownership.listMembers(app.id)).map((member) => member.accountId).sort()).toEqual(["admin", "co-owner"]);
    expect(await ownership.resolveAppAccess("admin", app.id)).toMatchObject({ role: "member", ownerAccountId: ws.ownerUserId });
    expect(await ownership.resolveAppAccess(ws.ownerUserId, app.id)).toMatchObject({ role: "owner" });
    for (const denied of ["ordinary", "viewer", "suspended-admin", "invited-admin"]) {
      expect(await ownership.resolveAppAccess(denied, app.id)).toBeUndefined();
    }
    expect(await ownership.deleteMember(app.id, "admin")).toBe(true);
    expect((await control.createCapsuleInitialAuthority(input)).status).toBe("replayed");
    expect((await ownership.listMembers(app.id)).map((member) => member.accountId)).toEqual(["co-owner"]);
    expect(name).toBeTruthy();
  }
});

test("app inventory pages mixed physical and legacy access without Workspace fallback for new owners", async () => {
  for (const { name, control, ownership } of await stores()) {
    const ws = workspace();
    await control.putWorkspace(ws);
    for (const [accountId, roles, status] of [
      ["admin", ["admin"], "active"],
      ["viewer", ["viewer"], "active"],
      ["invited", ["admin"], "invited"],
    ] as const) await control.putWorkspaceMember({ id: `wm_${accountId}`, workspaceId: ws.id,
      accountId, roles, status, createdAt: NOW, updatedAt: NOW });
    const rows = [
      ["B_owned", "admin", 2],
      ["a_legacy", undefined, 0],
      ["c_member", "other", 3],
      ["d_denied", "other", 4],
      ["e_legacy", undefined, 0],
      ["f_invited", "other", 5],
    ] as const;
    for (const [id, ownerAccountId, ownershipEpoch] of rows) {
      await control.putCapsule({ ...capsule(), id, name: id, slug: id });
      if (ownerAccountId) expect(await ownership.initializeOwnershipIfMissing({
        capsuleId: id, ownerAccountId, ownershipEpoch, managementState: "active",
        managementEpoch: 0, storageRoot: `apps/${id}`,
      })).toBe(true);
    }
    expect(await ownership.putMember({ capsuleId: "c_member", accountId: "admin", status: "active",
      createdAt: NOW, updatedAt: NOW })).toBe(true);
    expect(await ownership.putMember({ capsuleId: "f_invited", accountId: "admin", status: "invited",
      createdAt: NOW, updatedAt: NOW })).toBe(true);
    const first = await ownership.listAccessibleApps("admin", { limit: 2 });
    expect(first).toEqual({ apps: [
      { capsuleId: "B_owned", role: "owner", ownerAccountId: "admin", ownershipEpoch: 2 },
      { capsuleId: "a_legacy", role: "member", ownerAccountId: ws.ownerUserId, ownershipEpoch: 0 },
    ], nextCursor: "a_legacy" });
    expect(await ownership.listAccessibleApps("admin", { cursor: first.nextCursor, limit: 2 })).toEqual({ apps: [
      { capsuleId: "c_member", role: "member", ownerAccountId: "other", ownershipEpoch: 3 },
      { capsuleId: "e_legacy", role: "member", ownerAccountId: ws.ownerUserId, ownershipEpoch: 0 },
    ] });
    expect(await ownership.listAccessibleApps("viewer")).toEqual({ apps: [] });
    expect(await ownership.listAccessibleApps("invited")).toEqual({ apps: [] });
    expect((await ownership.listAccessibleApps(ws.ownerUserId)).apps.map((app) => app.capsuleId))
      .toEqual(["a_legacy", "e_legacy"]);
    expect(name).toBeTruthy();
  }
});

test("destroyed Capsules never resolve or appear in app access", async () => {
  for (const { control, ownership } of await stores()) {
    await control.putWorkspace(workspace());
    const destroyed = { ...capsule(), id: "cap_destroyed_access", status: "destroyed" as const,
      ownerAccountId: "destroyed-owner", ownershipEpoch: 0, managementState: "active" as const,
      managementEpoch: 0, storageRoot: "apps/cap_destroyed_access" };
    await control.putCapsule(destroyed);
    expect(await ownership.resolveAppAccess("destroyed-owner", destroyed.id)).toBeUndefined();
    expect(await ownership.listAccessibleApps("destroyed-owner")).toEqual({ apps: [] });
  }
});

test("pre-v77 D1 app inventory uses legacy access without missing-column errors", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
  const fence = await acquireControlD1MaintenanceFence(db, {
    sourceCommit: "a".repeat(40), manifestDigest: `sha256:${"b".repeat(64)}`,
    environment: "test", databaseRole: "in_place", releasePolicy: "in_place",
  }, NOW);
  await releaseControlD1MaintenanceFence(db, fence, "2026-10-28T00:00:01.000Z");
  const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  const statements: string[] = [];
  const ownershipDb = {
    prepare(sql: string) { statements.push(sql); return db.prepare(sql); },
  };
  const ownership = new D1AppOwnershipStore(ownershipDb, control);
  await control.putWorkspace(workspace());
  await control.putWorkspaceMember({ id: "legacy_admin", workspaceId: workspace().id,
    accountId: "admin", roles: ["admin"], status: "active", createdAt: NOW, updatedAt: NOW });
  await control.putCapsule(capsule());
  await control.putCapsule({ ...capsule(), id: "cap_app_owner_z", name: "app-owner-z", slug: "app-owner-z" });
  const first = await ownership.listAccessibleApps("admin", { limit: 1 });
  expect(first).toEqual({ apps: [
    { capsuleId: capsule().id, role: "member", ownerAccountId: workspace().ownerUserId, ownershipEpoch: 0 },
  ], nextCursor: capsule().id });
  expect(await ownership.listAccessibleApps("admin", { cursor: first.nextCursor, limit: 1 })).toEqual({ apps: [
    { capsuleId: "cap_app_owner_z", role: "member", ownerAccountId: workspace().ownerUserId, ownershipEpoch: 0 },
  ] });
  expect(statements.some((sql) => /from capsules c cross join input/iu.test(sql) && /limit \?/iu.test(sql))).toBe(true);
  expect(statements.some((sql) => /select .*record_json from capsules/iu.test(sql))).toBe(false);
});

test("D1 ownership schema cache stores present columns but observes a later migration", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 76 });
  const probes: string[] = [];
  const countedDb = {
    prepare(sql: string) { if (/pragma table_info\(capsules\)/iu.test(sql)) probes.push(sql); return db.prepare(sql); },
  };
  const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  const ownership = new D1AppOwnershipStore(countedDb, control);
  expect(await ownership.getOwnership("cap_late_v77")).toBeUndefined();
  expect(await ownership.getOwnership("cap_late_v77")).toBeUndefined();
  expect(probes).toHaveLength(2);
  await ensureD1OpenTofuLedgerSchema(db);
  await control.putWorkspace(workspace());
  await control.putCapsule({ ...capsule(), id: "cap_late_v77" });
  await db.prepare(`update capsules set owner_account_id='late-owner', ownership_epoch=4,
    storage_root='apps/cap_late_v77' where id='cap_late_v77'`).run();
  expect(await ownership.getOwnership("cap_late_v77")).toMatchObject({ ownerAccountId: "late-owner", ownershipEpoch: 4 });
  const presentProbeCount = probes.length;
  expect(await ownership.getOwnership("cap_late_v77")).toMatchObject({ ownerAccountId: "late-owner" });
  expect(probes).toHaveLength(presentProbeCount);
});

test("D1 transfer rolls back the owner update when member cleanup fails", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const control = new CloudflareD1OpenTofuControlStore(db);
  const ownership = new D1AppOwnershipStore(db, control);
  await control.putWorkspace(workspace());
  await control.putCapsule(capsule());
  expect(await ownership.initializeOwnershipIfMissing(initial)).toBe(true);
  expect(await ownership.putMember({ capsuleId: initial.capsuleId, accountId: "recipient",
    status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
  await db.exec(`create trigger reject_owner_cleanup before delete on capsule_members
    begin select raise(abort, 'member cleanup failed'); end;`);
  await expect(ownership.putOwnership({ ...initial, ownerAccountId: "recipient", ownershipEpoch: 1 }, 0))
    .rejects.toThrow("member cleanup failed");
  expect(await ownership.getOwnership(initial.capsuleId)).toEqual(initial);
  expect((await ownership.listMembers(initial.capsuleId)).map((member) => member.accountId)).toEqual(["recipient"]);
});

test("an orphan legacy membership cannot grant app inventory access", async () => {
  const db = new SqliteFakeD1();
  // Deliberately inconsistent retained rows: the old Workspace is absent.
  await db.exec(`
    create table capsules(id text, space_id text, status text, owner_account_id text, ownership_epoch integer,
      management_state text, management_epoch integer, storage_root text);
    create table capsule_members(capsule_id text, account_id text, status text);
    create table workspaces(id text, record_json text);
    create table workspace_members(workspace_id text, account_id text, status text, record_json text);
    insert into capsules values('orphan','missing','active',null,0,'active',0,null);
    insert into workspace_members values('missing','admin','active',
      '{"workspaceId":"missing","accountId":"admin","status":"active","roles":["admin"]}');
  `);
  const control = {
    getCapsule: async () => ({ ...capsule(), id: "orphan", workspaceId: "missing" }),
    getWorkspace: async () => undefined,
  } as unknown as OpenTofuControlStore;
  const ownership = new D1AppOwnershipStore(db, control);
  expect(await ownership.resolveAppAccess("admin", "orphan")).toBeUndefined();
  expect(await ownership.listAccessibleApps("admin")).toEqual({ apps: [] });
  await db.exec("update capsules set owner_account_id='app-owner', ownership_epoch=7, storage_root='apps/orphan'");
  expect(await ownership.listAccessibleApps("app-owner")).toEqual({ apps: [
    { capsuleId: "orphan", role: "owner", ownerAccountId: "app-owner", ownershipEpoch: 7 },
  ] });
  expect(await ownership.listAccessibleApps("admin")).toEqual({ apps: [] });
});
