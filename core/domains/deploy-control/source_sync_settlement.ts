import type { ActivityEvent } from "takosumi-contract/activity";
import type { Capsule } from "takosumi-contract/capsules";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import { stableStringify } from "../../adapters/source/digest.ts";
import {
  getCapsuleAdoptedSourceSnapshot,
  type CapsuleSourceRevisionReader,
} from "./capsule_source_revision.ts";

/** Same bounded Workspace census used by Source reconciliation. */
export const MAX_SOURCE_RECONCILIATION_CAPSULES = 1_000;

/**
 * Only fields consumed by the provenance resolver are fenced for historical
 * Runs. Heartbeats/audit appends do not change an already adopted revision.
 * Source configuration and cursor are captured in full. Paths are trusted
 * source constants, shared by the JS and SQL read-set validators.
 */
export const SOURCE_SYNC_SETTLEMENT_READ_PATHS = {
  source: ["$"],
  state: ["$.id", "$.workspaceId", "$.capsuleId", "$.environment", "$.generation", "$.createdByRunId"],
  apply: ["$.id", "$.workspaceId", "$.capsuleId", "$.stateVersionId", "$.planRunId", "$.expected", "$.status", "$.operation"],
  plan: ["$.id", "$.workspaceId", "$.capsuleId", "$.operation", "$.appliedApplyRunId", "$.capsuleContext", "$.sourceSnapshotId", "$.source", "$.sourceDigest", "$.variablesDigest"],
  restore: ["$.id", "$.type", "$.kind", "$.sourceDigest", "$.variablesDigest", "$.planRunId", "$.expected", "$.status", "$.workspaceId", "$.capsuleId", "$.environment", "$.restoredStateVersionId", "$.restoredFromStateVersionId"],
  snapshot: ["$.id", "$.origin", "$.workspaceId", "$.sourceId", "$.url", "$.ref", "$.path", "$.resolvedCommit"],
} as const;

export type SourceSyncSettlementReadKind = keyof typeof SOURCE_SYNC_SETTLEMENT_READ_PATHS;
export interface SourceSyncSettlementRead {
  readonly kind: SourceSyncSettlementReadKind;
  readonly id: string;
  /** Null means no record. Missing path keys differ from explicit JSON null. */
  readonly value: Readonly<Record<string, unknown>> | null;
}

export type SourceSyncSettlementReader = CapsuleSourceRevisionReader;

export interface SourceSyncSettlementObservation {
  /** Complete non-destroyed Workspace census, including otherwise ineligible Capsules. */
  readonly capsules: readonly Capsule[];
  readonly reads: readonly SourceSyncSettlementRead[];
  readonly changes: readonly {
    readonly capsule: Capsule;
    readonly activity: ActivityEvent;
  }[];
}

export class SourceSyncSettlementConflictError extends Error {
  override readonly name = "SourceSyncSettlementConflictError";
  constructor() {
    super("SourceSync settlement observations changed before commit");
  }
}

/** Project a getter's domain value, not an unclassified physical Run row. */
export function projectSourceSyncSettlementRead(
  kind: SourceSyncSettlementReadKind,
  record: unknown,
): Readonly<Record<string, unknown>> | null {
  if (record === undefined || record === null) return null;
  const value: Record<string, unknown> = {};
  for (const path of SOURCE_SYNC_SETTLEMENT_READ_PATHS[kind]) {
    let current: unknown = record;
    let present = true;
    for (const key of path === "$" ? [] : path.slice(2).split(".")) {
      if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
        present = false;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (present && current !== undefined) value[path] = structuredClone(current);
  }
  return value;
}

export function sourceSyncSettlementReadMatches(
  read: SourceSyncSettlementRead,
  record: unknown,
): boolean {
  return stableStringify(read.value) ===
    stableStringify(projectSourceSyncSettlementRead(read.kind, record));
}

export function sourceSyncSettlementCensusMatches(
  observed: readonly Capsule[],
  current: readonly Capsule[],
): boolean {
  if (observed.length !== current.length) return false;
  const byId = new Map(current.map((capsule) => [capsule.id, capsule]));
  return byId.size === current.length && observed.every((capsule) => {
    const actual = byId.get(capsule.id);
    return actual !== undefined && stableStringify(actual) === stableStringify(capsule);
  });
}

/**
 * Compute observations only. The owning store must validate the COMPLETE
 * census and read-set before committing any terminal result or projection.
 * A broken applied lineage cannot be silently classified as unaffected.
 */
export async function observeSourceSyncSettlement(
  reader: SourceSyncSettlementReader,
  snapshot: SourceSnapshot,
  terminalRun: SourceSyncRun,
  observedCapsules: readonly Capsule[],
): Promise<SourceSyncSettlementObservation> {
  // Stores supply a bounded non-destroyed census (at most limit + 1 rows),
  // using their native query/Map boundary rather than loading all tombstones.
  const capsules = structuredClone(observedCapsules);
  if (capsules.length > MAX_SOURCE_RECONCILIATION_CAPSULES ||
    new Set(capsules.map((capsule) => capsule.id)).size !== capsules.length ||
    capsules.some((capsule) => capsule.workspaceId !== terminalRun.workspaceId ||
      capsule.status === "destroyed")) {
    throw new SourceSyncSettlementConflictError();
  }
  const reads: SourceSyncSettlementRead[] = [];
  const cache = new Map<string, unknown>();
  async function read<T>(
    kind: SourceSyncSettlementReadKind,
    id: string,
    get: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([kind, id]);
    if (cache.has(key)) return cache.get(key) as T;
    const record = structuredClone(await get());
    cache.set(key, record);
    reads.push({ kind, id, value: projectSourceSyncSettlementRead(kind, record) });
    return record;
  }
  const tracked: CapsuleSourceRevisionReader = {
    getSource: (id) => read("source", id, () => reader.getSource(id)),
    getStateVersion: (id) => read("state", id, () => reader.getStateVersion(id)),
    getApplyRun: (id) => read("apply", id, () => reader.getApplyRun(id)),
    getBackupRun: (id) => read("restore", id, () => reader.getBackupRun(id)),
    getPlanRun: (id) => read("plan", id, () => reader.getPlanRun(id)),
    getSourceSnapshot: (id) => read("snapshot", id, () => reader.getSourceSnapshot(id)),
  };
  // Even an empty census must fence the Source whose cursor will be merged.
  await tracked.getSource(terminalRun.sourceId);
  const changes: SourceSyncSettlementObservation["changes"][number][] = [];
  for (const capsule of capsules) {
    if (capsule.sourceId !== terminalRun.sourceId ||
      (capsule.status !== "active" && capsule.status !== "stale")) continue;
    const adopted = await getCapsuleAdoptedSourceSnapshot(tracked, capsule);
    if (!adopted || adopted.ref !== snapshot.ref || adopted.path !== snapshot.path ||
      adopted.id === snapshot.id ||
      (adopted.origin === "git" && snapshot.origin === "git" &&
        adopted.sourceId === snapshot.sourceId && adopted.url === snapshot.url &&
        adopted.resolvedCommit === snapshot.resolvedCommit)) continue;
    const updated: Capsule = { ...capsule, status: "stale", updatedAt: snapshot.fetchedAt };
    changes.push({
      capsule: updated,
      activity: {
        // Length-prefix the Run component so arbitrary ids cannot alias pairs.
        id: `act_source_sync_${terminalRun.id.length}_${terminalRun.id}_${capsule.id}`,
        workspaceId: capsule.workspaceId,
        action: "capsule.stale",
        targetType: "capsule",
        targetId: capsule.id,
        metadata: {
          reason: "source_ref_changed",
          sourceId: terminalRun.sourceId,
          sourceSnapshotId: snapshot.id,
          previousSourceSnapshotId: adopted.id,
          resolvedCommit: snapshot.resolvedCommit,
          previousResolvedCommit: adopted.resolvedCommit,
          ref: terminalRun.ref,
          path: terminalRun.path,
        },
        createdAt: snapshot.fetchedAt,
      },
    });
  }
  return { capsules, reads, changes };
}
