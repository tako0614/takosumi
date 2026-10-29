import { expect, test } from "bun:test";
import { deterministicInitialCapsuleId, deterministicInstallSourceId } from "../../../core/domains/install-plans/source-reservation.ts";
import type { Capsule } from "takosumi-contract/capsules";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type { StoredGitInstallPlan } from "../../../core/domains/install-plans/store.ts";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { D1PreparedStatement, D1Result } from "../../../worker/src/bindings.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import { handleSourceOwnershipMigrationOperatorRequest, SOURCE_OWNERSHIP_MIGRATION_PATH } from
  "../../../worker/src/source_ownership_migration_operator.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { inventorySourceOwnershipGroup, migrateSourceOwnership, prepareSourceOwnershipMigration } from
  "../../../core/domains/sources/ownership-migration.ts";

const t0 = "2026-10-01T00:00:00.000Z";
const workspaceId = "ws_migration_d1";
const sourceId = "src_migration_d1";
const url = "https://example.test/repo.git";

class InterleavedD1 extends SqliteFakeD1 {
  beforeNextBatch?: () => Promise<void>;
  override async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    const hook = this.beforeNextBatch;
    this.beforeNextBatch = undefined;
    if (hook) await hook();
    return super.batch<T>(statements);
  }
}

async function fixture(db: InterleavedD1, capsuleIds: readonly string[], ownerCapsuleId?: string) {
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putWorkspace({ id: workspaceId, handle: "migration-d1", displayName: "Migration D1",
    type: "personal", ownerUserId: "owner_migration_d1", createdAt: t0, updatedAt: t0 });
  await store.putSource({ id: sourceId, workspaceId, ownerCapsuleId, name: "repo", url, defaultRef: "main",
    defaultPath: ".", status: "active", autoSync: true, hookSecretHash: "a".repeat(64),
    createdAt: t0, updatedAt: t0 });
  for (const id of capsuleIds) {
    const capsule: Capsule = { id, workspaceId, projectId: "prj_migration_d1", name: id, slug: id,
      sourceId, installConfigId: `cfg_${id}`, environment: "production", currentStateGeneration: 0,
      status: "active", createdAt: t0, updatedAt: t0 };
    await store.putCapsule(capsule);
    const config = { id: capsule.installConfigId, workspaceId, name: `config ${id}`,
      createdAt: t0, updatedAt: t0 };
    await db.prepare(`insert into install_configs (id, space_id, record_json, created_at, updated_at)
      values (?, ?, ?, ?, ?)`)
      .bind(config.id, workspaceId, JSON.stringify(config), t0, t0).run();
  }
  return store;
}

test("D1 migrates one shared Source, copying a complete snapshot and producer Run", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a", "cap_b"]);
  const archiveRef = `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_old/source.tar.zst`;
  const run: SourceSyncRun = { id: "ssr_old", kind: "source_sync", workspaceId, sourceId, url,
    ref: "main", path: ".", archiveRef, status: "succeeded", snapshotId: "snap_old",
    createdAt: t0, updatedAt: t0 };
  const snapshot: SourceSnapshot = { id: "snap_old", origin: "git", workspaceId, sourceId, url,
    ref: "main", path: ".", resolvedCommit: "a".repeat(40), archiveRef,
    archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 20,
    fetchedByRunId: run.id, fetchedAt: t0 };
  await store.putSourceSyncRun(run);
  await store.putSourceSnapshot(snapshot);
  const report: CapsuleCompatibilityReport = { id: "cgr_old", sourceId,
    sourceSnapshotId: snapshot.id, modulePath: ".", level: "ready", findings: [],
    providerPackages: [], rootProviderRequirements: [], resources: [], dataSources: [],
    provisioners: [], createdAt: t0 };
  await store.putCapsuleCompatibilityReport(report);
  const plan = { id: "plan_b", workspaceId, capsuleId: "cap_b", status: "succeeded",
    operation: "apply", sourceSnapshotId: snapshot.id, compatibilityReportId: report.id,
    source: { kind: "git", url, ref: "main", commit: "a".repeat(40) },
    sourceDigest: "digest", variablesDigest: "digest" } as unknown as PlanRun;
  await store.putPlanRun(plan);
  const compatibilityRun: Run = { id: "check_old", workspaceId, sourceId, capsuleId: "cap_b",
    type: "compatibility_check", status: "succeeded", sourceSnapshotId: snapshot.id,
    compatibilityReportId: report.id };
  await store.putCompatibilityCheckRun(compatibilityRun);
  const gitPlan = { id: "install_old", workspaceId, actorSubject: "account:owner_migration_d1",
    idempotencyKeyHash: "hash", requestDigest: "digest", createdBy: "owner_migration_d1",
    source: { name: "repo", url, ref: "main", path: "." },
    capsule: { name: "cap_b", environment: "production" }, options: {},
    sourceId, sourceSyncRunId: run.id, sourceSnapshotId: snapshot.id,
    compatibilityReportId: report.id, compatibilityCheckRunId: compatibilityRun.id,
    preflight: { sourceId, sourceSnapshotId: snapshot.id,
      compatibilityReportId: report.id, compatibilityCheckRunId: compatibilityRun.id,
      installConfigId: "cfg_cap_b" },
    capsuleId: "cap_b", phase: "reviewable", generation: 1,
    createdAt: t0, updatedAt: t0 } as StoredGitInstallPlan;
  await db.prepare(`insert into git_install_plans
    (id, workspace_id, actor_subject, idempotency_key_hash, request_digest,
      phase, generation, record_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(gitPlan.id, gitPlan.workspaceId, gitPlan.actorSubject, gitPlan.idempotencyKeyHash,
      gitPlan.requestDigest, gitPlan.phase, gitPlan.generation, JSON.stringify(gitPlan),
      gitPlan.createdAt, gitPlan.updatedAt).run();
  // A retained revision can predate the explicit Source-id field; Capsule
  // identity still places it in this migration group.
  const legacyRevision = { ...gitPlan, id: "revision_old", operation: "revision",
    idempotencyKeyHash: "revision_hash", phase: "failed", generation: 2,
    revision: { base: { installConfigId: "cfg_revision_base" } },
    sourceId: undefined, sourceSyncRunId: undefined, sourceSnapshotId: undefined,
    compatibilityReportId: undefined, compatibilityCheckRunId: undefined,
    preflight: undefined } as StoredGitInstallPlan;
  const revisionBase = { id: "cfg_revision_base", workspaceId, name: "old revision base",
    createdAt: t0, updatedAt: t0 };
  await db.prepare(`insert into install_configs (id, space_id, record_json, created_at, updated_at)
    values (?, ?, ?, ?, ?)`)
    .bind(revisionBase.id, workspaceId, JSON.stringify(revisionBase), t0, t0).run();
  await db.prepare(`insert into git_install_plans
    (id, workspace_id, actor_subject, idempotency_key_hash, request_digest,
      phase, generation, record_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(legacyRevision.id, legacyRevision.workspaceId, legacyRevision.actorSubject,
      legacyRevision.idempotencyKeyHash, legacyRevision.requestDigest,
      legacyRevision.phase, legacyRevision.generation, JSON.stringify(legacyRevision),
      legacyRevision.createdAt, legacyRevision.updatedAt).run();
  expect((await store.readGroup(sourceId))?.installConfigs.map((config) => config.id))
    .toContain(revisionBase.id);
  let copied = 0;
  const result = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { copied++; } }, { apply: true, now: "2026-10-28T00:00:00.000Z" });
  expect(result).toHaveLength(1);
  expect(result[0]?.status).toBe("committed");
  expect(result[0]?.inventory.action).toBe("split");
  expect(copied).toBe(1);
  const moved = await store.getCapsule("cap_b");
  expect(moved?.sourceId).not.toBe(sourceId);
  expect((await store.getSource(sourceId))?.ownerCapsuleId).toBe("cap_a");
  expect((await store.getSource(moved!.sourceId))?.ownerCapsuleId).toBe("cap_b");
  const copiedSnapshots = await store.listSourceSnapshots(moved!.sourceId);
  expect(copiedSnapshots).toHaveLength(1);
  expect(copiedSnapshots[0]?.archiveRef).not.toBe(archiveRef);
  expect((await store.getSourceSyncRun(copiedSnapshots[0]!.fetchedByRunId))?.sourceId).toBe(moved!.sourceId);
  const movedPlan = await store.getPlanRun(plan.id);
  expect(movedPlan?.sourceSnapshotId).toBe(copiedSnapshots[0]?.id);
  expect(movedPlan?.compatibilityReportId).not.toBe(report.id);
  const movedReport = await store.getCapsuleCompatibilityReport(movedPlan!.compatibilityReportId!);
  expect(movedReport?.sourceId).toBe(moved!.sourceId);
  expect(movedReport?.sourceSnapshotId).toBe(copiedSnapshots[0]?.id);
  expect(movedReport?.capsuleId).toBeUndefined();
  const movedReportPhysical = await db.prepare("select installation_id from capsule_compatibility_reports where id = ?")
    .bind(movedReport!.id).first<{ installation_id: string | null }>();
  expect(movedReportPhysical?.installation_id).toBeNull();
  const movedGitPlanRow = await db.prepare("select record_json from git_install_plans where id = ?")
    .bind(gitPlan.id).first<{ record_json: string }>();
  const movedGitPlan = JSON.parse(movedGitPlanRow!.record_json) as StoredGitInstallPlan;
  expect(movedGitPlan.sourceId).toBe(moved!.sourceId);
  expect(movedGitPlan.preflight?.sourceSnapshotId).toBe(copiedSnapshots[0]?.id);
  expect(movedGitPlan.compatibilityCheckRunId).not.toBe(compatibilityRun.id);
  expect(movedGitPlan.preflight?.compatibilityCheckRunId).toBe(movedGitPlan.compatibilityCheckRunId);
  const movedCheck = await store.getCompatibilityCheckRun(movedGitPlan.compatibilityCheckRunId!);
  expect(movedCheck?.sourceId).toBe(moved!.sourceId);
  expect(movedCheck?.capsuleId).toBe("cap_b");
  expect(movedCheck?.sourceSnapshotId).toBe(copiedSnapshots[0]?.id);
  expect(movedCheck?.compatibilityReportId).toBe(movedReport?.id);
  const oldCheck = await db.prepare("select installation_id, run_json from runs where id = ?")
    .bind(compatibilityRun.id).first<{ installation_id: string | null; run_json: string }>();
  expect(oldCheck?.installation_id).toBeNull();
  expect((JSON.parse(oldCheck!.run_json) as Run).capsuleId).toBeUndefined();
  const movedLegacyRow = await db.prepare("select record_json from git_install_plans where id = ?")
    .bind(legacyRevision.id).first<{ record_json: string }>();
  expect((JSON.parse(movedLegacyRow!.record_json) as StoredGitInstallPlan).sourceId).toBe(moved!.sourceId);
});

test("D1 split clones a Capsule InstallConfig and repoints its Snapshot provenance", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a", "cap_b"]);
  const archiveRef = `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_config/source.tar.zst`;
  await store.putSourceSyncRun({ id: "ssr_config", kind: "source_sync", workspaceId, sourceId, url,
    ref: "main", path: ".", archiveRef, status: "succeeded", snapshotId: "snap_config",
    createdAt: t0, updatedAt: t0 });
  await store.putSourceSnapshot({ id: "snap_config", origin: "git", workspaceId, sourceId, url,
    ref: "main", path: ".", resolvedCommit: "a".repeat(40), archiveRef,
    archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 1,
    fetchedByRunId: "ssr_config", fetchedAt: t0 });
  const config = { id: "cfg_cap_b", workspaceId, name: "config b",
    internal: { reason: "per_install_overrides", sourceSnapshotId: "snap_config" },
    workspaceManagementAuthority: { workspaceId, managementState: "active", managementEpoch: 1 },
    createdAt: t0, updatedAt: t0 };
  await db.prepare(`update install_configs set record_json = ? where id = ?`)
    .bind(JSON.stringify(config), config.id).run();
  const [result] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => {} }, { apply: true, now: "2026-10-28T00:00:00.000Z" });
  expect(result?.status).toBe("committed");
  const moved = (await store.getCapsule("cap_b"))!;
  expect(moved.installConfigId).not.toBe(config.id);
  const newRow = await db.prepare("select record_json from install_configs where id = ?")
    .bind(moved.installConfigId).first<{ record_json: string }>();
  const movedSnapshotId = JSON.parse(newRow!.record_json).internal.sourceSnapshotId as string;
  expect(movedSnapshotId).not.toBe("snap_config");
  expect((await store.getSourceSnapshot(movedSnapshotId))?.sourceId).toBe(moved.sourceId);
  expect((await store.listSourceSnapshots(moved.sourceId))[0]?.id).toBe(movedSnapshotId);
  expect(JSON.parse(newRow!.record_json).workspaceManagementAuthority)
    .toEqual(config.workspaceManagementAuthority);
  const movedPhysical = await db.prepare("select install_config_id from capsules where id = ?")
    .bind(moved.id).first<{ install_config_id: string }>();
  expect(movedPhysical?.install_config_id).toBe(moved.installConfigId);
  expect((await db.prepare("select record_json from install_configs where id = ?")
    .bind(config.id).first<{ record_json: string }>())?.record_json).toBe(JSON.stringify(config));
  const retainedGroup = await store.readGroup(sourceId);
  const movedGroup = await store.readGroup(moved.sourceId);
  expect(inventorySourceOwnershipGroup(retainedGroup!).action).toBe("none");
  expect(inventorySourceOwnershipGroup(movedGroup!).action).toBe("none");
  const dryRunCopier = { copyVerified: async () => { throw new Error("unexpected retry copy"); } };
  expect((await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    dryRunCopier, { sourceId }))[0]?.status).toBe("unchanged");
  expect((await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    dryRunCopier, { sourceId: moved.sourceId }))[0]?.status).toBe("unchanged");
});

test("D1 split releases the old report's moved Capsule association", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a", "cap_b"]);
  const archiveRef = `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_report/source.tar.zst`;
  await store.putSourceSyncRun({ id: "ssr_report", kind: "source_sync", workspaceId, sourceId, url,
    ref: "main", path: ".", archiveRef, status: "succeeded", snapshotId: "snap_report",
    createdAt: t0, updatedAt: t0 });
  await store.putSourceSnapshot({ id: "snap_report", origin: "git", workspaceId, sourceId, url,
    ref: "main", path: ".", resolvedCommit: "a".repeat(40), archiveRef,
    archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 1,
    fetchedByRunId: "ssr_report", fetchedAt: t0 });
  await store.putCapsuleCompatibilityReport({ id: "report_bound", sourceId, capsuleId: "cap_b",
    sourceSnapshotId: "snap_report", modulePath: ".", level: "ready", findings: [],
    providerPackages: [], rootProviderRequirements: [], resources: [], dataSources: [],
    provisioners: [], createdAt: t0 });
  await store.putCompatibilityCheckRun({ id: "check_bound", workspaceId, sourceId,
    capsuleId: "cap_b", type: "compatibility_check", status: "succeeded",
    sourceSnapshotId: "snap_report", compatibilityReportId: "report_bound" });
  const observed = await store.readGroup(sourceId);
  const prepared = await prepareSourceOwnershipMigration(observed!, new ObjectKeyArtifactReferenceAllocator(),
    "2026-10-28T00:00:00.000Z");
  expect(prepared?.retainedReports).toHaveLength(1);
  expect(prepared?.retainedCompatibilityRuns).toHaveLength(1);
  await expect(store.commitGroup({ ...prepared!, retainedReports:
    prepared!.retainedReports.map((report) => ({ ...report, sourceSnapshotId: "wrong_snapshot" })) }))
    .rejects.toThrow("retained report mismatch");
  await expect(store.commitGroup({ ...prepared!, retainedCompatibilityRuns:
    prepared!.retainedCompatibilityRuns.map((run) => ({ ...run, status: "failed" as const })) }))
    .rejects.toThrow("retained CompatibilityRun mismatch");
  expect((await store.getCapsule("cap_b"))?.sourceId).toBe(sourceId);
  const [result] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => {} }, { apply: true, now: "2026-10-28T00:00:00.000Z" });
  expect(result?.status).toBe("committed");
  const old = await db.prepare("select installation_id from capsule_compatibility_reports where id = ?")
    .bind("report_bound").first<{ installation_id: string | null }>();
  expect(old?.installation_id).toBeNull();
  const movedSourceId = (await store.getCapsule("cap_b"))!.sourceId;
  const oldGroup = await store.readGroup(sourceId);
  const newGroup = await store.readGroup(movedSourceId);
  const copiedReport = newGroup?.reports.find((report) => report.id !== "report_bound");
  const copiedCheck = newGroup?.compatibilityRuns.find((run) => run.id !== "check_bound");
  expect(copiedReport?.sourceId).toBe(movedSourceId);
  expect(copiedReport?.capsuleId).toBe("cap_b");
  expect(copiedCheck?.sourceId).toBe(movedSourceId);
  expect(copiedCheck?.capsuleId).toBe("cap_b");
  expect(copiedCheck?.compatibilityReportId).toBe(copiedReport?.id);
  const oldCheck = await db.prepare("select installation_id, run_json from runs where id = ?")
    .bind("check_bound").first<{ installation_id: string | null; run_json: string }>();
  expect(oldCheck?.installation_id).toBeNull();
  expect((JSON.parse(oldCheck!.run_json) as Run).capsuleId).toBeUndefined();
  expect(inventorySourceOwnershipGroup(oldGroup!).action).toBe("none");
  expect(inventorySourceOwnershipGroup(newGroup!).action).toBe("none");
});

/** `providers_json` exactly as releases before the two-layer graph stored it. */
const RETIRED_FLAT_PROVIDERS = [
  { source: "registry.opentofu.org/cloudflare/cloudflare", localName: "cloudflare",
    versionConstraint: "~> 4.0", aliases: ["zone"], allowed: true, credentialRequired: true },
  { source: "registry.opentofu.org/hashicorp/random", aliases: [], allowed: true },
];

async function seedD1Snapshot(store: CloudflareD1OpenTofuControlStore, owner: string, id: string) {
  const archiveRef = `workspaces/${workspaceId}/sources/${owner}/snapshots/${id}/source.tar.zst`;
  await store.putSourceSyncRun({ id: `ssr_${id}`, kind: "source_sync", workspaceId, sourceId: owner, url,
    ref: "main", path: ".", archiveRef, status: "succeeded", snapshotId: id, createdAt: t0, updatedAt: t0 });
  await store.putSourceSnapshot({ id, origin: "git", workspaceId, sourceId: owner, url,
    ref: "main", path: ".", resolvedCommit: "a".repeat(40), archiveRef,
    archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 1, fetchedByRunId: `ssr_${id}`, fetchedAt: t0 });
}

/** Physical row as an older release wrote it; never goes through the current report writer. */
async function insertStoredD1Report(db: InterleavedD1, row: { readonly id: string; readonly sourceId: string;
  readonly capsuleId?: string; readonly sourceSnapshotId: string; readonly providersJson: string }) {
  await db.prepare(`insert into capsule_compatibility_reports
    (id, source_id, installation_id, source_snapshot_id, module_path, level, findings_json,
     providers_json, resources_json, data_sources_json, provisioners_json,
     root_module_variables_json, root_module_variable_declarations_json, root_module_outputs_json, created_at)
    values (?, ?, ?, ?, '.', 'ready', ?, ?, '[]', '[]', '[]', '["region"]', null, '[]', ?)`)
    .bind(row.id, row.sourceId, row.capsuleId ?? null, row.sourceSnapshotId,
      JSON.stringify([{ severity: "warning", code: "legacy_finding" }]), row.providersJson,
      "2026-07-01T00:00:00.000Z").run();
}

async function physicalD1Reports(db: InterleavedD1) {
  return (await db.prepare("select * from capsule_compatibility_reports order by id")
    .all<Record<string, string | null>>()).results ?? [];
}

test("D1 split moves retired flat compatibility reports with their exact stored text", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a", "cap_b"]);
  await seedD1Snapshot(store, sourceId, "snap_legacy");
  // Non-canonical spacing proves the copy is the stored text, not a re-encoding.
  const legacyText = JSON.stringify(RETIRED_FLAT_PROVIDERS, null, 1);
  await insertStoredD1Report(db, { id: "report_legacy_bound", sourceId, capsuleId: "cap_b",
    sourceSnapshotId: "snap_legacy", providersJson: legacyText });
  await insertStoredD1Report(db, { id: "report_legacy_empty", sourceId,
    sourceSnapshotId: "snap_legacy", providersJson: "[]" });
  await store.putCompatibilityCheckRun({ id: "check_legacy", workspaceId, sourceId, capsuleId: "cap_b",
    type: "compatibility_check", status: "succeeded", sourceSnapshotId: "snap_legacy",
    compatibilityReportId: "report_legacy_bound" });
  // The ordinary reader keeps refusing the retired shape (the staging failure).
  await expect(store.getCapsuleCompatibilityReport("report_legacy_bound")).rejects.toThrow(/must be an object/);
  const before = await physicalD1Reports(db);
  const now = "2026-10-28T00:00:00.000Z";
  const [dry] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { throw new Error("dry-run copied archive"); } }, { now });
  expect(dry).toMatchObject({ status: "dry_run", inventory: { action: "split", splitCapsuleIds: ["cap_b"] } });
  const [applied] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => {} }, { apply: true, now });
  expect(applied?.status).toBe("committed");
  expect(applied?.planDigest).toBe(dry?.planDigest);
  const movedSourceId = (await store.getCapsule("cap_b"))!.sourceId;
  const movedGroup = (await store.readGroup(movedSourceId))!;
  const after = await physicalD1Reports(db);
  const originalBound = before.find((row) => row.id === "report_legacy_bound")!;
  const copy = after.find((row) => row.source_id === movedSourceId)!;
  expect(after).toHaveLength(3);
  expect(after.find((row) => row.id === "report_legacy_bound")).toEqual({ ...originalBound, installation_id: null });
  expect(after.find((row) => row.id === "report_legacy_empty"))
    .toEqual(before.find((row) => row.id === "report_legacy_empty"));
  expect(copy).toEqual({ ...originalBound, id: copy.id, source_id: movedSourceId,
    source_snapshot_id: movedGroup.snapshots[0]!.id });
  expect(copy.providers_json).toBe(legacyText);
  expect(movedGroup.compatibilityRuns[0]?.compatibilityReportId).toBe(copy.id);
  await expect(store.getCapsuleCompatibilityReport(String(copy.id))).rejects.toThrow(/must be an object/);
  expect((await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { throw new Error("unexpected retry copy"); } }))
    .map((result) => [result.inventory.sourceId, result.status]).sort())
    .toEqual([[movedSourceId, "unchanged"], [sourceId, "unchanged"]].sort());
});

test("D1 migration blocks only the group holding an unreadable compatibility report", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, []);
  await seedD1Snapshot(store, sourceId, "snap_retire");
  await insertStoredD1Report(db, { id: "report_retire", sourceId, sourceSnapshotId: "snap_retire",
    providersJson: JSON.stringify(RETIRED_FLAT_PROVIDERS) });
  const damagedId = "src_damaged_d1";
  await store.putSource({ ...(await store.getSource(sourceId))!, id: damagedId, name: "damaged" });
  await seedD1Snapshot(store, damagedId, "snap_damaged");
  await insertStoredD1Report(db, { id: "report_damaged", sourceId: damagedId,
    sourceSnapshotId: "snap_damaged", providersJson: "[{\"source\":" });
  await expect(store.readGroup(damagedId))
    .rejects.toThrow("source_ownership_migration_compatibility_report_unreadable:report_damaged");
  const now = "2026-10-28T00:00:00.000Z";
  const results = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { throw new Error("unexpected copy"); } }, { apply: true, now });
  expect(results.map((result) => [result.inventory.sourceId, result.status, result.inventory.action,
    result.inventory.reason])).toEqual([
    [damagedId, "blocked", "blocked", "source_ownership_migration_compatibility_report_unreadable"],
    [sourceId, "committed", "retire", undefined]]);
  expect((await store.getSource(sourceId))?.retiringAt).toBe(now);
  expect((await store.getSource(damagedId))?.retiringAt).toBeUndefined();
});

test("D1 normalizes a foreign archive reference on an already owned Source", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"], "cap_a");
  const foreignRef = `workspaces/${workspaceId}/sources/legacy/snapshots/snap_old/source.tar.zst`;
  await store.putSourceSyncRun({ id: "ssr_old", kind: "source_sync", workspaceId, sourceId, url,
    ref: "main", path: ".", archiveRef: foreignRef, status: "succeeded", snapshotId: "snap_old",
    createdAt: t0, updatedAt: t0 });
  await store.putSourceSnapshot({ id: "snap_old", origin: "git", workspaceId, sourceId, url,
    ref: "main", path: ".", resolvedCommit: "a".repeat(40), archiveRef: foreignRef,
    archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 20,
    fetchedByRunId: "ssr_old", fetchedAt: t0 });
  let copied = 0;
  const result = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { copied++; } }, { apply: true, now: "2026-10-28T00:00:00.000Z" });
  expect(result[0]?.inventory.action).toBe("normalize");
  expect(result[0]?.status).toBe("committed");
  expect(copied).toBe(1);
  const normalized = await store.getSourceSnapshot("snap_old");
  expect(normalized?.archiveRef).toContain(`/sources/${sourceId}/`);
  expect((await store.getSourceSyncRun("ssr_old"))?.archiveRef).toBe(normalized?.archiveRef);
});

test("D1 inventory blocks a Plan waiting for approval", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  await store.putPlanRun({ id: "plan_waiting", workspaceId, capsuleId: "cap_a",
    status: "waiting_approval", operation: "apply", sourceDigest: "digest",
    variablesDigest: "digest", source: { kind: "git", url, ref: "main" } } as unknown as PlanRun);
  const [result] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { throw new Error("unexpected copy"); } });
  expect(result?.status).toBe("blocked");
  expect(result?.inventory.inFlightRunIds).toEqual(["plan_waiting"]);
});

test("D1 classifies a projected drift Run separately from PlanRun and blocks active drift", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  for (const [id, status] of [["drift_done", "succeeded"], ["drift_active", "queued"]] as const) {
    await db.prepare(`insert into runs
      (id, space_id, installation_id, type, status, run_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, workspaceId, "cap_a", "drift_check", status,
        JSON.stringify({ id, workspaceId, capsuleId: "cap_a", type: "drift_check", status }), t0).run();
  }
  const group = await store.readGroup(sourceId);
  expect(group?.planRuns).toHaveLength(0);
  expect(group?.inFlightRunIds).toEqual(["drift_active"]);
  const [result] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { throw new Error("unexpected copy"); } });
  expect(result?.status).toBe("blocked");
});

test("D1 inventory blocks a terminal Git plan while its physical lease remains held", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  const plan = { id: "install_leased", workspaceId, actorSubject: "account:owner_migration_d1",
    idempotencyKeyHash: "lease_hash", requestDigest: "digest", createdBy: "owner_migration_d1",
    source: { name: "repo", url, ref: "main", path: "." },
    capsule: { name: "cap_a", environment: "production" }, options: {},
    capsuleId: "cap_a", phase: "reviewable", generation: 1,
    createdAt: t0, updatedAt: t0 } as StoredGitInstallPlan;
  await db.prepare(`insert into git_install_plans
    (id, workspace_id, actor_subject, idempotency_key_hash, request_digest,
      phase, generation, record_json, reconcile_lease_token, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(plan.id, plan.workspaceId, plan.actorSubject, plan.idempotencyKeyHash,
      plan.requestDigest, plan.phase, plan.generation, JSON.stringify(plan), "held_lease",
      plan.createdAt, plan.updatedAt).run();
  const [result] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { throw new Error("unexpected copy"); } });
  expect(result?.status).toBe("blocked");
  expect(result?.inventory.inFlightRunIds).toEqual(["git_install_plan:install_leased"]);
});

test("D1 refuses historical source-scoped RunGroup links before split", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a", "cap_b"]);
  await store.putSourceSyncRun({ id: "ssr_grouped", kind: "source_sync", workspaceId, sourceId, url,
    ref: "main", path: ".", archiveRef: "archive", status: "succeeded",
    createdAt: t0, updatedAt: t0 });
  await store.putCompatibilityCheckRun({ id: "check_grouped", workspaceId, sourceId,
    type: "compatibility_check", status: "succeeded" });
  await db.prepare("update runs set run_group_id = ? where id in (?, ?)")
    .bind("group_historical", "ssr_grouped", "check_grouped").run();
  const [result] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { throw new Error("unexpected copy"); } });
  expect(result?.status).toBe("blocked");
  expect(result?.inventory.inFlightRunIds).toEqual([
    "run_group:check_grouped", "run_group:ssr_grouped",
  ]);
  expect((await store.getCapsule("cap_b"))?.sourceId).toBe(sourceId);
});

test("D1 dry-run inventories 1,201 snapshots through bounded keyset pages", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  const snapshots = Array.from({ length: 1_201 }, (_, index) => {
    const id = `snap_page_${String(index).padStart(4, "0")}`;
    const snapshot: SourceSnapshot = { id, origin: "git", workspaceId, sourceId, url,
      ref: "main", path: ".", resolvedCommit: "a".repeat(40),
      archiveRef: `workspaces/${workspaceId}/sources/${sourceId}/snapshots/${id}/source.tar.zst`,
      archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 1,
      fetchedByRunId: "ssr_historical", fetchedAt: t0 };
    return db.prepare(`insert into source_snapshots (id, source_id, record_json, fetched_at)
      values (?, ?, ?, ?)`).bind(id, sourceId, JSON.stringify(snapshot), t0);
  });
  await db.batch(snapshots);
  expect((await store.readGroup(sourceId))?.snapshots).toHaveLength(1_201);
  const [result] = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => { throw new Error("dry-run copied archive"); } });
  expect(result?.status).toBe("dry_run");
  expect(result?.inventory.snapshotCount).toBe(1_201);
});

test("D1 refuses an oversized physical guard bound before any mutation", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  const snapshot: SourceSnapshot = { id: "snap_large", origin: "git", workspaceId, sourceId, url,
    ref: "main", path: ".", resolvedCommit: "a".repeat(40),
    archiveRef: `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_large/source.tar.zst`,
    archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 1,
    fetchedByRunId: "ssr_old", fetchedAt: t0,
    // The stored JSON row fits D1, but JSON-encoding that row again for the
    // exact batch guard exceeds one 2 MB bound value.
    legacyMetadata: "\\".repeat(900_000) } as SourceSnapshot;
  await db.prepare(`insert into source_snapshots (id, source_id, record_json, fetched_at)
    values (?, ?, ?, ?)`).bind(snapshot.id, sourceId, JSON.stringify(snapshot), t0).run();
  const group = await store.readGroup(sourceId);
  const mutation = await prepareSourceOwnershipMigration(group!, new ObjectKeyArtifactReferenceAllocator(), t0);
  await expect(store.commitGroup(mutation!)).rejects.toThrow(
    "source_snapshots:snap_large guard needs",
  );
  expect((await store.getSource(sourceId))?.ownerCapsuleId).toBeUndefined();
});

test("D1 rolls back the whole migration when the observed Source changes before batch", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  const group = await store.readGroup(sourceId);
  expect(group).toBeDefined();
  const mutation = await prepareSourceOwnershipMigration(group!, new ObjectKeyArtifactReferenceAllocator(),
    "2026-10-28T00:00:00.000Z");
  expect(mutation?.action).toBe("backfill");
  db.beforeNextBatch = async () => {
    const changed = { ...group!.source, name: "changed", updatedAt: "2026-10-28T00:00:01.000Z" };
    await db.prepare("update sources set record_json = ?, updated_at = ? where id = ?")
      .bind(JSON.stringify(changed), changed.updatedAt, sourceId).run();
  };
  expect(await store.commitGroup(mutation!)).toBe("conflict");
  expect((await store.getSource(sourceId))?.name).toBe("changed");
  expect((await store.getSource(sourceId))?.ownerCapsuleId).toBeUndefined();
  expect((await store.getCapsule("cap_a"))?.sourceId).toBe(sourceId);
});

test("D1 conflicts when private InstallConfig authority changes after inventory", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  const group = await store.readGroup(sourceId);
  const mutation = await prepareSourceOwnershipMigration(group!, new ObjectKeyArtifactReferenceAllocator(), t0);
  db.beforeNextBatch = async () => {
    const before = group!.installConfigs.find((config) => config.id === "cfg_cap_a")!;
    const changed = { ...before, workspaceManagementAuthority: {
      workspaceId, managementState: "active", managementEpoch: 77 } };
    await db.prepare("update install_configs set record_json = ? where id = ?")
      .bind(JSON.stringify(changed), changed.id).run();
  };
  expect(await store.commitGroup(mutation!)).toBe("conflict");
  expect((await store.getSource(sourceId))?.ownerCapsuleId).toBeUndefined();
  const configRow = await db.prepare("select record_json from install_configs where id = ?")
    .bind("cfg_cap_a").first<{ record_json: string }>();
  expect(JSON.parse(configRow!.record_json).workspaceManagementAuthority.managementEpoch).toBe(77);
});

test("D1 inventory rejects Capsule JSON and physical InstallConfig identity drift", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  await db.prepare("update capsules set install_config_id = ? where id = ?")
    .bind("cfg_wrong", "cap_a").run();
  await expect(store.readGroup(sourceId)).rejects.toThrow("Capsule scope mismatch: cap_a");
  expect((await store.getSource(sourceId))?.ownerCapsuleId).toBeUndefined();
});

test("operator dry-run response does not expose private InstallConfig authority", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, ["cap_a"]);
  const config = { id: "cfg_cap_a", workspaceId, name: "config cap_a", createdAt: t0,
    updatedAt: t0, workspaceManagementAuthority: { workspaceId,
      managementState: "active", managementEpoch: 77 }, privateMarker: "private_authority_do_not_expose" };
  await db.prepare("update install_configs set record_json = ? where id = ?")
    .bind(JSON.stringify(config), config.id).run();
  const env = { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator_token", TAKOSUMI_CONTROL_DB: db } as
    unknown as CloudflareWorkerEnv;
  const request = new Request(`https://example.test${SOURCE_OWNERSHIP_MIGRATION_PATH}?sourceId=${sourceId}`,
    { headers: { authorization: "Bearer operator_token" } });
  const response = await handleSourceOwnershipMigrationOperatorRequest(request, env, { store });
  expect(response?.status).toBe(200);
  const body = await response!.text();
  expect(body).not.toContain("workspaceManagementAuthority");
  expect(body).not.toContain("private_authority_do_not_expose");
  expect(JSON.parse(body).results[0].status).toBe("dry_run");
});

test("D1 inventory hydrates and fences a lost-ack creator by its immutable Source marker", async () => {
  const db = new InterleavedD1();
  const store = await fixture(db, []);
  const now = "2026-10-28T00:00:00.000Z";
  const planId = "git_lost_ack_creator";
  const reservedId = deterministicInstallSourceId(planId);
  await store.putSource({ ...(await store.getSource(sourceId))!, id: reservedId,
    ownerCapsuleId: deterministicInitialCapsuleId(planId), createdByInstallPlanId: planId });
  const creator: StoredGitInstallPlan = { id: planId, workspaceId, createdBy: "user_one",
    actorSubject: "user_one", idempotencyKeyHash: "lost_ack", requestDigest: "lost_ack",
    source: { name: "repo", url, ref: "main", path: "." }, capsule: { name: "new", environment: "production" },
    options: {}, mode: "attempt", phase: "awaiting_input", generation: 0,
    expiresAt: "2026-10-29T00:00:00.000Z", createdAt: t0, updatedAt: t0 };
  const insert = (plan: StoredGitInstallPlan) => db.prepare(`insert into git_install_plans
    (id, workspace_id, actor_subject, idempotency_key_hash, request_digest, phase, generation, record_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(plan.id, plan.workspaceId, plan.actorSubject,
      plan.idempotencyKeyHash, plan.requestDigest, plan.phase, plan.generation, JSON.stringify(plan), plan.createdAt, plan.updatedAt).run();
  await insert(creator);
  let group = (await store.readGroup(reservedId))!;
  expect(group.gitPlans.map((plan) => plan.id)).toEqual([planId]);
  expect(inventorySourceOwnershipGroup(group, now).action).toBe("blocked");
  const expired = { ...creator, expiresAt: "2026-10-26T00:00:00.000Z" };
  await db.prepare("update git_install_plans set record_json = ? where id = ?").bind(JSON.stringify(expired), planId).run();
  expect(inventorySourceOwnershipGroup((await store.readGroup(reservedId))!, now).action).toBe("retire");
  await db.prepare("update git_install_plans set reconcile_lease_token = 'fixture_lease' where id = ?").bind(planId).run();
  expect(inventorySourceOwnershipGroup((await store.readGroup(reservedId))!, now))
    .toMatchObject({ action: "blocked", reason: "work_in_flight" });
  await db.prepare("update git_install_plans set reconcile_lease_token = null where id = ?").bind(planId).run();
  const recent = { ...creator, phase: "discarded" as const, completedAt: now };
  await db.prepare("update git_install_plans set phase = ?, record_json = ? where id = ?")
    .bind(recent.phase, JSON.stringify(recent), planId).run();
  group = (await store.readGroup(reservedId))!;
  expect(inventorySourceOwnershipGroup(group, now)).toMatchObject({ action: "blocked", reason: "source_creator_plan_still_active" });
  await db.prepare("delete from git_install_plans where id = ?").bind(planId).run();
  group = (await store.readGroup(reservedId))!;
  const mutation = (await prepareSourceOwnershipMigration(group, new ObjectKeyArtifactReferenceAllocator(), now))!;
  db.beforeNextBatch = async () => { await insert(creator); };
  expect(await store.commitGroup(mutation)).toBe("conflict");
  expect((await store.getSource(reservedId))?.status).toBe("active");
});
