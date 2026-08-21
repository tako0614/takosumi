/**
 * Canonical Git revision adopted by a Capsule's current applied state.
 *
 * The tracking authority already exists in the durable lifecycle ledger:
 * Capsule.currentStateVersionId -> StateVersion.createdByRunId -> ApplyRun ->
 * PlanRun.sourceSnapshotId. Restore-created StateVersions follow their exact
 * restoredFromStateVersionId edge recursively. This module deliberately does
 * not read or mutate Source.defaultRef: that field remains the shared Source's
 * default sync address, not per-Capsule deployment state.
 */

import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { OpenTofuControllerError } from "./errors.ts";
import type { OpenTofuControlStore } from "./store.ts";

export const CAPSULE_SOURCE_REVISION_LINEAGE_MISMATCH_REASON =
  "capsule_source_revision_lineage_mismatch" as const;

/**
 * Resolves the immutable SourceSnapshot adopted by the Capsule's current
 * StateVersion. An unapplied Capsule has no adopted revision. Once a current
 * StateVersion exists, any missing or cross-scope lineage fails closed.
 */
export async function getCapsuleAdoptedSourceSnapshot(
  store: OpenTofuControlStore,
  capsule: Capsule,
): Promise<SourceSnapshot | undefined> {
  if (!capsule.currentStateVersionId) {
    if (capsule.currentStateGeneration !== 0) {
      throw lineageMismatch(
        `Capsule ${capsule.id} has a state generation without a current StateVersion`,
      );
    }
    return undefined;
  }
  const stateVersion = await store.getStateVersion(
    capsule.currentStateVersionId,
  );
  if (!stateVersion) {
    throw lineageMismatch(
      `Capsule ${capsule.id} current StateVersion is not available`,
    );
  }
  assertStateVersionScope(capsule, stateVersion, true);

  const planRun = await planRunForStateVersion(
    store,
    capsule,
    stateVersion,
    new Set(),
  );
  if (!planRun.sourceSnapshotId) {
    throw lineageMismatch(
      `Capsule ${capsule.id} current PlanRun has no SourceSnapshot provenance`,
    );
  }
  const [source, snapshot] = await Promise.all([
    store.getSource(capsule.sourceId),
    store.getSourceSnapshot(planRun.sourceSnapshotId),
  ]);
  if (
    !source ||
    source.id !== capsule.sourceId ||
    source.workspaceId !== capsule.workspaceId
  ) {
    throw lineageMismatch(
      `Capsule ${capsule.id} Source identity is not available in its Workspace`,
    );
  }
  if (
    !snapshot ||
    snapshot.id !== planRun.sourceSnapshotId ||
    snapshot.workspaceId !== capsule.workspaceId ||
    snapshot.sourceId !== source.id ||
    snapshot.url !== source.url ||
    snapshot.ref.trim() === "" ||
    snapshot.path.trim() === "" ||
    snapshot.resolvedCommit.trim() === ""
  ) {
    throw lineageMismatch(
      `Capsule ${capsule.id} adopted SourceSnapshot does not match its Source`,
    );
  }
  if (
    planRun.source.kind !== "git" ||
    planRun.source.commit?.toLowerCase() !==
      snapshot.resolvedCommit.toLowerCase()
  ) {
    throw lineageMismatch(
      `Capsule ${capsule.id} PlanRun source does not match its SourceSnapshot`,
    );
  }
  return snapshot;
}

async function planRunForStateVersion(
  store: OpenTofuControlStore,
  capsule: Capsule,
  stateVersion: StateVersion,
  seen: Set<string>,
): Promise<PlanRun> {
  if (seen.has(stateVersion.id) || seen.size >= 64) {
    throw lineageMismatch(
      `Capsule ${capsule.id} StateVersion restore lineage contains a cycle`,
    );
  }
  seen.add(stateVersion.id);

  const applyRun = await store.getApplyRun(stateVersion.createdByRunId);
  if (applyRun) {
    if (
      applyRun.id !== stateVersion.createdByRunId ||
      applyRun.workspaceId !== capsule.workspaceId ||
      applyRun.capsuleId !== capsule.id ||
      applyRun.stateVersionId !== stateVersion.id ||
      applyRun.expected?.capsuleId !== capsule.id ||
      applyRun.expected.planRunId !== applyRun.planRunId ||
      (applyRun.status !== "succeeded" && applyRun.status !== "failed")
    ) {
      throw lineageMismatch(
        `Capsule ${capsule.id} StateVersion does not match its creating ApplyRun`,
      );
    }
    const planRun = await store.getPlanRun(applyRun.planRunId);
    if (
      !planRun ||
      planRun.id !== applyRun.planRunId ||
      planRun.workspaceId !== capsule.workspaceId ||
      planRun.capsuleId !== capsule.id ||
      planRun.operation !== applyRun.operation ||
      (planRun.appliedApplyRunId !== undefined &&
        planRun.appliedApplyRunId !== applyRun.id) ||
      (planRun.capsuleContext !== undefined &&
        (planRun.capsuleContext.workspaceId !== capsule.workspaceId ||
          planRun.capsuleContext.capsuleId !== capsule.id ||
          planRun.capsuleContext.environment !== capsule.environment))
    ) {
      throw lineageMismatch(
        `Capsule ${capsule.id} ApplyRun does not match its reviewed PlanRun`,
      );
    }
    return planRun;
  }

  const restoreRun = await store.getBackupRun(stateVersion.createdByRunId);
  if (
    !restoreRun ||
    restoreRun.id !== stateVersion.createdByRunId ||
    restoreRun.type !== "restore" ||
    restoreRun.status !== "succeeded" ||
    restoreRun.workspaceId !== capsule.workspaceId ||
    restoreRun.capsuleId !== capsule.id ||
    restoreRun.environment !== capsule.environment ||
    restoreRun.restoredStateVersionId !== stateVersion.id ||
    !restoreRun.restoredFromStateVersionId
  ) {
    throw lineageMismatch(
      `Capsule ${capsule.id} StateVersion has no exact Apply or restore provenance`,
    );
  }
  const restoredFrom = await store.getStateVersion(
    restoreRun.restoredFromStateVersionId,
  );
  if (!restoredFrom) {
    throw lineageMismatch(
      `Capsule ${capsule.id} restored-from StateVersion is not available`,
    );
  }
  assertStateVersionScope(capsule, restoredFrom, false);
  if (restoredFrom.generation >= stateVersion.generation) {
    throw lineageMismatch(
      `Capsule ${capsule.id} restore provenance does not point to an older generation`,
    );
  }
  return await planRunForStateVersion(
    store,
    capsule,
    restoredFrom,
    seen,
  );
}

function assertStateVersionScope(
  capsule: Capsule,
  stateVersion: StateVersion,
  current: boolean,
): void {
  if (
    (current && stateVersion.id !== capsule.currentStateVersionId) ||
    stateVersion.workspaceId !== capsule.workspaceId ||
    stateVersion.capsuleId !== capsule.id ||
    stateVersion.environment !== capsule.environment ||
    (current && stateVersion.generation !== capsule.currentStateGeneration)
  ) {
    throw lineageMismatch(
      `StateVersion ${stateVersion.id} does not match Capsule ${capsule.id}`,
    );
  }
}

function lineageMismatch(message: string): OpenTofuControllerError {
  return new OpenTofuControllerError("failed_precondition", message, {
    reason: CAPSULE_SOURCE_REVISION_LINEAGE_MISMATCH_REASON,
  });
}
