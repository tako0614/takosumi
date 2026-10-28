import { describe, expect, test } from "bun:test";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule, CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { Run } from "takosumi-contract/runs";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type { StoredInstallConfig, StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import type { StoredGitInstallPlan } from "../../../../core/domains/install-plans/store.ts";
import { inventorySourceOwnershipGroup, migrateSourceOwnership, prepareSourceOwnershipMigration,
  type SourceOwnershipMigrationGroup, type SourceOwnershipMigrationMutation,
  type SourceOwnershipMigrationStore } from "../../../../core/domains/sources/ownership-migration.ts";

const allocator = new ObjectKeyArtifactReferenceAllocator();

function source(id: string, ownerCapsuleId?: string): StoredSource {
  return { id, workspaceId: "ws_1", ownerCapsuleId, name: id, url: "https://example.test/repo.git",
    defaultRef: "main", defaultPath: ".", status: "active", autoSync: true,
    hookSecretHash: "a".repeat(64), createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
}

function capsule(id: string, sourceId: string, status: Capsule["status"] = "active", compatibilityReportId?: string): Capsule {
  return { id, workspaceId: "ws_1", projectId: "prj_1", name: id, slug: id, sourceId,
    installConfigId: `cfg_${id}`, environment: "production", currentStateGeneration: 0,
    status, compatibilityReportId, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
}

function snapshot(id: string, sourceId: string, fetchedByRunId: string, ref = "main"): SourceSnapshot {
  return { id, origin: "git", workspaceId: "ws_1", sourceId, url: "https://example.test/repo.git",
    ref, path: ".", resolvedCommit: "abc123", archiveRef: `workspaces/ws_1/sources/${sourceId}/snapshots/${id}/source.tar.zst`,
    archiveDigest: "sha256:abc", archiveSizeBytes: 42, fetchedByRunId,
    fetchedAt: "2026-10-01T00:00:00.000Z" };
}

function syncRun(id: string, sourceId: string, snapshotId: string, ref = "main"): SourceSyncRun {
  return { id, kind: "source_sync", workspaceId: "ws_1", sourceId, url: "https://example.test/repo.git",
    ref, path: ".", archiveRef: `workspaces/ws_1/sources/${sourceId}/snapshots/${snapshotId}/source.tar.zst`,
    status: "succeeded", snapshotId, createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z" };
}

function compatibilityRun(id: string, sourceId: string, snapshotId: string, reportId: string): Run {
  return { id, workspaceId: "ws_1", sourceId, sourceSnapshotId: snapshotId,
    compatibilityReportId: reportId, type: "compatibility_check", status: "succeeded",
    createdBy: "operator", createdAt: "2026-10-01T00:00:00.000Z" } as Run;
}

function plan(id: string, capsuleId: string, snapshotId: string, reportId?: string): PlanRun {
  return { id, workspaceId: "ws_1", capsuleId, sourceSnapshotId: snapshotId,
    source: { kind: "git", url: "https://example.test/repo.git", ref: "main", commit: "abc123" },
    compatibilityReportId: reportId, status: "succeeded" } as unknown as PlanRun;
}

function report(id: string, sourceId: string, snapshotId: string): CapsuleCompatibilityReport {
  return { id, sourceId, sourceSnapshotId: snapshotId, level: "ready", findings: [], providerPackages: [],
    rootProviderRequirements: [], resources: [], dataSources: [], provisioners: [],
    createdAt: "2026-10-01T00:00:00.000Z" };
}

function gitPlan(id: string, capsuleId: string, sourceId: string, snapshotId: string,
  syncRunId: string, reportId: string): StoredGitInstallPlan {
  return { id, capsuleId, sourceId, sourceSnapshotId: snapshotId, sourceSyncRunId: syncRunId,
    compatibilityCheckRunId: "check_1",
    compatibilityReportId: reportId,
    preflight: { sourceId, sourceSnapshotId: snapshotId, compatibilityReportId: reportId,
      compatibilityCheckRunId: "check_1", installConfigId: "cfg_1" },
    phase: "reviewable" } as unknown as StoredGitInstallPlan;
}

function group(id: string, capsuleStates: readonly [string, Capsule["status"]][], ownerCapsuleId?: string): SourceOwnershipMigrationGroup {
  return { source: source(id, ownerCapsuleId),
    capsules: capsuleStates.map(([capsuleId, status]) => ({ capsule: capsule(capsuleId, id, status) })),
    snapshots: [], syncRuns: [], compatibilityRuns: [], planRuns: [], reports: [], gitPlans: [],
    installConfigs: capsuleStates.map(([capsuleId]) => ({ id: `cfg_${capsuleId}`, workspaceId: "ws_1",
      name: capsuleId, variableMapping: {} } satisfies StoredInstallConfig)), inFlightRunIds: [] };
}

class FixtureStore implements SourceOwnershipMigrationStore {
  readonly groups = new Map<string, SourceOwnershipMigrationGroup>();
  commits = 0;
  listSourceIds(): Promise<readonly string[]> { return Promise.resolve([...this.groups.keys()]); }
  readGroup(id: string): Promise<SourceOwnershipMigrationGroup | undefined> { return Promise.resolve(this.groups.get(id)); }
  commitGroup(mutation: SourceOwnershipMigrationMutation): Promise<"committed" | "conflict"> {
    const current = this.groups.get(mutation.sourceId);
    if (JSON.stringify(current) !== JSON.stringify(mutation.expected)) return Promise.resolve("conflict");
    this.commits++;
    const retainedSnapshotMap = new Map(mutation.retainedSnapshots.map((snapshot) => [snapshot.id, snapshot]));
    const retainedSyncRunMap = new Map(mutation.retainedSyncRuns.map((run) => [run.id, run]));
    const retainedCompatibilityRunMap = new Map(mutation.retainedCompatibilityRuns.map((run) => [run.id, run]));
    const retainedReportMap = new Map(mutation.retainedReports.map((report) => [report.id, report]));
    this.groups.set(mutation.sourceId, { ...current, source: mutation.retainedSource,
      snapshots: current?.snapshots.map((snapshot) => retainedSnapshotMap.get(snapshot.id) ?? snapshot) ?? [],
      syncRuns: current?.syncRuns.map((run) => retainedSyncRunMap.get(run.id) ?? run) ?? [],
      compatibilityRuns: current?.compatibilityRuns.map((run) => retainedCompatibilityRunMap.get(run.id) ?? run) ?? [],
      reports: current?.reports.map((report) => retainedReportMap.get(report.id) ?? report) ?? [] } as SourceOwnershipMigrationGroup);
    for (const split of mutation.splits) {
      this.groups.set(split.source.id, { source: split.source,
        capsules: [{ capsule: split.capsule }], snapshots: split.snapshots,
        syncRuns: split.syncRuns, compatibilityRuns: split.compatibilityRuns,
        planRuns: split.planRuns, reports: split.reports,
        gitPlans: split.gitPlans, installConfigs: [
          ...split.installConfigs.map(({ config }) => config),
          ...current?.installConfigs.filter((config) => config.id === split.capsule.installConfigId) ?? [],
        ], inFlightRunIds: [] });
    }
    if (mutation.splits.length > 0 && current) {
      const moved = new Set(mutation.splits.map((split) => split.capsuleId));
      const retained = this.groups.get(mutation.sourceId)!;
      this.groups.set(mutation.sourceId, { ...retained,
        capsules: retained.capsules.filter(({ capsule }) => !moved.has(capsule.id)),
        planRuns: retained.planRuns.filter((plan) => !plan.capsuleId || !moved.has(plan.capsuleId)),
        gitPlans: retained.gitPlans.filter((plan) => !plan.capsuleId || !moved.has(plan.capsuleId)) });
    }
    return Promise.resolve("committed");
  }
}

describe("operator Source ownership migration", () => {
  test("inventories exclusive, live plus destroyed, all destroyed, and orphan without writing", async () => {
    const store = new FixtureStore();
    store.groups.set("src_exclusive", group("src_exclusive", [["cap_live", "active"]]));
    store.groups.set("src_mixed", group("src_mixed", [["cap_live", "active"], ["cap_old", "destroyed"]]));
    store.groups.set("src_destroyed", group("src_destroyed", [["cap_old", "destroyed"]]));
    store.groups.set("src_orphan", group("src_orphan", []));
    let copied = 0;
    const results = await migrateSourceOwnership(store, allocator, { copyVerified: async () => { copied++; } });
    expect(Object.fromEntries(results.map((result) => [result.inventory.sourceId, result.inventory.action]))).toEqual({
      src_destroyed: "retire", src_exclusive: "backfill", src_mixed: "backfill", src_orphan: "retire" });
    expect(results.every((result) => result.status === "dry_run")).toBe(true);
    expect(store.commits).toBe(0);
    expect(copied).toBe(0);
    const applied = await migrateSourceOwnership(store, allocator, { copyVerified: async () => { copied++; } }, { apply: true });
    expect(applied.every((result) => result.status === "committed")).toBe(true);
    expect(store.groups.get("src_mixed")?.source.ownerCapsuleId).toBe("cap_live");
    expect(store.groups.get("src_destroyed")?.source.retiringAt).toBeDefined();
    expect(store.groups.get("src_orphan")?.source.autoSync).toBe(false);
    expect((await migrateSourceOwnership(store, allocator, { copyVerified: async () => { copied++; } })).every(
      (result) => result.status === "unchanged")).toBe(true);
  });

  test("shared live apps split with only the moved app's Plan and report repointed", async () => {
    const original = group("src_shared", [["cap_a", "active"], ["cap_b", "active"]]);
    const snap = snapshot("snap_shared", "src_shared", "ssr_shared");
    const originalWithData: SourceOwnershipMigrationGroup = { ...original,
      capsules: [
        { capsule: capsule("cap_a", "src_shared", "active", "cgr_shared"), adoptedSnapshotId: snap.id },
        { capsule: capsule("cap_b", "src_shared", "active", "cgr_shared"), adoptedSnapshotId: snap.id },
      ], snapshots: [snap], syncRuns: [syncRun("ssr_shared", "src_shared", snap.id)],
      compatibilityRuns: [{ ...compatibilityRun("check_1", "src_shared", snap.id, "cgr_shared"), capsuleId: "cap_b" }],
      planRuns: [plan("plan_a", "cap_a", snap.id, "cgr_shared"), plan("plan_b", "cap_b", snap.id, "cgr_shared")],
      reports: [{ ...report("cgr_shared", "src_shared", snap.id), capsuleId: "cap_b" }],
      gitPlans: [gitPlan("git_a", "cap_a", "src_shared", snap.id, "ssr_shared", "cgr_shared"),
        gitPlan("git_b", "cap_b", "src_shared", snap.id, "ssr_shared", "cgr_shared")],
      installConfigs: original.installConfigs.map((config) => config.id === "cfg_cap_b"
        ? { ...config, internal: { reason: "per_install_overrides", sourceSnapshotId: snap.id },
          installExperience: { repositoryInstallUx: { status: "accepted" } } } : config) };
    const prepared = await prepareSourceOwnershipMigration(originalWithData, allocator, "2026-10-28T00:00:00.000Z");
    expect(prepared?.action).toBe("split");
    const split = prepared?.splits[0]!;
    expect(split.capsuleId).toBe("cap_b");
    expect(split.source.ownerCapsuleId).toBe("cap_b");
    expect(split.source.hookSecretHash).not.toBe(original.source.hookSecretHash);
    expect(split.snapshots).toHaveLength(1);
    expect(split.syncRuns).toHaveLength(1);
    expect(split.snapshots[0]?.fetchedByRunId).toBe(split.syncRuns[0]?.id);
    expect(split.planRuns[0]?.sourceSnapshotId).toBe(split.snapshots[0]?.id);
    expect(split.reports[0]?.sourceSnapshotId).toBe(split.snapshots[0]?.id);
    expect(split.reports[0]?.capsuleId).toBe("cap_b");
    expect(prepared?.retainedReports[0]?.capsuleId).toBeUndefined();
    expect(prepared?.retainedCompatibilityRuns[0]?.capsuleId).toBeUndefined();
    expect(split.installConfigs[0]?.config.internal?.sourceSnapshotId).toBe(split.snapshots[0]?.id);
    expect(split.capsule.installConfigId).toBe(split.installConfigs[0]?.config.id);
    expect(split.capsule.compatibilityReportId).toBe(split.reports[0]?.id);
    expect(split.gitPlans[0]?.sourceId).toBe(split.source.id);
    expect(split.gitPlans[0]?.preflight?.sourceSnapshotId).toBe(split.snapshots[0]?.id);
    expect(split.gitPlans[0]?.sourceSyncRunId).toBe(split.syncRuns[0]?.id);
    expect(split.gitPlans[0]?.compatibilityCheckRunId).toBe(split.compatibilityRuns[0]?.id);
    expect(split.gitPlans[0]?.preflight?.compatibilityCheckRunId).toBe(split.compatibilityRuns[0]?.id);
    expect(split.compatibilityRuns[0]?.sourceId).toBe(split.source.id);
    expect(split.compatibilityRuns[0]?.sourceSnapshotId).toBe(split.snapshots[0]?.id);
    expect(prepared?.activity[0]?.action).toBe("source.split");
    expect(split.archiveCopies[0]?.to).toBe(split.snapshots[0]?.archiveRef);
    const again = await prepareSourceOwnershipMigration(originalWithData, allocator, "2026-10-28T00:00:00.000Z");
    expect(again).toEqual(prepared);
    expect(originalWithData.planRuns[0]?.sourceSnapshotId).toBe(snap.id);
    expect(originalWithData.compatibilityRuns[0]?.id).toBe("check_1");
    const store = new FixtureStore();
    store.groups.set(originalWithData.source.id, originalWithData);
    const applied = await migrateSourceOwnership(store, allocator, { copyVerified: async () => {} },
      { apply: true, now: "2026-10-28T00:00:00.000Z" });
    expect(applied[0]?.status).toBe("committed");
    const retained = store.groups.get(originalWithData.source.id)!;
    const moved = store.groups.get(split.source.id)!;
    expect(retained.reports[0]?.capsuleId).toBeUndefined();
    expect(retained.compatibilityRuns[0]?.capsuleId).toBeUndefined();
    expect(moved.reports[0]?.capsuleId).toBe("cap_b");
    expect(moved.compatibilityRuns[0]?.capsuleId).toBe("cap_b");
    expect(moved.installConfigs[0]?.internal?.sourceSnapshotId).toBe(moved.snapshots[0]?.id);
    expect(moved.snapshots[0]?.sourceId).toBe(moved.source.id);
    const rerun = await migrateSourceOwnership(store, allocator, { copyVerified: async () => {} });
    expect(rerun.map((result) => result.status)).toEqual(["unchanged", "unchanged"]);
  });

  test("in-flight work and broken snapshot provenance fail closed", async () => {
    const moving = group("src_busy", [["cap_a", "active"], ["cap_b", "active"]]);
    expect(inventorySourceOwnershipGroup({ ...moving, inFlightRunIds: ["run_active"] }).action).toBe("blocked");
    const withMissing: SourceOwnershipMigrationGroup = { ...moving,
      capsules: moving.capsules.map((entry) => entry.capsule.id === "cap_b"
        ? { ...entry, adoptedSnapshotId: "snap_missing" } : entry) };
    expect(prepareSourceOwnershipMigration(withMissing, allocator, "2026-10-28T00:00:00.000Z"))
      .rejects.toThrow("missing_snapshot");
  });

  test("generic snapshot pins remap and sealed recovery provenance blocks a split", async () => {
    const base = group("src_config_provenance", [["cap_a", "active"], ["cap_b", "active"]]);
    const snap = snapshot("snap_config", base.source.id, "ssr_config");
    const generic: SourceOwnershipMigrationGroup = { ...base, snapshots: [snap],
      syncRuns: [syncRun("ssr_config", base.source.id, snap.id)],
      installConfigs: base.installConfigs.map((config) => config.id === "cfg_cap_b"
        ? { ...config, internal: { reason: "per_install_overrides",
          genericOpenTofuSourceSnapshotId: snap.id,
          genericOpenTofuVariableContractDigest: `sha256:${"a".repeat(64)}` } } : config) };
    const prepared = await prepareSourceOwnershipMigration(generic, allocator, "2026-10-28T00:00:00.000Z");
    expect(prepared?.splits[0]?.installConfigs[0]?.config.internal?.genericOpenTofuSourceSnapshotId)
      .toBe(prepared?.splits[0]?.snapshots[0]?.id);
    const sealed: SourceOwnershipMigrationGroup = { ...generic,
      installConfigs: generic.installConfigs.map((config) => config.id === "cfg_cap_b"
        ? { ...config, internal: { reason: "per_install_overrides", migrationRestore: {
          bundleDigest: "digest", migrationId: "migration", idempotencyKeyHash: "hash",
          requestDigest: "digest", sourceSnapshotId: snap.id, compatibilityCheckRunId: "check",
          compatibilityReportId: "report", actorSubject: "operator" } } } : config) };
    expect(inventorySourceOwnershipGroup(sealed)).toMatchObject({ action: "blocked",
      reason: "install_config_sealed_provenance" });
  });

  test("standalone Capsule compatibility evidence moves together without an install plan", async () => {
    const base = group("src_standalone_check", [["cap_a", "active"], ["cap_b", "active"]]);
    const snap = snapshot("snap_standalone", base.source.id, "ssr_standalone");
    const observed: SourceOwnershipMigrationGroup = { ...base, snapshots: [snap],
      syncRuns: [syncRun("ssr_standalone", base.source.id, snap.id)],
      compatibilityRuns: [{ ...compatibilityRun("check_standalone", base.source.id,
        snap.id, "report_standalone"), capsuleId: "cap_b" }],
      reports: [{ ...report("report_standalone", base.source.id, snap.id), capsuleId: "cap_b" }] };
    const store = new FixtureStore();
    store.groups.set(base.source.id, observed);
    const [result] = await migrateSourceOwnership(store, allocator, { copyVerified: async () => {} },
      { apply: true, now: "2026-10-28T00:00:00.000Z" });
    expect(result?.status).toBe("committed");
    const retained = store.groups.get(base.source.id)!;
    const moved = [...store.groups.values()].find((entry) => entry.source.ownerCapsuleId === "cap_b")!;
    expect(retained.compatibilityRuns[0]?.capsuleId).toBeUndefined();
    expect(retained.reports[0]?.capsuleId).toBeUndefined();
    expect(moved.compatibilityRuns[0]?.capsuleId).toBe("cap_b");
    expect(moved.compatibilityRuns[0]?.compatibilityReportId).toBe(moved.reports[0]?.id);
    expect(moved.compatibilityRuns[0]?.sourceSnapshotId).toBe(moved.snapshots[0]?.id);
    expect(moved.reports[0]?.capsuleId).toBe("cap_b");
    expect((await migrateSourceOwnership(store, allocator, { copyVerified: async () => {} }))
      .map((entry) => entry.status)).toEqual(["unchanged", "unchanged"]);
  });

  test("foreign archive refs are copied into each retained Source before mark for retirement", async () => {
    const original = group("src_old", [["cap_gone", "destroyed"]]);
    const snap = { ...snapshot("snap_foreign", "src_old", "ssr_foreign"),
      archiveRef: "workspaces/ws_1/sources/src_other/snapshots/snap_foreign/source.tar.zst" };
    const run = { ...syncRun("ssr_foreign", "src_old", snap.id), archiveRef: snap.archiveRef };
    const evidence: SourceOwnershipMigrationGroup = { ...original, snapshots: [snap], syncRuns: [run] };
    const store = new FixtureStore();
    store.groups.set("src_old", evidence);
    const copied: string[] = [];
    const result = await migrateSourceOwnership(store, allocator, {
      copyVerified: async ({ to }) => { copied.push(to); },
    }, { apply: true, now: "2026-10-28T00:00:00.000Z" });
    expect(result[0]?.status).toBe("committed");
    expect(copied).toEqual(["workspaces/ws_1/sources/src_old/snapshots/snap_foreign/source.tar.zst"]);
    const mutation = await prepareSourceOwnershipMigration(evidence, allocator, "2026-10-28T00:00:00.000Z");
    expect(mutation?.retainedSnapshots[0]?.archiveRef).toBe(copied[0]);
    expect(mutation?.retainedSyncRuns[0]?.archiveRef).toBe(copied[0]);
    expect(mutation?.archiveCopies).toHaveLength(1);
  });

  test("retained owner adopts its own lane during backfill and split", async () => {
    const base = group("src_lanes", [["cap_a", "active"], ["cap_b", "active"]]);
    const adopted = snapshot("snap_owner", "src_lanes", "ssr_owner", "release/v1");
    const other = snapshot("snap_other", "src_lanes", "ssr_other", "release/v2");
    const observed: SourceOwnershipMigrationGroup = { ...base,
      capsules: [
        { capsule: capsule("cap_a", "src_lanes"), adoptedSnapshotId: adopted.id },
        { capsule: capsule("cap_b", "src_lanes"), adoptedSnapshotId: other.id },
      ], snapshots: [adopted, other],
      syncRuns: [syncRun("ssr_owner", "src_lanes", adopted.id, adopted.ref),
        syncRun("ssr_other", "src_lanes", other.id, other.ref)] };
    const mutation = await prepareSourceOwnershipMigration(observed, allocator, "2026-10-28T00:00:00.000Z");
    expect(mutation?.retainedSource.defaultRef).toBe("release/v1");
    expect(mutation?.splits[0]?.source.defaultRef).toBe("release/v2");
  });
});
