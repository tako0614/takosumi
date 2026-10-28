import { expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type { StoredGitInstallPlan } from "../../../core/domains/install-plans/store.ts";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { D1PreparedStatement, D1Result } from "../../../worker/src/bindings.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { migrateSourceOwnership, prepareSourceOwnershipMigration } from
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
  const compatibilityRun: Run = { id: "check_old", workspaceId, sourceId,
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
    sourceId: undefined, sourceSyncRunId: undefined, sourceSnapshotId: undefined,
    compatibilityReportId: undefined, compatibilityCheckRunId: undefined,
    preflight: undefined } as StoredGitInstallPlan;
  await db.prepare(`insert into git_install_plans
    (id, workspace_id, actor_subject, idempotency_key_hash, request_digest,
      phase, generation, record_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(legacyRevision.id, legacyRevision.workspaceId, legacyRevision.actorSubject,
      legacyRevision.idempotencyKeyHash, legacyRevision.requestDigest,
      legacyRevision.phase, legacyRevision.generation, JSON.stringify(legacyRevision),
      legacyRevision.createdAt, legacyRevision.updatedAt).run();
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
  expect(movedCheck?.sourceSnapshotId).toBe(copiedSnapshots[0]?.id);
  expect(movedCheck?.compatibilityReportId).toBe(movedReport?.id);
  const movedLegacyRow = await db.prepare("select record_json from git_install_plans where id = ?")
    .bind(legacyRevision.id).first<{ record_json: string }>();
  expect((JSON.parse(movedLegacyRow!.record_json) as StoredGitInstallPlan).sourceId).toBe(moved!.sourceId);
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
