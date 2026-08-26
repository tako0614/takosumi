import type { ApplyRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { InstallConfigCommittedPostApplyRecoveryProof } from "takosumi-contract/install-configs";
import type { Output } from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";

import {
  stableJsonDigest,
  stableStringify,
} from "../../adapters/source/digest.ts";

export const COMMITTED_POST_APPLY_RECOVERY_EVIDENCE_CONTRACT =
  "takosumi.capsule-install-config-committed-post-apply-recovery/v1" as const;

export interface CommittedPostApplyRecoveryRows {
  readonly failedApplyRun: ApplyRun;
  readonly stateVersion: StateVersion;
  readonly output: Output;
}

/**
 * One pure authority predicate shared by credential recovery and InstallConfig
 * re-adoption. It accepts only provider-successful state/output commit followed
 * by one terminal post_apply failure. Provider-failed persisted partial state
 * deliberately does not satisfy this predicate.
 */
export function exactCommittedPostApplyRecoveryRowsMatch(
  capsule: Capsule,
  rows: CommittedPostApplyRecoveryRows,
): boolean {
  const { failedApplyRun: failed, stateVersion, output } = rows;
  if (
    capsule.status !== "error" ||
    capsule.currentStateVersionId === undefined ||
    capsule.currentOutputId === undefined ||
    failed.status !== "failed" ||
    (failed.operation !== "create" && failed.operation !== "update") ||
    failed.workspaceId !== capsule.workspaceId ||
    failed.capsuleId !== capsule.id ||
    failed.stateVersionId !== capsule.currentStateVersionId ||
    failed.outputId !== capsule.currentOutputId
  ) {
    return false;
  }

  const completedReceipts = failed.auditEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "apply.completed");
  const failedReceipts = failed.auditEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "apply.failed");
  if (completedReceipts.length !== 1 || failedReceipts.length !== 1) {
    return false;
  }
  const completedReceipt = completedReceipts[0]!;
  const failedReceipt = failedReceipts[0]!;
  // Audit-event array order is the canonical happens-before when the two
  // receipts share the same commit clock.
  if (
    completedReceipt.index >= failedReceipt.index ||
    completedReceipt.event.data?.stateVersionId !== stateVersion.id ||
    completedReceipt.event.data.outputId !== output.id ||
    failedReceipt.event.data?.providerDispatched !== true ||
    failedReceipt.event.data.providerApplySucceeded !== true ||
    failedReceipt.event.data.lifecycleActionPhase !== "post_apply" ||
    !terminalLifecycleFailureStatus(
      failedReceipt.event.data.lifecycleActionStatus,
    )
  ) {
    return false;
  }

  return (
    stateVersion.id === capsule.currentStateVersionId &&
    stateVersion.workspaceId === capsule.workspaceId &&
    stateVersion.capsuleId === capsule.id &&
    stateVersion.environment === capsule.environment &&
    stateVersion.generation === capsule.currentStateGeneration &&
    stateVersion.createdByRunId === failed.id &&
    output.id === capsule.currentOutputId &&
    output.workspaceId === capsule.workspaceId &&
    output.capsuleId === capsule.id &&
    output.stateGeneration === stateVersion.generation &&
    output.stateGeneration === capsule.currentStateGeneration
  );
}

/** Derives the value-free full-row receipt only after the pure verifier passes. */
export async function deriveCommittedPostApplyRecoveryProof(
  capsule: Capsule,
  rows: CommittedPostApplyRecoveryRows,
): Promise<InstallConfigCommittedPostApplyRecoveryProof | undefined> {
  if (!exactCommittedPostApplyRecoveryRowsMatch(capsule, rows)) {
    return undefined;
  }
  const [failedApplyRunDigest, stateVersionDigest, outputDigest] =
    await Promise.all([
      stableJsonDigest(rows.failedApplyRun),
      stableJsonDigest(rows.stateVersion),
      stableJsonDigest(rows.output),
    ]);
  const proofCore = {
    failedApplyRunId: rows.failedApplyRun.id,
    failedApplyRunDigest,
    stateVersionId: rows.stateVersion.id,
    stateVersionDigest,
    outputId: rows.output.id,
    outputDigest,
    stateGeneration: rows.stateVersion.generation,
  };
  return {
    ...proofCore,
    evidenceDigest: await stableJsonDigest({
      contract: COMMITTED_POST_APPLY_RECOVERY_EVIDENCE_CONTRACT,
      ...proofCore,
    }),
  };
}

/** Re-derives and compares every receipt field, including the domain seal. */
export async function committedPostApplyRecoveryProofMatches(
  proof: InstallConfigCommittedPostApplyRecoveryProof,
  capsule: Capsule,
  rows: CommittedPostApplyRecoveryRows,
): Promise<boolean> {
  const derived = await deriveCommittedPostApplyRecoveryProof(capsule, rows);
  return derived !== undefined && exactRecoveryProofsEqual(derived, proof);
}

export function exactRecoveryProofsEqual(
  left: InstallConfigCommittedPostApplyRecoveryProof | undefined,
  right: InstallConfigCommittedPostApplyRecoveryProof | undefined,
): boolean {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function terminalLifecycleFailureStatus(value: unknown): boolean {
  return (
    value === "failed" ||
    value === "skipped" ||
    value === "unavailable" ||
    value === "error"
  );
}
