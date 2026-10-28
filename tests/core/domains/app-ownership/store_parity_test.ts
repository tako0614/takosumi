import { afterEach, expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { ProviderConnection } from "takosumi-contract/connections";
import type { UsageEvent } from "takosumi-contract/billing";
import type { Workspace } from "takosumi-contract/workspaces";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
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
    expect(await ownership.putOwnership({ ...initial, ownerAccountId: "member", ownershipEpoch: 1 })).toBe(true);
    expect(await control.getCapsule(initial.capsuleId)).toMatchObject({ ownerAccountId: "member", ownershipEpoch: 1 });
    expect(await ownership.resolveAppAccess("member", initial.capsuleId)).toMatchObject({ role: "owner", ownershipEpoch: 1 });
    expect(await ownership.listMembers(initial.capsuleId)).toEqual([]);
    expect(await ownership.resolveAppAccess("legacy-owner", initial.capsuleId)).toBeUndefined();
    expect(await control.putCapsule({ ...capsule(), ownerAccountId: "stale-owner", ownershipEpoch: 0 }))
      .toMatchObject({ ownerAccountId: "member", ownershipEpoch: 1 });
    expect(await control.getCapsule(initial.capsuleId)).toMatchObject({ ownerAccountId: "member", ownershipEpoch: 1 });
    expect(await ownership.resolveAppAccess("member", initial.capsuleId)).toMatchObject({ role: "owner", ownershipEpoch: 1 });
    expect(await ownership.resolveAppAccess("stale-owner", initial.capsuleId)).toBeUndefined();
    expect(name).toBeTruthy();
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
    expect(await ownership.getOwnership(app.id)).toMatchObject({ ownerAccountId: "app-owner", storageRoot: app.storageRoot });
    expect(await control.getCapsule(app.id)).toMatchObject({ ownerAccountId: "app-owner", storageRoot: app.storageRoot });
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
      ownerAccountId: ws.ownerUserId, ownershipEpoch: 0, managementState: "active" as const,
      managementEpoch: 0, storageRoot: "apps/cap_initial_owner" };
    const input = {
      installConfig: { id: app.installConfigId, workspaceId: ws.id, name: "initial-owner",
        variableMapping: {}, outputAllowlist: {}, policy: {}, createdAt: NOW, updatedAt: NOW },
      capsule: app,
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
