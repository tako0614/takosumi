import { expect, test } from "bun:test";
import type { Capsule } from "../../../../contract/capsules.ts";
import type { ProviderConnection } from "../../../../contract/connections.ts";
import type { UsageEvent } from "../../../../contract/billing.ts";
import type { Workspace, WorkspaceMember } from "../../../../contract/workspaces.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { D1AppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../../worker/src/d1_schema_maintenance.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-28T00:00:00.000Z";
const workspace: Workspace = {
  id: "ws_legacy_runtime", handle: "legacy-runtime", displayName: "Legacy runtime",
  type: "organization", ownerUserId: "owner", createdAt: NOW, updatedAt: NOW,
};
const capsule: Capsule = {
  id: "cap_legacy_runtime", workspaceId: workspace.id, projectId: "prj_legacy_runtime",
  name: "Legacy app", slug: "legacy-app", sourceId: "src_legacy_runtime",
  installConfigId: "cfg_legacy_runtime", environment: "production",
  currentStateGeneration: 0, status: "active", ownerAccountId: "owner",
  storageRoot: "apps/cap_legacy_runtime", createdAt: NOW, updatedAt: NOW,
};
const connection: ProviderConnection = {
  id: "conn_legacy_runtime", workspaceId: workspace.id, scope: "workspace",
  provider: "example", providerSource: "example.com/example", status: "verified",
  materialization: "env", envNames: [], ownerAccountId: "owner",
  createdAt: NOW, updatedAt: NOW,
};
const usage: UsageEvent = {
  id: "usage_legacy_runtime", workspaceId: workspace.id, capsuleId: capsule.id,
  kind: "runner_minute", quantity: 1, usdMicros: 0, ratingStatus: "unrated",
  source: "runner", idempotencyKey: "usage_legacy_runtime", payerAccountId: "owner",
  createdAt: NOW,
};
const mint = {
  id: "mint_legacy_runtime", runId: "run_legacy_runtime", workspaceId: workspace.id,
  capsuleId: capsule.id, connectionId: connection.id, phase: "apply" as const,
  capabilities: ["example"], actorId: "actor", actorAccountId: "admin",
  connectionOwnerAccountId: "owner", ownershipEpoch: 3, createdAt: NOW,
};
function member(accountId: string, roles: WorkspaceMember["roles"], status: WorkspaceMember["status"] = "active"): WorkspaceMember {
  return { id: `member_${accountId}`, workspaceId: workspace.id, accountId, roles, status, createdAt: NOW, updatedAt: NOW };
}
async function preparePredeployedRuntime(db: SqliteFakeD1, version: number): Promise<void> {
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: version });
  const fence = await acquireControlD1MaintenanceFence(db, {
    sourceCommit: "a".repeat(40), manifestDigest: `sha256:${"b".repeat(64)}`,
    environment: "test", databaseRole: "in_place", releasePolicy: "in_place",
  }, NOW);
  await releaseControlD1MaintenanceFence(db, fence, "2026-10-28T00:00:01.000Z");
}

for (const version of [75, 76]) {
  test(`predeployed D1 v${version} runs new JSON Capsules on the legacy root and limits fallback access`, async () => {
    const db = new SqliteFakeD1();
    await preparePredeployedRuntime(db, version);
    const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    const ownership = new D1AppOwnershipStore(db, control);
    await control.putWorkspace(workspace);
    for (const row of [member("admin", ["admin"]), member("ordinary", ["member"]),
      member("viewer", ["viewer"]), member("suspended", ["admin"], "suspended")]) {
      await control.putWorkspaceMember(row);
    }
    // Seed the real old table so read compatibility is exercised independently
    // of the version-specific Capsule write path below.
    await db.prepare(`insert into capsules(id,space_id,project_id,name,slug,source_id,install_config_id,
      environment,current_state_generation,status,record_json,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(capsule.id,capsule.workspaceId,capsule.projectId,
        capsule.name,capsule.slug,capsule.sourceId,capsule.installConfigId,capsule.environment,
        capsule.currentStateGeneration,capsule.status,JSON.stringify(capsule),capsule.createdAt,capsule.updatedAt).run();
    const expectedRoot = `workspaces/${workspace.id}/capsules/${capsule.id}`;
    expect((await control.getCapsule(capsule.id))?.storageRoot).toBe(capsule.storageRoot);
    expect((await control.listCapsules(workspace.id))[0]?.storageRoot).toBe(capsule.storageRoot);
    expect((await control.getCapsulesByIds([capsule.id]))[0]?.storageRoot).toBe(capsule.storageRoot);
    expect((await control.getCapsuleByName(capsule.projectId, capsule.name, capsule.environment))?.storageRoot).toBe(capsule.storageRoot);
    expect(await control.getCapsuleStorageRoot(capsule.id)).toBe(expectedRoot);
    expect(new ObjectKeyArtifactReferenceAllocator().allocate({ kind: "state", workspaceId: workspace.id,
      subject: { kind: "capsule", id: capsule.id }, environment: capsule.environment, generation: 1,
      storageRoot: await control.getCapsuleStorageRoot(capsule.id) }))
      .toBe(`${expectedRoot}/environments/production/state-versions/00000001.tfstate.enc`);
    expect(await ownership.resolveAppAccess("owner", capsule.id)).toMatchObject({ role: "owner" });
    expect(await ownership.resolveAppAccess("admin", capsule.id)).toMatchObject({ role: "member" });
    for (const denied of ["ordinary", "viewer", "suspended", "stranger"]) {
      expect(await ownership.resolveAppAccess(denied, capsule.id)).toBeUndefined();
    }
    await control.putCapsule({ ...capsule, name: "Updated legacy app" });
    expect((await control.getCapsule(capsule.id))?.name).toBe("Updated legacy app");
    expect(await control.getCapsuleStorageRoot(capsule.id)).toBe(expectedRoot);
    expect(await db.prepare("select name from pragma_table_info('capsules') where name='storage_root'").first()).toBeNull();
  }, 180_000);

  test(`predeployed D1 v${version} writes Connection on the old table`, async () => {
    const db = new SqliteFakeD1();
    await preparePredeployedRuntime(db, version);
    const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    await control.putWorkspace(workspace);
    await control.putConnection(connection);
    expect((await control.listConnections(workspace.id))[0]?.id).toBe(connection.id);
  }, 180_000);

  test(`predeployed D1 v${version} writes usage on the old table`, async () => {
    const db = new SqliteFakeD1();
    await preparePredeployedRuntime(db, version);
    const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    await control.putWorkspace(workspace);
    await control.putUsageEvent({ ...usage, capsuleId: undefined });
    expect((await control.listUsageEvents(workspace.id))[0]?.id).toBe(usage.id);
  }, 180_000);

  test(`predeployed D1 v${version} writes mint on the old table`, async () => {
    const db = new SqliteFakeD1();
    await preparePredeployedRuntime(db, version);
    const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    await control.putCredentialMintEvent(mint);
    expect((await control.listCredentialMintEventsForRun(mint.runId))[0]?.id).toBe(mint.id);
  }, 180_000);
}

test("D1 v77 physically records Capsule, Connection, usage payer, and mint ownership", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  await control.putWorkspace(workspace);
  await control.putCapsule(capsule);
  const ownership = new D1AppOwnershipStore(db, control);
  expect(await ownership.initializeOwnershipIfMissing({
    capsuleId: capsule.id, ownerAccountId: "owner", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: "apps/cap_legacy_runtime",
  })).toBe(true);
  expect((await control.getCapsule(capsule.id))?.ownerAccountId).toBeUndefined();
  await control.putConnection(connection);
  await control.putUsageEvent(usage);
  await control.putCredentialMintEvent(mint);
  expect(await db.prepare("select owner_account_id,storage_root,ownership_epoch from capsules where id=?")
    .bind(capsule.id).first()).toEqual({ owner_account_id: "owner", storage_root: capsule.storageRoot, ownership_epoch: 0 });
  expect(await db.prepare("select owner_account_id from connections where id=?")
    .bind(connection.id).first()).toEqual({ owner_account_id: "owner" });
  expect(await db.prepare("select payer_account_id from usage_events where id=?")
    .bind(usage.id).first()).toEqual({ payer_account_id: "owner" });
  expect(await db.prepare("select actor_account_id,connection_owner_account_id,ownership_epoch from credential_mint_events where id=?")
    .bind(mint.id).first()).toEqual({ actor_account_id: "admin", connection_owner_account_id: "owner", ownership_epoch: 3 });
}, 180_000);
