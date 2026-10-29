import { expect, test } from "bun:test";
import type { Capsule } from "../../../../contract/capsules.ts";
import type { Workspace, WorkspaceMember } from "../../../../contract/workspaces.ts";
import { planAppAccessCutoverDiff } from "../../../../core/domains/app-ownership/access-cutover-diff.ts";
import { D1AppOwnershipStore, InMemoryAppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { runAppAccessCutoverVerification } from "../../../../scripts/verify-app-access-cutover.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../../worker/src/d1_schema_maintenance.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-29T00:00:00.000Z";

function workspace(id: string, ownerUserId: string): Workspace {
  return { id, handle: id, displayName: id, type: "organization", ownerUserId, createdAt: NOW, updatedAt: NOW };
}
function capsule(id: string, workspaceId: string, status: Capsule["status"] = "active"): Capsule {
  return {
    id, workspaceId, projectId: `prj_${workspaceId}`, name: id, slug: id, sourceId: `src_${id}`,
    installConfigId: `cfg_${id}`, environment: "production", currentStateGeneration: 1, status,
    createdAt: NOW, updatedAt: NOW,
  };
}
function member(workspaceId: string, accountId: string, role: WorkspaceMember["roles"][number], status: WorkspaceMember["status"] = "active"): WorkspaceMember {
  return { id: `wsm_${workspaceId}_${accountId}`, workspaceId, accountId, roles: [role], status, createdAt: NOW, updatedAt: NOW };
}

test("Phase 0 shape (owners only, no other members) reports no difference", async () => {
  const control = new InMemoryOpenTofuControlStore();
  const ownership = new InMemoryAppOwnershipStore(control);
  await control.putWorkspace(workspace("ws_personal", "owner_a"));
  await control.putWorkspace(workspace("ws_org", "owner_b"));
  await control.putWorkspaceMember(member("ws_personal", "owner_a", "owner"));
  await control.putCapsule(capsule("cap_unowned", "ws_personal"));
  await control.putCapsule(capsule("cap_owned", "ws_org"));
  await control.putCapsule(capsule("cap_gone", "ws_org", "destroyed"));
  await ownership.initializeOwnershipIfMissing({
    capsuleId: "cap_owned", ownerAccountId: "owner_b", ownershipEpoch: 0, managementState: "active",
    managementEpoch: 0, storageRoot: "workspaces/ws_org/capsules/cap_owned",
  });
  const report = await runAppAccessCutoverVerification({ control, ownership });
  expect(report).toEqual({
    capsulesChecked: 2,
    capsulesProjectedFromBackfill: 1,
    sourcesChecked: 0,
    pairsChecked: 2,
    differenceCount: 0,
    differencesByClass: { view: 0, manage: 0, owner_only: 0 },
    differences: [],
  });
});

test("role differences are classified for projected and transferred apps", async () => {
  const control = new InMemoryOpenTofuControlStore();
  const ownership = new InMemoryAppOwnershipStore(control);
  await control.putWorkspace(workspace("ws", "ws_owner"));
  for (const row of [
    member("ws", "admin", "admin"), member("ws", "reader", "member"), member("ws", "viewer", "viewer"),
    member("ws", "suspended", "admin", "suspended"),
  ]) await control.putWorkspaceMember(row);
  await control.putCapsule(capsule("cap_projected", "ws"));
  await control.putCapsule(capsule("cap_transferred", "ws"));
  await ownership.initializeOwnershipIfMissing({
    capsuleId: "cap_transferred", ownerAccountId: "ws_owner", ownershipEpoch: 0, managementState: "active",
    managementEpoch: 0, storageRoot: "workspaces/ws/capsules/cap_transferred",
  });
  expect(await ownership.putOwnership({
    capsuleId: "cap_transferred", ownerAccountId: "outsider", ownershipEpoch: 1, managementState: "active",
    managementEpoch: 0, storageRoot: "workspaces/ws/capsules/cap_transferred",
  }, 0)).toBe(true);
  const report = await planAppAccessCutoverDiff({ control, ownership });
  const rows = report.differences.map((row) =>
    `${row.capsuleId} ${row.accountId} ${row.accessClass} ${row.workspaceDecision}->${row.appDecision} ${row.reason} ${row.ownershipSource}`);
  expect(rows).toEqual([
    "cap_projected admin owner_only true->false workspace_manager_not_app_owner backfill_projection",
    "cap_projected reader view true->false workspace_reader_not_app_member backfill_projection",
    "cap_projected viewer view true->false workspace_reader_not_app_member backfill_projection",
    "cap_transferred admin view true->false workspace_manager_not_app_member ownership_row",
    "cap_transferred admin manage true->false workspace_manager_not_app_member ownership_row",
    "cap_transferred admin owner_only true->false workspace_manager_not_app_member ownership_row",
    "cap_transferred outsider view false->true app_role_without_workspace_role ownership_row",
    "cap_transferred outsider manage false->true app_role_without_workspace_role ownership_row",
    "cap_transferred outsider owner_only false->true app_role_without_workspace_role ownership_row",
    "cap_transferred reader view true->false workspace_reader_not_app_member ownership_row",
    "cap_transferred viewer view true->false workspace_reader_not_app_member ownership_row",
    "cap_transferred ws_owner view true->false workspace_manager_not_app_member ownership_row",
    "cap_transferred ws_owner manage true->false workspace_manager_not_app_member ownership_row",
    "cap_transferred ws_owner owner_only true->false workspace_manager_not_app_member ownership_row",
  ]);
  expect(report.differencesByClass).toEqual({ view: 7, manage: 3, owner_only: 4 });
});

test("a predeployed D1 v75 target is compared from the backfill projection", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
  const fence = await acquireControlD1MaintenanceFence(db, {
    sourceCommit: "a".repeat(40), manifestDigest: `sha256:${"b".repeat(64)}`,
    environment: "test", databaseRole: "in_place", releasePolicy: "in_place",
  }, NOW);
  await releaseControlD1MaintenanceFence(db, fence, "2026-10-29T00:00:01.000Z");
  const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  await control.putWorkspace(workspace("ws_v75", "owner_v75"));
  const row = capsule("cap_v75", "ws_v75");
  await db.prepare(`insert into capsules(id,space_id,project_id,name,slug,source_id,install_config_id,
    environment,current_state_generation,status,record_json,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.id, row.workspaceId, row.projectId, row.name, row.slug,
    row.sourceId, row.installConfigId, row.environment, row.currentStateGeneration, row.status,
    JSON.stringify(row), row.createdAt, row.updatedAt).run();
  const report = await planAppAccessCutoverDiff({ control, ownership: new D1AppOwnershipStore(db, control) });
  expect(report).toMatchObject({ capsulesChecked: 1, capsulesProjectedFromBackfill: 1, pairsChecked: 1, differenceCount: 0 });
}, 180_000);

test("an owner row written before its roster is compared as the live code decides", async () => {
  const control = new InMemoryOpenTofuControlStore();
  const ownership = new InMemoryAppOwnershipStore(control);
  await control.putWorkspace(workspace("ws_mid", "ws_owner"));
  await control.putWorkspaceMember(member("ws_mid", "admin", "admin"));
  await control.putCapsule(capsule("cap_mid", "ws_mid"));
  // Backfill wrote the legacy-default owner row; the member batch has not run.
  await ownership.initializeOwnershipIfMissing({
    capsuleId: "cap_mid", ownerAccountId: "ws_owner", ownershipEpoch: 0, managementState: "active",
    managementEpoch: 0, storageRoot: "workspaces/ws_mid/capsules/cap_mid",
  });
  const report = await planAppAccessCutoverDiff({ control, ownership });
  expect(report.differences.map((row) => `${row.accountId} ${row.accessClass} ${row.reason} ${row.affectsBothRequiredCredentials}`)).toEqual([
    "admin view workspace_manager_not_app_member true",
    "admin manage workspace_manager_not_app_member true",
    "admin owner_only workspace_manager_not_app_member true",
  ]);
});

test("labels and legacy read model: role-less members read, readers who are app members gain", async () => {
  const control = new InMemoryOpenTofuControlStore();
  const ownership = new InMemoryAppOwnershipStore(control);
  await control.putWorkspace(workspace("ws_labels", "ws_owner"));
  await control.putWorkspaceMember(member("ws_labels", "reader_member", "viewer"));
  await control.putWorkspaceMember({ ...member("ws_labels", "roleless", "viewer"), roles: [] });
  await control.putCapsule(capsule("cap_labels", "ws_labels"));
  await ownership.initializeOwnershipIfMissing({
    capsuleId: "cap_labels", ownerAccountId: "ws_owner", ownershipEpoch: 0, managementState: "active",
    managementEpoch: 0, storageRoot: "apps/cap_labels",
  });
  expect(await ownership.putMember({ capsuleId: "cap_labels", accountId: "reader_member", status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
  const report = await planAppAccessCutoverDiff({ control, ownership });
  expect(report.differences.map((row) => `${row.accountId} ${row.accessClass} ${row.workspaceDecision}->${row.appDecision} ${row.reason} ${row.affectsBothRequiredCredentials}`)).toEqual([
    "reader_member manage false->true app_role_beyond_workspace_role false",
    "roleless view true->false workspace_reader_not_app_member true",
  ]);
});

test("an ownerless Source needs every app built from it", async () => {
  const control = new InMemoryOpenTofuControlStore();
  const ownership = new InMemoryAppOwnershipStore(control);
  await control.putWorkspace(workspace("ws_src", "ws_owner"));
  await control.putSource({
    id: "src_shared", workspaceId: "ws_src", name: "shared", url: "https://git.example.test/app.git",
    defaultRef: "main", defaultPath: ".", status: "active", createdAt: NOW, updatedAt: NOW,
    hookSecretHash: "hash", autoSync: false,
  } as never);
  for (const id of ["cap_a", "cap_b"]) {
    await control.putCapsule({ ...capsule(id, "ws_src"), sourceId: "src_shared" });
    await ownership.initializeOwnershipIfMissing({
      capsuleId: id, ownerAccountId: "ws_owner", ownershipEpoch: 0, managementState: "active",
      managementEpoch: 0, storageRoot: `apps/${id}`,
    });
  }
  expect(await ownership.putMember({ capsuleId: "cap_a", accountId: "only_a", status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
  const report = await planAppAccessCutoverDiff({ control, ownership });
  expect(report.sourcesChecked).toBe(1);
  expect(report.differences.filter((row) => row.sourceId === "src_shared").map((row) => `${row.accountId} ${row.accessClass} ${row.appDecision}`))
    .toEqual([]);
  expect(report.differences.filter((row) => row.capsuleId === "cap_a").map((row) => `${row.accountId} ${row.accessClass}`))
    .toEqual(["only_a view", "only_a manage"]);
  // only_a manages cap_a but not cap_b, so the shared Source is not theirs.
  expect(report.differences.some((row) => row.sourceId === "src_shared" && row.accountId === "only_a")).toBe(false);
});
