/** Operator-only PostgreSQL backfill. No archive custody or schema mutation. */
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { stableJsonDigest, stableStringify } from "../../../core/adapters/source/digest.ts";
import {
  inventorySourceOwnershipGroup,
  prepareSourceOwnershipMigration,
  type SourceOwnershipMigrationGroup,
  type SourceOwnershipMigrationMutation,
  type SourceOwnershipMigrationStore,
} from "../../../core/domains/sources/ownership-migration.ts";

export interface SourceOwnershipBackfillReport {
  readonly version: 1;
  readonly sourceId: string;
  readonly preparedAt: string;
  readonly status: "ready" | "refused";
  readonly action: string;
  readonly planDigest?: string;
  /** Config-only convergence to the owner's exact applied SourceSnapshot lane. */
  readonly laneConfigChange?: {
    readonly fromRef: string; readonly fromPath: string;
    readonly toRef: string; readonly toPath: string;
  };
  readonly reason?: string;
  readonly custody?: string;
}

const CUSTODY = "Use the reviewed Source ownership migration with verified archive copy custody; this PostgreSQL entrypoint only backfills one exclusive live owner without archive copies.";
const allocator = new ObjectKeyArtifactReferenceAllocator();

async function prepare(group: SourceOwnershipMigrationGroup, preparedAt: string): Promise<{
  readonly report: SourceOwnershipBackfillReport;
  readonly mutation?: SourceOwnershipMigrationMutation;
}> {
  const inventory = inventorySourceOwnershipGroup(group, preparedAt);
  const base = { version: 1 as const, sourceId: group.source.id, preparedAt,
    action: inventory.action };
  if (inventory.action !== "backfill" || inventory.liveCapsuleIds.length !== 1 ||
    group.source.status !== "active" || group.source.retiringAt) {
    return { report: { ...base, status: "refused", reason: inventory.reason ??
      (group.source.retiringAt ? "source_retiring" : group.source.status !== "active"
        ? "source_not_active" : `action_${inventory.action}_requires_separate_custody`), custody: CUSTODY } };
  }
  let mutation: SourceOwnershipMigrationMutation | undefined;
  try {
    mutation = await prepareSourceOwnershipMigration(group, allocator, preparedAt);
  } catch {
    return { report: { ...base, status: "refused", reason: "preparation_failed",
      custody: CUSTODY } };
  }
  if (!mutation || mutation.action !== "backfill" || mutation.archiveCopies.length !== 0 ||
    mutation.retainedSnapshots.length !== 0 || mutation.retainedSyncRuns.length !== 0 ||
    mutation.splits.length !== 0 || mutation.retainedCompatibilityRuns.length !== 0 ||
    mutation.retainedReports.length !== 0) {
    return { report: { ...base, status: "refused", reason: "archive_or_lineage_custody_required",
      custody: CUSTODY } };
  }
  const planDigest = await stableJsonDigest(JSON.parse(JSON.stringify(mutation)));
  const laneConfigChange = mutation.retainedSource.defaultRef !== group.source.defaultRef ||
    mutation.retainedSource.defaultPath !== group.source.defaultPath
    ? { fromRef: group.source.defaultRef, fromPath: group.source.defaultPath,
      toRef: mutation.retainedSource.defaultRef, toPath: mutation.retainedSource.defaultPath }
    : undefined;
  return { report: { ...base, status: "ready", planDigest,
    ...(laneConfigChange ? { laneConfigChange } : {}) }, mutation };
}

export async function inspectPostgresSourceOwnershipBackfill(
  store: SourceOwnershipMigrationStore,
  options: { readonly sourceId?: string; readonly preparedAt?: string } = {},
): Promise<readonly SourceOwnershipBackfillReport[]> {
  const preparedAt = options.preparedAt ?? new Date().toISOString();
  const ids = options.sourceId ? [options.sourceId] : [...await store.listSourceIds()].sort();
  const reports: SourceOwnershipBackfillReport[] = [];
  for (const sourceId of ids) {
    let group: SourceOwnershipMigrationGroup | undefined;
    try {
      group = await store.readGroup(sourceId);
    } catch {
      reports.push({ version: 1, sourceId, preparedAt, status: "refused",
        action: "unavailable", reason: "group_read_failed" });
      continue;
    }
    if (!group) {
      reports.push({ version: 1, sourceId, preparedAt, status: "refused",
        action: "unavailable", reason: "source_missing" });
      continue;
    }
    try {
      reports.push((await prepare(group, preparedAt)).report);
    } catch {
      reports.push({ version: 1, sourceId, preparedAt, status: "refused",
        action: "unavailable", reason: "preparation_failed" });
    }
  }
  return reports;
}

export async function applyPostgresSourceOwnershipBackfill(
  store: SourceOwnershipMigrationStore,
  reviewed: SourceOwnershipBackfillReport,
): Promise<"committed" | "conflict"> {
  if (reviewed.version !== 1 || reviewed.status !== "ready" || reviewed.action !== "backfill" ||
    !/^[A-Za-z][A-Za-z0-9_-]{2,127}$/u.test(reviewed.sourceId) ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(reviewed.preparedAt) ||
    !Number.isFinite(Date.parse(reviewed.preparedAt)) ||
    new Date(reviewed.preparedAt).toISOString() !== reviewed.preparedAt ||
    !/^sha256:[0-9a-f]{64}$/u.test(reviewed.planDigest ?? "")) {
    throw new Error("source_ownership_backfill_invalid_reviewed_report");
  }
  const group = await store.readGroup(reviewed.sourceId);
  if (!group) throw new Error(`source_ownership_backfill_missing_source:${reviewed.sourceId}`);
  const { report, mutation } = await prepare(group, reviewed.preparedAt);
  if (report.status !== "ready" || !mutation) {
    throw new Error(`source_ownership_backfill_refused:${report.reason ?? "unavailable"}:${report.custody ?? CUSTODY}`);
  }
  if (report.planDigest !== reviewed.planDigest) {
    throw new Error("source_ownership_backfill_review_digest_changed");
  }
  if (stableStringify(report.laneConfigChange ?? null) !==
    stableStringify(reviewed.laneConfigChange ?? null)) {
    throw new Error("source_ownership_backfill_review_lane_changed");
  }
  return await store.commitGroup(mutation);
}
