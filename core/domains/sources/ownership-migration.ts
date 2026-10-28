/**
 * Operator-only, DDL-free repair of pre-exclusive Git Source ownership.
 *
 * This module deliberately has no scheduler or HTTP entrypoint. Archive copies
 * finish before the guarded ledger commit; a lost acknowledgement can safely
 * repeat the copy and re-inventory the group. The store port must perform the
 * complete ledger mutation in one transaction and reject a changed group.
 */
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Capsule, CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { Run } from "takosumi-contract/runs";
import type { ArtifactReferenceAllocator } from "../../adapters/storage/artifact-references.ts";
import type { StoredSource } from "../deploy-control/store.ts";
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import type { StoredGitInstallPlan } from "../install-plans/store.ts";

export interface SourceOwnershipMigrationCapsule {
  readonly capsule: Capsule;
  /** Resolved through the immutable StateVersion -> ApplyRun -> PlanRun chain. */
  readonly adoptedSnapshotId?: string;
}

export interface SourceOwnershipMigrationGroup {
  readonly source: StoredSource;
  readonly capsules: readonly SourceOwnershipMigrationCapsule[];
  readonly snapshots: readonly SourceSnapshot[];
  readonly syncRuns: readonly SourceSyncRun[];
  readonly compatibilityRuns: readonly Run[];
  readonly planRuns: readonly PlanRun[];
  readonly reports: readonly CapsuleCompatibilityReport[];
  readonly gitPlans: readonly StoredGitInstallPlan[];
  /** All non-terminal runs involving this Source or any of its Capsules. */
  readonly inFlightRunIds: readonly string[];
}

export type SourceOwnershipMigrationAction = "backfill" | "retire" | "split" | "normalize" | "none" | "blocked";

export interface SourceOwnershipMigrationInventory {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly action: SourceOwnershipMigrationAction;
  readonly ownerCapsuleId?: string;
  readonly liveCapsuleIds: readonly string[];
  readonly destroyedCapsuleIds: readonly string[];
  readonly splitCapsuleIds: readonly string[];
  readonly snapshotCount: number;
  readonly archiveBytes: number;
  readonly foreignArchiveRefs: number;
  readonly inFlightRunIds: readonly string[];
  readonly reason?: string;
}

export interface SourceOwnershipMigrationArchiveCopy {
  readonly from: string;
  readonly to: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface SourceOwnershipMigrationSplit {
  readonly capsuleId: string;
  readonly source: StoredSource;
  readonly capsule: Capsule;
  readonly snapshots: readonly SourceSnapshot[];
  readonly syncRuns: readonly SourceSyncRun[];
  readonly compatibilityRuns: readonly Run[];
  readonly planRuns: readonly PlanRun[];
  readonly reports: readonly CapsuleCompatibilityReport[];
  readonly gitPlans: readonly StoredGitInstallPlan[];
  readonly archiveCopies: readonly SourceOwnershipMigrationArchiveCopy[];
}

export interface SourceOwnershipMigrationMutation {
  readonly sourceId: string;
  /** Exact observed group. The adapter re-reads and fences it in one commit. */
  readonly expected: SourceOwnershipMigrationGroup;
  readonly action: Exclude<SourceOwnershipMigrationAction, "none" | "blocked">;
  readonly retainedSource: StoredSource;
  /** Existing rows whose foreign archive refs were copied into this Source. */
  readonly retainedSnapshots: readonly SourceSnapshot[];
  readonly retainedSyncRuns: readonly SourceSyncRun[];
  readonly splits: readonly SourceOwnershipMigrationSplit[];
  readonly archiveCopies: readonly SourceOwnershipMigrationArchiveCopy[];
  readonly activity: readonly ActivityEvent[];
}

export interface SourceOwnershipMigrationStore {
  listSourceIds(): Promise<readonly string[]>;
  readGroup(sourceId: string): Promise<SourceOwnershipMigrationGroup | undefined>;
  /** Must be atomic, including source/capsule/run/report/snapshot and Activity rows. */
  commitGroup(mutation: SourceOwnershipMigrationMutation): Promise<"committed" | "conflict">;
}

export interface SourceOwnershipMigrationArchiveCopier {
  /** Create-only, or prove existing bytes match digest and size. Never overwrite. */
  copyVerified(input: SourceOwnershipMigrationArchiveCopy): Promise<void>;
}

export interface SourceOwnershipMigrationResult {
  readonly inventory: SourceOwnershipMigrationInventory;
  readonly status: "dry_run" | "committed" | "conflict" | "blocked" | "unchanged";
  /** Exact observed group and proposed mutation, including archive destinations. */
  readonly planDigest?: string;
  readonly copies: number;
  readonly bytes: number;
}

/** Stable operator report. No credential or repository content is included. */
export function inventorySourceOwnershipGroup(group: SourceOwnershipMigrationGroup): SourceOwnershipMigrationInventory {
  const source = group.source;
  const live = group.capsules.filter(({ capsule }) => capsule.status !== "destroyed").map(({ capsule }) => capsule.id).sort();
  const destroyed = group.capsules.filter(({ capsule }) => capsule.status === "destroyed").map(({ capsule }) => capsule.id).sort();
  const inFlight = [...new Set(group.inFlightRunIds)].sort();
  const snapshotById = new Map(group.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const ownerCapsuleId = source.ownerCapsuleId ?? live[0];
  const ownerEvidence = group.capsules.find(({ capsule }) => capsule.id === ownerCapsuleId);
  const ownerAdopted = ownerEvidence?.adoptedSnapshotId
    ? snapshotById.get(ownerEvidence.adoptedSnapshotId) : undefined;
  const ownerLaneMismatch = !!ownerAdopted &&
    (source.defaultRef !== ownerAdopted.ref || source.defaultPath !== ownerAdopted.path);
  let reason: string | undefined;
  if (group.capsules.some(({ capsule }) => capsule.sourceId !== source.id || capsule.workspaceId !== source.workspaceId)) {
    reason = "capsule_source_scope_mismatch";
  } else if (group.snapshots.some((snapshot) => snapshot.sourceId !== source.id || snapshot.workspaceId !== source.workspaceId)) {
    reason = "snapshot_source_scope_mismatch";
  } else if (group.syncRuns.some((run) => run.sourceId !== source.id || run.workspaceId !== source.workspaceId)) {
    reason = "sync_run_source_scope_mismatch";
  } else if (group.compatibilityRuns.some((run) => run.type !== "compatibility_check" ||
    run.sourceId !== source.id || run.workspaceId !== source.workspaceId ||
    (run.capsuleId && !group.capsules.some(({ capsule }) => capsule.id === run.capsuleId)))) {
    reason = "compatibility_run_source_scope_mismatch";
  } else if (group.reports.some((report) => report.sourceId !== source.id ||
    !snapshotById.has(report.sourceSnapshotId) ||
    (report.capsuleId && !group.capsules.some(({ capsule }) => capsule.id === report.capsuleId)))) {
    reason = "compatibility_report_source_scope_mismatch";
  } else if (group.gitPlans.some((plan) =>
    (plan.sourceId && plan.sourceId !== source.id) ||
    (plan.preflight?.sourceId && plan.preflight.sourceId !== source.id) ||
    (plan.capsuleId && !group.capsules.some(({ capsule }) => capsule.id === plan.capsuleId)))) {
    reason = "git_install_plan_source_scope_mismatch";
  } else if (group.planRuns.some((run) => !run.capsuleId || !group.capsules.some(({ capsule }) => capsule.id === run.capsuleId))) {
    reason = "plan_run_capsule_scope_mismatch";
  } else if (ownerEvidence?.adoptedSnapshotId && !ownerAdopted) {
    reason = "owner_adopted_snapshot_missing";
  } else if (source.ownerCapsuleId && !live.includes(source.ownerCapsuleId) && live.length > 0) {
    reason = "source_owner_not_live_referenced_capsule";
  } else if (inFlight.length > 0) {
    reason = "work_in_flight";
  }
  const foreignArchiveRefs = group.snapshots.filter((snapshot) => !archiveOwnedBySource(snapshot.archiveRef, source)).length +
    group.syncRuns.filter((run) => !archiveOwnedBySource(run.archiveRef, source)).length;
  const action: SourceOwnershipMigrationAction = reason ? "blocked"
    : live.length === 0 ? (source.status === "disabled" && !source.autoSync && source.retiringAt && foreignArchiveRefs === 0 ? "none" : "retire")
    : live.length > 1 ? "split"
    : source.ownerCapsuleId === undefined ? "backfill"
    : foreignArchiveRefs > 0 || ownerLaneMismatch ? "normalize"
    : "none";
  return {
    sourceId: source.id, workspaceId: source.workspaceId, action, ownerCapsuleId,
    liveCapsuleIds: live, destroyedCapsuleIds: destroyed,
    splitCapsuleIds: live.filter((id) => id !== ownerCapsuleId),
    snapshotCount: group.snapshots.length,
    archiveBytes: group.snapshots.reduce((total, snapshot) => total + snapshot.archiveSizeBytes, 0),
    foreignArchiveRefs,
    inFlightRunIds: inFlight, ...(reason ? { reason } : {}),
  };
}

export async function prepareSourceOwnershipMigration(
  group: SourceOwnershipMigrationGroup,
  allocator: ArtifactReferenceAllocator,
  now: string,
): Promise<SourceOwnershipMigrationMutation | undefined> {
  const inventory = inventorySourceOwnershipGroup(group);
  if (inventory.action === "blocked") throw new Error(`source_ownership_migration_blocked:${inventory.sourceId}:${inventory.reason}`);
  if (inventory.action === "none") return undefined;
  const retainedSource: StoredSource = inventory.action === "retire"
    ? { ...group.source, status: "disabled", autoSync: false, retiringAt: group.source.retiringAt ?? now, updatedAt: now }
    : { ...group.source, ownerCapsuleId: inventory.ownerCapsuleId,
      ...retainedOwnerLane(group, inventory.ownerCapsuleId), updatedAt: now };
  const retainedSnapshots: SourceSnapshot[] = [];
  const retainedSyncRuns: SourceSyncRun[] = [];
  const retainedCopies: SourceOwnershipMigrationArchiveCopy[] = [];
  const canonicalSnapshots = new Map<string, SourceSnapshot>();
  for (const snapshot of group.snapshots) {
    const ref = await allocator.allocate({ kind: "source_archive", workspaceId: group.source.workspaceId,
      sourceId: group.source.id, snapshotId: snapshot.id });
    const replacement = ref === snapshot.archiveRef ? snapshot : { ...snapshot, archiveRef: ref };
    canonicalSnapshots.set(snapshot.id, replacement);
    if (replacement !== snapshot) {
      retainedSnapshots.push(replacement);
      retainedCopies.push({ from: snapshot.archiveRef, to: ref, digest: snapshot.archiveDigest,
        sizeBytes: snapshot.archiveSizeBytes });
    }
  }
  for (const run of group.syncRuns) {
    if (archiveOwnedBySource(run.archiveRef, group.source)) continue;
    const snapshot = run.snapshotId ? canonicalSnapshots.get(run.snapshotId) : undefined;
    if (run.status === "succeeded" && !snapshot) {
      throw new Error(`source_ownership_migration_unresolved_sync_archive:${run.id}`);
    }
    const archiveRef = snapshot?.archiveRef ?? await allocator.allocate({ kind: "source_archive",
      workspaceId: group.source.workspaceId, sourceId: group.source.id,
      snapshotId: run.requestedSnapshotId ?? run.id });
    retainedSyncRuns.push({ ...run, archiveRef });
  }
  const splits: SourceOwnershipMigrationSplit[] = [];
  for (const capsuleId of inventory.splitCapsuleIds) {
    splits.push(await prepareSplit(group, capsuleId, allocator, now));
  }
  const activity = await Promise.all(splits.map(async (split) => ({
    id: await deterministicId("act", group.source.id, split.capsuleId, "source.split"),
    workspaceId: group.source.workspaceId,
    action: "source.split",
    targetType: "source",
    targetId: split.source.id,
    metadata: { fromSourceId: group.source.id, toSourceId: split.source.id, capsuleId: split.capsuleId,
      snapshotCount: split.snapshots.length },
    createdAt: now,
  } satisfies ActivityEvent)));
  return { sourceId: group.source.id, expected: group,
    action: inventory.action as "backfill" | "retire" | "split" | "normalize", retainedSource,
    retainedSnapshots, retainedSyncRuns, splits,
    archiveCopies: [...retainedCopies, ...splits.flatMap((split) => split.archiveCopies)], activity };
}

function archiveOwnedBySource(ref: string, source: StoredSource): boolean {
  return ref.startsWith(`workspaces/${source.workspaceId}/sources/${source.id}/snapshots/`);
}

function retainedOwnerLane(group: SourceOwnershipMigrationGroup, ownerCapsuleId: string | undefined):
  { readonly defaultRef?: string; readonly defaultPath?: string } {
  const adoptedId = group.capsules.find(({ capsule }) => capsule.id === ownerCapsuleId)?.adoptedSnapshotId;
  if (!adoptedId) return {};
  const snapshot = group.snapshots.find((entry) => entry.id === adoptedId);
  if (!snapshot) throw new Error(`source_ownership_migration_owner_snapshot_missing:${adoptedId}`);
  return { defaultRef: snapshot.ref, defaultPath: snapshot.path };
}

async function prepareSplit(
  group: SourceOwnershipMigrationGroup,
  capsuleId: string,
  allocator: ArtifactReferenceAllocator,
  now: string,
): Promise<SourceOwnershipMigrationSplit> {
  const evidence = group.capsules.find(({ capsule }) => capsule.id === capsuleId);
  if (!evidence) throw new Error(`source_ownership_migration_missing_capsule:${capsuleId}`);
  const original = group.source;
  const newSourceId = await deterministicId("src", original.id, capsuleId, "split");
  const plans = group.planRuns.filter((plan) => plan.capsuleId === capsuleId);
  const originalGitPlans = group.gitPlans.filter((plan) => plan.capsuleId === capsuleId);
  const referencedCheckRunIds = new Set(originalGitPlans.flatMap((plan) =>
    [plan.compatibilityCheckRunId, plan.preflight?.compatibilityCheckRunId]).filter((id): id is string => !!id));
  const originalCompatibilityRuns = group.compatibilityRuns.filter((run) => referencedCheckRunIds.has(run.id));
  if (referencedCheckRunIds.size !== originalCompatibilityRuns.length) {
    throw new Error(`source_ownership_migration_missing_compatibility_run:${capsuleId}`);
  }
  const originalSnapshots = new Map(group.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const referencedIds = new Set<string>();
  if (evidence.adoptedSnapshotId) referencedIds.add(evidence.adoptedSnapshotId);
  for (const plan of plans) if (plan.sourceSnapshotId) referencedIds.add(plan.sourceSnapshotId);
  for (const plan of originalGitPlans) {
    if (plan.sourceSnapshotId) referencedIds.add(plan.sourceSnapshotId);
    if (plan.preflight?.sourceSnapshotId) referencedIds.add(plan.preflight.sourceSnapshotId);
  }
  for (const run of originalCompatibilityRuns) if (run.sourceSnapshotId) referencedIds.add(run.sourceSnapshotId);
  const originalReports = group.reports.filter((report) => report.capsuleId === capsuleId ||
    report.id === evidence.capsule.compatibilityReportId || plans.some((plan) => plan.compatibilityReportId === report.id) ||
    originalGitPlans.some((plan) => plan.compatibilityReportId === report.id || plan.preflight?.compatibilityReportId === report.id));
  const reportSet = new Set(originalReports.map((report) => report.id));
  if (originalReports.some((report) => report.capsuleId && report.capsuleId !== capsuleId)) {
    throw new Error(`source_ownership_migration_foreign_capsule_report:${capsuleId}`);
  }
  for (const id of [evidence.capsule.compatibilityReportId,
    ...plans.map((plan) => plan.compatibilityReportId),
    ...originalGitPlans.flatMap((plan) => [plan.compatibilityReportId, plan.preflight?.compatibilityReportId])]) {
    if (id && !reportSet.has(id)) throw new Error(`source_ownership_migration_missing_report:${id}`);
  }
  for (const report of originalReports) referencedIds.add(report.sourceSnapshotId);
  for (const id of referencedIds) if (!originalSnapshots.has(id)) throw new Error(`source_ownership_migration_missing_snapshot:${id}`);
  const adopted = evidence.adoptedSnapshotId ? originalSnapshots.get(evidence.adoptedSnapshotId) : undefined;
  const latestPlanSnapshot = [...plans].reverse().find((plan) => plan.sourceSnapshotId)?.sourceSnapshotId;
  const laneSnapshot = adopted ?? (latestPlanSnapshot ? originalSnapshots.get(latestPlanSnapshot) : undefined);
  const laneRef = laneSnapshot?.ref ?? original.defaultRef;
  const lanePath = laneSnapshot?.path ?? original.defaultPath;
  // Include the entire lane so revision history remains available to this app.
  for (const snapshot of group.snapshots) if (snapshot.ref === laneRef && snapshot.path === lanePath) referencedIds.add(snapshot.id);
  const selected = group.snapshots.filter((snapshot) => referencedIds.has(snapshot.id));
  const snapshotIds = new Map(await Promise.all(selected.map(async (snapshot) =>
    [snapshot.id, await deterministicId("snap", snapshot.id, capsuleId, "split")] as const)));
  const producerRunIds = new Set([...selected.map((snapshot) => snapshot.fetchedByRunId),
    ...originalGitPlans.map((plan) => plan.sourceSyncRunId).filter((id): id is string => !!id)]);
  const originalRuns = group.syncRuns.filter((run) => producerRunIds.has(run.id));
  if (producerRunIds.size !== originalRuns.length) throw new Error(`source_ownership_migration_missing_sync_run:${capsuleId}`);
  const runIds = new Map(await Promise.all(originalRuns.map(async (run) =>
    [run.id, await deterministicId("ssr", run.id, capsuleId, "split")] as const)));
  const archiveCopies: SourceOwnershipMigrationArchiveCopy[] = [];
  const snapshots: SourceSnapshot[] = [];
  for (const snapshot of selected) {
    const newSnapshotId = snapshotIds.get(snapshot.id)!;
    const archiveRef = await allocator.allocate({ kind: "source_archive", workspaceId: original.workspaceId,
      sourceId: newSourceId, snapshotId: newSnapshotId });
    archiveCopies.push({ from: snapshot.archiveRef, to: archiveRef, digest: snapshot.archiveDigest,
      sizeBytes: snapshot.archiveSizeBytes });
    snapshots.push({ ...snapshot, id: newSnapshotId, sourceId: newSourceId, archiveRef,
      fetchedByRunId: runIds.get(snapshot.fetchedByRunId)! });
  }
  const mappedSnapshots = new Map(snapshots.map((snapshot, i) => [selected[i]!.id, snapshot]));
  const syncRuns = await Promise.all(originalRuns.map(async (run) => {
    const canonical = run.snapshotId ? mappedSnapshots.get(run.snapshotId) : undefined;
    const allocated = selected.find((snapshot) => snapshot.fetchedByRunId === run.id);
    const archiveRef = canonical?.archiveRef ?? mappedSnapshots.get(allocated?.id ?? "")?.archiveRef ??
      await allocator.allocate({ kind: "source_archive", workspaceId: original.workspaceId,
        sourceId: newSourceId, snapshotId: run.requestedSnapshotId ?? run.id });
    if (run.status === "succeeded" && !canonical && !allocated) {
      throw new Error(`source_ownership_migration_missing_run_archive:${run.id}`);
    }
    if (run.snapshotId && !snapshotIds.has(run.snapshotId)) throw new Error(`source_ownership_migration_unmapped_run_snapshot:${run.id}`);
    return { ...run, id: runIds.get(run.id)!, sourceId: newSourceId, archiveRef,
      snapshotId: run.snapshotId ? requiredMap(snapshotIds, run.snapshotId) : undefined,
      requestedSnapshotId: run.requestedSnapshotId ? snapshotIds.get(run.requestedSnapshotId) ??
        await deterministicId("snap", run.requestedSnapshotId, capsuleId, "split") : undefined };
  }));
  const reportIds = new Map(await Promise.all(originalReports.map(async (report) =>
    [report.id, await deterministicId("cgr", report.id, capsuleId, "split")] as const)));
  const compatibilityRunIds = new Map(await Promise.all(originalCompatibilityRuns.map(async (run) =>
    [run.id, await deterministicId("run", run.id, capsuleId, "split")] as const)));
  const reports = originalReports.map((report) => ({ ...report, id: reportIds.get(report.id)!,
    sourceId: newSourceId, sourceSnapshotId: requiredMap(snapshotIds, report.sourceSnapshotId) }));
  const compatibilityRuns = originalCompatibilityRuns.map((run) => ({ ...run,
    id: requiredMap(compatibilityRunIds, run.id), sourceId: newSourceId,
    sourceSnapshotId: run.sourceSnapshotId ? requiredMap(snapshotIds, run.sourceSnapshotId) : undefined,
    compatibilityReportId: run.compatibilityReportId ? requiredMap(reportIds, run.compatibilityReportId) : undefined }));
  const planRuns = plans.map((plan) => ({ ...plan,
    sourceSnapshotId: plan.sourceSnapshotId ? requiredMap(snapshotIds, plan.sourceSnapshotId) : undefined,
    compatibilityReportId: plan.compatibilityReportId ? reportIds.get(plan.compatibilityReportId) ?? plan.compatibilityReportId : undefined }));
  const gitPlans = originalGitPlans.map((plan) => ({ ...plan, sourceId: newSourceId,
    sourceSnapshotId: plan.sourceSnapshotId ? requiredMap(snapshotIds, plan.sourceSnapshotId) : undefined,
    sourceSyncRunId: plan.sourceSyncRunId ? requiredMap(runIds, plan.sourceSyncRunId) : undefined,
    compatibilityReportId: plan.compatibilityReportId ? requiredMap(reportIds, plan.compatibilityReportId) : undefined,
    compatibilityCheckRunId: plan.compatibilityCheckRunId ? requiredMap(compatibilityRunIds, plan.compatibilityCheckRunId) : undefined,
    preflight: plan.preflight ? { ...plan.preflight, sourceId: newSourceId,
      sourceSnapshotId: requiredMap(snapshotIds, plan.preflight.sourceSnapshotId),
      compatibilityReportId: requiredMap(reportIds, plan.preflight.compatibilityReportId),
      compatibilityCheckRunId: requiredMap(compatibilityRunIds, plan.preflight.compatibilityCheckRunId) } : undefined }));
  const source: StoredSource = { ...original, id: newSourceId, ownerCapsuleId: capsuleId,
    createdByInstallPlanId: undefined, defaultRef: laneRef, defaultPath: lanePath,
    hookSecretHash: "0".repeat(64), lastSeenCommit: laneSnapshot?.resolvedCommit,
    lastAutoSyncAttemptAt: undefined, retiringAt: undefined, createdAt: now, updatedAt: now,
    name: `${original.name} (${capsuleId})` };
  const capsule: Capsule = { ...evidence.capsule, sourceId: newSourceId,
    compatibilityReportId: evidence.capsule.compatibilityReportId
      ? reportIds.get(evidence.capsule.compatibilityReportId) ?? evidence.capsule.compatibilityReportId : undefined,
    autoUpdateAttemptSourceSnapshotId: evidence.capsule.autoUpdateAttemptSourceSnapshotId
      ? snapshotIds.get(evidence.capsule.autoUpdateAttemptSourceSnapshotId) : undefined,
    updatedAt: now };
  return { capsuleId, source, capsule, snapshots, syncRuns, compatibilityRuns,
    planRuns, reports, gitPlans, archiveCopies };
}

function requiredMap(map: ReadonlyMap<string, string>, id: string): string {
  const value = map.get(id);
  if (!value) throw new Error(`source_ownership_migration_unmapped_snapshot:${id}`);
  return value;
}

async function deterministicId(prefix: string, ...parts: readonly string[]): Promise<string> {
  // IDs are stable across restarts and do not disclose credentials or content.
  const material = parts.map((part) => `${part.length}:${part}`).join("|");
  return `${prefix}_${(await sha256HexOfStringAsync(material)).slice(0, 32)}`;
}

/** Dry-run is the default and never calls the copier or write port. */
export async function migrateSourceOwnership(
  store: SourceOwnershipMigrationStore,
  allocator: ArtifactReferenceAllocator,
  copier: SourceOwnershipMigrationArchiveCopier,
  options: { readonly apply?: boolean; readonly sourceId?: string; readonly now?: string } = {},
): Promise<readonly SourceOwnershipMigrationResult[]> {
  const ids = options.sourceId ? [options.sourceId] : [...await store.listSourceIds()].sort();
  const results: SourceOwnershipMigrationResult[] = [];
  for (const id of ids) {
    const group = await store.readGroup(id);
    if (!group) throw new Error(`source_ownership_migration_missing_source:${id}`);
    const inventory = inventorySourceOwnershipGroup(group);
    if (inventory.action === "blocked") { results.push({ inventory, status: "blocked", copies: 0, bytes: 0 }); continue; }
    if (inventory.action === "none") { results.push({ inventory, status: "unchanged", copies: 0, bytes: 0 }); continue; }
    const mutation = await prepareSourceOwnershipMigration(group, allocator, options.now ?? new Date().toISOString());
    if (!mutation) throw new Error(`source_ownership_migration_missing_mutation:${id}`);
    const planDigest = await stableJsonDigest(JSON.parse(JSON.stringify(mutation)));
    const copies = mutation.archiveCopies;
    const bytes = copies.reduce((total, copy) => total + copy.sizeBytes, 0);
    if (!options.apply) { results.push({ inventory, status: "dry_run", planDigest, copies: copies.length, bytes }); continue; }
    for (const copy of copies) await copier.copyVerified(copy);
    const status = await store.commitGroup(mutation);
    results.push({ inventory, status, planDigest, copies: copies.length, bytes });
    if (status === "conflict") break;
  }
  return results;
}
