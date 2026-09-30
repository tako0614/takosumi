/**
 * Operator-only, state-only recovery of one failed initial Capsule create.
 *
 * This module deliberately has no HTTP entrypoint, runner dispatch, state-byte
 * reader, or artifact writer. The caller supplies an operator-authorized
 * verifier port backed by the encrypted state artifact adapter. Its returned
 * descriptor is checked again at the atomic ledger boundary. A path, mutable
 * URL, or a fabricated runner receipt is not a recovery artifact.
 */
import type { ApplyRun, InstallConfig, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { ActivityEvent } from "takosumi-contract/activity";
import { stableJsonDigest, stableStringify } from "../../adapters/source/digest.ts";
import type { OpenTofuControlStore, StoredRunRecord, StoredSource, WorkspaceManagementAuthority } from "./store.ts";
import { OpenTofuControllerError } from "./errors.ts";

export const VERIFIED_RECOVERY_ARTIFACT_FORMAT =
  "takosumi.verified-state-recovery-artifact/v1" as const;

/** Returned only by an operator-selected encrypted state adapter verifier. */
export interface VerifiedRecoveryArtifact {
  readonly format: typeof VERIFIED_RECOVERY_ARTIFACT_FORMAT;
  readonly immutable: true;
  readonly adapterAllocated: true;
  readonly readbackVerified: true;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: 1;
  readonly recoveryRunId: string;
  readonly stateRef: string;
  /** Digest of encrypted bytes at the immutable storage coordinate. */
  readonly encryptedDigest: `sha256:${string}`;
  /** Digest of the decrypted OpenTofu state bytes. */
  readonly plaintextSha256: `sha256:${string}`;
  /** Digest of the verifier's bounded, value-free custody evidence. */
  readonly evidenceDigest: `sha256:${string}`;
}

export interface RecoveryArtifactVerifier {
  verify(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly failedApplyRunId: string;
    readonly recoveryRunId: string;
    readonly artifactHandle: string;
  }): Promise<VerifiedRecoveryArtifact>;
}

export interface CommitRecoveredStateInput {
  readonly expectedCapsule: Capsule;
  readonly expectedInstallConfig: InstallConfig;
  readonly expectedSource: StoredSource;
  readonly expectedSourceSnapshot: SourceSnapshot;
  readonly expectedPlanRun: PlanRun;
  readonly expectedFailedApplyRun: ApplyRun;
  readonly expectedWorkspaceManagement: WorkspaceManagementAuthority;
  readonly expectedExecutionAuthorityEpoch: number;
  readonly artifact: VerifiedRecoveryArtifact;
  readonly recoveryRun: Run;
  readonly stateVersion: StateVersion;
  readonly activity: ActivityEvent;
}

export type CommitRecoveredStateResult =
  | { readonly status: "committed" | "replayed"; readonly run: Run; readonly stateVersion: StateVersion; readonly capsule: Capsule }
  | { readonly status: "conflict" };

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface RecoveryCommitObservation {
  readonly capsule?: Capsule;
  readonly installConfig?: InstallConfig;
  readonly source?: StoredSource;
  readonly sourceSnapshot?: SourceSnapshot;
  readonly planRun?: PlanRun;
  readonly failedApplyRun?: ApplyRun;
  readonly workspaceManagement?: WorkspaceManagementAuthority;
  readonly executionAuthorityEpoch?: number;
  readonly existingRun?: Run;
  readonly existingStateVersion?: StateVersion;
  readonly existingGenerationOne?: StateVersion;
  readonly existingActivity?: ActivityEvent;
  readonly runsForCapsule: readonly StoredRunRecord[];
}

/** Exact full-record CAS preflight. SQL/D1 also fence these rows inside the write. */
export function recoveryObservationMatches(input: CommitRecoveredStateInput, observed: RecoveryCommitObservation): boolean {
  const exact = (left: unknown, right: unknown) => stableStringify(left ?? null) === stableStringify(right ?? null);
  if (!exact(observed.capsule, input.expectedCapsule) ||
    !exact(observed.installConfig, input.expectedInstallConfig) ||
    !exact(observed.source, input.expectedSource) ||
    !exact(observed.sourceSnapshot, input.expectedSourceSnapshot) ||
    !exact(observed.planRun, input.expectedPlanRun) ||
    !exact(observed.failedApplyRun, input.expectedFailedApplyRun) ||
    !exact(observed.workspaceManagement, input.expectedWorkspaceManagement) ||
    observed.executionAuthorityEpoch !== input.expectedExecutionAuthorityEpoch ||
    observed.existingRun !== undefined || observed.existingStateVersion !== undefined ||
    observed.existingGenerationOne !== undefined || observed.existingActivity !== undefined) return false;
  const failedAt = Number(input.expectedFailedApplyRun.createdAt);
  return !observed.runsForCapsule.some((row) => {
    if (row.id === input.expectedPlanRun.id || row.id === input.expectedFailedApplyRun.id) return false;
    const time = typeof row.createdAt === "number" ? row.createdAt : Date.parse(row.createdAt);
    return !Number.isFinite(time) || time >= failedAt || row.status === "queued" ||
      row.status === "running" || row.status === "waiting_approval";
  });
}

export function assertVerifiedRecoveryArtifact(value: unknown): asserts value is VerifiedRecoveryArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("verified recovery artifact is required");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [
    "adapterAllocated", "capsuleId", "encryptedDigest", "environment", "evidenceDigest", "format", "generation", "immutable", "plaintextSha256", "readbackVerified", "recoveryRunId", "stateRef", "workspaceId",
  ].sort().join(",") ||
    record.format !== VERIFIED_RECOVERY_ARTIFACT_FORMAT ||
    record.immutable !== true || record.adapterAllocated !== true || record.readbackVerified !== true ||
    typeof record.workspaceId !== "string" || !record.workspaceId.trim() ||
    typeof record.capsuleId !== "string" || !record.capsuleId.trim() ||
    typeof record.environment !== "string" || !record.environment.trim() ||
    record.generation !== 1 || typeof record.recoveryRunId !== "string" || !record.recoveryRunId.trim() ||
    typeof record.stateRef !== "string" || record.stateRef.trim() === "" ||
    record.stateRef.includes("://") || record.stateRef.startsWith("/") ||
    !SHA256.test(String(record.encryptedDigest)) ||
    !SHA256.test(String(record.plaintextSha256)) ||
    !SHA256.test(String(record.evidenceDigest))) {
    throw new TypeError("recovery artifact must be an immutable, adapter-allocated, value-free descriptor");
  }
}

export function recoveryConflict(message: string): OpenTofuControllerError {
  return new OpenTofuControllerError("failed_precondition", message, { reason: "state_recovery_conflict" });
}

/** Resolve a recovered StateVersion only through its exact failed Apply + pinned Plan. */
export async function recoveryPlanForStateVersion(
  reader: Pick<OpenTofuControlStore, "getStateRecoveryRun" | "getApplyRun" | "getPlanRun" | "getSourceSnapshot">,
  capsule: Capsule,
  state: StateVersion,
): Promise<PlanRun | undefined> {
  const run = await reader.getStateRecoveryRun(state.createdByRunId);
  if (!run || run.type !== "state_recovery" || run.status !== "succeeded" ||
    run.workspaceId !== capsule.workspaceId || run.capsuleId !== capsule.id ||
    run.environment !== capsule.environment || run.executionEvidence !== undefined ||
    state.workspaceId !== capsule.workspaceId || state.capsuleId !== capsule.id ||
    state.environment !== capsule.environment || state.generation !== 1 ||
    run.stateRecovery?.recoveredStateVersionId !== state.id ||
    run.stateRecovery.plaintextSha256 !== state.digest ||
    run.stateRecovery.sourceSnapshotId !== run.sourceSnapshotId ||
    !run.planRunId) return undefined;
  const [failed, plan, snapshot] = await Promise.all([
    reader.getApplyRun(run.stateRecovery.failedApplyRunId),
    reader.getPlanRun(run.planRunId),
    reader.getSourceSnapshot(run.sourceSnapshotId!),
  ]);
  return failed?.id === run.stateRecovery.failedApplyRunId &&
    failed.status === "failed" && failed.operation === "create" &&
    failed.workspaceId === capsule.workspaceId && failed.capsuleId === capsule.id &&
    failed.stateVersionId === undefined && failed.outputId === undefined &&
    failed.planRunId === plan?.id &&
    plan?.status === "succeeded" && plan.operation === "create" &&
    plan.workspaceId === capsule.workspaceId && plan.capsuleId === capsule.id &&
    plan.sourceSnapshotId === run.sourceSnapshotId &&
    snapshot !== undefined && recoveryPlanMatchesSource(capsule, plan, snapshot)
    ? plan : undefined;
}

function recoveryPlanMatchesSource(capsule: Capsule, plan: PlanRun, snapshot: SourceSnapshot): boolean {
  return plan.capsuleContext?.workspaceId === capsule.workspaceId &&
    plan.capsuleContext.capsuleId === capsule.id &&
    plan.capsuleContext.environment === capsule.environment &&
    snapshot.workspaceId === capsule.workspaceId && snapshot.sourceId === capsule.sourceId &&
    snapshot.origin === "git" && plan.source.kind === "git" &&
    plan.source.url === snapshot.url &&
    plan.source.commit?.toLowerCase() === snapshot.resolvedCommit.toLowerCase();
}

export function exactRecoveryReplay(
  existing: Run | undefined,
  input: CommitRecoveredStateInput,
  state: StateVersion | undefined,
  capsule: Capsule | undefined,
  epoch?: number,
  activity?: ActivityEvent,
): existing is Run {
  return existing?.type === "state_recovery" && existing.status === "succeeded" &&
    stableStringify(existing) === stableStringify(input.recoveryRun) &&
    stableStringify(state) === stableStringify(input.stateVersion) &&
    capsule !== undefined && stableStringify(JSON.parse(JSON.stringify(capsule))) === stableStringify(JSON.parse(JSON.stringify({
      ...input.expectedCapsule,
      currentStateVersionId: input.stateVersion.id,
      currentStateGeneration: 1,
      currentOutputId: undefined,
      status: "error",
      updatedAt: input.recoveryRun.finishedAt,
    }))) &&
    epoch === input.expectedExecutionAuthorityEpoch + 1 &&
    stableStringify(activity) === stableStringify(input.activity);
}

/** Pure candidate validation; every store repeats it after reading its atomic snapshot. */
export function assertRecoveryCommitCandidate(input: CommitRecoveredStateInput): void {
  const { expectedCapsule: capsule, expectedInstallConfig: config, expectedSource: source, expectedSourceSnapshot: snapshot,
    expectedPlanRun: plan, expectedFailedApplyRun: failed, expectedWorkspaceManagement: management,
    expectedExecutionAuthorityEpoch: epoch, artifact, recoveryRun: run, stateVersion: state } = input;
  assertVerifiedRecoveryArtifact(artifact);
  if (capsule.status !== "error" || capsule.currentStateGeneration !== 0 ||
    capsule.currentStateVersionId !== undefined || capsule.currentOutputId !== undefined ||
    config.id !== capsule.installConfigId || config.workspaceId !== capsule.workspaceId ||
    source.id !== capsule.sourceId || source.workspaceId !== capsule.workspaceId ||
    source.url !== snapshot.url ||
    snapshot.id !== plan.sourceSnapshotId || snapshot.workspaceId !== capsule.workspaceId ||
    snapshot.sourceId !== capsule.sourceId || snapshot.origin !== "git" ||
    !recoveryPlanMatchesSource(capsule, plan, snapshot) ||
    plan.source.kind !== "git" || plan.source.commit?.toLowerCase() !== snapshot.resolvedCommit.toLowerCase() ||
    plan.workspaceId !== capsule.workspaceId || plan.capsuleId !== capsule.id ||
    plan.operation !== "create" || plan.status !== "succeeded" ||
    plan.baseStateGeneration !== 0 || plan.capsuleCurrentStateVersionId != null ||
    (plan.appliedApplyRunId !== undefined && plan.appliedApplyRunId !== failed.id) ||
    failed.workspaceId !== capsule.workspaceId || failed.capsuleId !== capsule.id ||
    failed.planRunId !== plan.id || failed.operation !== "create" || failed.status !== "failed" ||
    failed.stateVersionId !== undefined || failed.outputId !== undefined ||
    failed.expected.planRunId !== plan.id || failed.expected.capsuleId !== capsule.id ||
    failed.expected.currentStateVersionId != null ||
    failed.runnerProfileId !== plan.runnerProfileId ||
    failed.expected.runnerProfileId !== plan.runnerProfileId ||
    failed.expected.sourceDigest !== plan.sourceDigest ||
    failed.expected.variablesDigest !== plan.variablesDigest ||
    failed.expected.policyDecisionDigest !== plan.policyDecisionDigest ||
    failed.expected.planDigest !== plan.planDigest ||
    !plan.planArtifact || failed.expected.planArtifactDigest !== plan.planArtifact.digest ||
    failed.expected.providerLockDigest !== plan.providerLockDigest ||
    failed.expected.sourceCommit !== plan.sourceCommit ||
    failed.expected.resolvedProviderBindingsDigest !== plan.resolvedProviderBindingsDigest ||
    failed.expected.capsuleExecutionAuthorityEpoch !== epoch ||
    plan.capsuleExecutionAuthorityEpoch !== epoch ||
    artifact.workspaceId !== capsule.workspaceId || artifact.capsuleId !== capsule.id ||
    artifact.environment !== capsule.environment || artifact.generation !== 1 ||
    artifact.recoveryRunId !== run.id ||
    failed.executionEvidence !== undefined ||
    (failed.auditEvents.some((event) => event.data?.providerDispatched === false) &&
      !failed.auditEvents.some((event) => event.data?.providerDispatched === true)) ||
    management.workspaceId !== capsule.workspaceId || management.managementState !== "active" ||
    !Number.isSafeInteger(management.managementEpoch) || management.managementEpoch < 1 ||
    !Number.isSafeInteger(epoch) || epoch < 1 || epoch >= Number.MAX_SAFE_INTEGER ||
    run.type !== "state_recovery" || run.status !== "succeeded" ||
    run.workspaceId !== capsule.workspaceId || run.capsuleId !== capsule.id ||
    run.environment !== capsule.environment || run.planRunId !== plan.id ||
    run.sourceSnapshotId !== snapshot.id || run.executionEvidence !== undefined ||
    !run.stateRecovery || run.stateRecovery.failedApplyRunId !== failed.id ||
    run.stateRecovery.recoveredStateVersionId !== state.id ||
    run.stateRecovery.sourceSnapshotId !== snapshot.id ||
    run.stateRecovery.artifactEvidenceDigest !== artifact.evidenceDigest ||
    run.stateRecovery.plaintextSha256 !== artifact.plaintextSha256 ||
    run.stateRecovery.encryptedDigest !== artifact.encryptedDigest ||
    state.workspaceId !== capsule.workspaceId || state.capsuleId !== capsule.id ||
    state.environment !== capsule.environment || state.generation !== 1 ||
    state.createdByRunId !== run.id || state.stateRef !== artifact.stateRef ||
    state.digest !== artifact.plaintextSha256 || state.createdAt !== run.finishedAt ||
    !SHA256.test(state.digest) || !Number.isFinite(Date.parse(run.createdAt)) ||
    run.createdAt !== run.startedAt || run.startedAt !== run.finishedAt ||
    input.activity.workspaceId !== capsule.workspaceId ||
    input.activity.actorId !== run.createdBy ||
    input.activity.action !== "capsule.state_recovered" ||
    input.activity.targetType !== "capsule" || input.activity.targetId !== capsule.id ||
    input.activity.runId !== run.id || input.activity.createdAt !== run.finishedAt ||
    stableStringify(input.activity.metadata) !== stableStringify({
      failedApplyRunId: failed.id, stateVersionId: state.id,
      sourceSnapshotId: snapshot.id, artifactEvidenceDigest: artifact.evidenceDigest,
    })) {
    throw recoveryConflict("state recovery no longer matches the failed initial create and immutable artifact");
  }
}

/** No route calls this: the operator must compose a verified artifact port first. */
export async function recoverFailedInitialCreateState(input: {
  readonly store: OpenTofuControlStore;
  readonly verifier: RecoveryArtifactVerifier;
  readonly artifactHandle: string;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  readonly createdBy: string;
  readonly now: string;
}): Promise<CommitRecoveredStateResult> {
  const failed = await input.store.getApplyRun(input.failedApplyRunId);
  if (!failed?.capsuleId) throw recoveryConflict("failed Apply is unavailable");
  const capsule = await input.store.getCapsule(failed.capsuleId);
  const plan = await input.store.getPlanRun(failed.planRunId);
  if (!capsule || !plan?.sourceSnapshotId) throw recoveryConflict("recovery lineage is unavailable");
  const [config, source, snapshot, management, epoch] = await Promise.all([
    input.store.getInstallConfig(capsule.installConfigId),
    input.store.getSource(capsule.sourceId),
    input.store.getSourceSnapshot(plan.sourceSnapshotId),
    input.store.getWorkspaceManagement(capsule.workspaceId),
    input.store.getCapsuleExecutionAuthorityEpoch(capsule.id),
  ]);
  if (!config || !source || !snapshot || management?.managementState !== "active" || epoch === undefined) {
    throw recoveryConflict("recovery authority is unavailable");
  }
  const artifact = await input.verifier.verify({
    workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    failedApplyRunId: failed.id, recoveryRunId: input.recoveryRunId,
    artifactHandle: input.artifactHandle,
  });
  assertVerifiedRecoveryArtifact(artifact);
  const stateDigest = await stableJsonDigest({ kind: "takosumi.state-recovery-state-version-id@v1", runId: input.recoveryRunId });
  const stateVersionId = `state_${stateDigest.slice("sha256:".length)}`;
  const run: Run = {
    id: input.recoveryRunId, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    environment: capsule.environment, planRunId: plan.id, sourceSnapshotId: snapshot.id,
    type: "state_recovery", status: "succeeded", createdBy: input.createdBy,
    createdAt: input.now, startedAt: input.now, finishedAt: input.now,
    stateRecovery: {
      failedApplyRunId: failed.id, recoveredStateVersionId: stateVersionId,
      sourceSnapshotId: snapshot.id, artifactEvidenceDigest: artifact.evidenceDigest,
      plaintextSha256: artifact.plaintextSha256, encryptedDigest: artifact.encryptedDigest,
    },
  };
  const stateVersion: StateVersion = {
    id: stateVersionId, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    environment: capsule.environment, generation: 1, stateRef: artifact.stateRef,
    digest: artifact.plaintextSha256, createdByRunId: run.id, createdAt: input.now,
  };
  const activityDigest = await stableJsonDigest({ kind: "takosumi.state-recovery-activity-id@v1", runId: run.id });
  const activity: ActivityEvent = {
    id: `activity_${activityDigest.slice("sha256:".length)}`,
    workspaceId: capsule.workspaceId, actorId: run.createdBy,
    action: "capsule.state_recovered", targetType: "capsule", targetId: capsule.id,
    runId: run.id, createdAt: input.now,
    metadata: {
      failedApplyRunId: failed.id, stateVersionId: stateVersion.id,
      sourceSnapshotId: snapshot.id, artifactEvidenceDigest: artifact.evidenceDigest,
    },
  };
  const command: CommitRecoveredStateInput = {
    expectedCapsule: capsule, expectedInstallConfig: config,
    expectedSource: source,
    expectedSourceSnapshot: snapshot, expectedPlanRun: plan,
    expectedFailedApplyRun: failed, expectedWorkspaceManagement: management as WorkspaceManagementAuthority,
    expectedExecutionAuthorityEpoch: epoch, artifact, recoveryRun: run, stateVersion, activity,
  };
  // A lost acknowledgement must not force the already-committed Capsule back
  // through the initial-create precondition (its generation is now one).
  // Reconcile only the exact immutable artifact and canonical ledger identity;
  // this read path does not create another Run, state, or Activity row.
  const existing = await input.store.getStateRecoveryRun(run.id);
  if (existing) {
    const currentState = await input.store.getStateVersion(stateVersion.id);
    const currentEpoch = await input.store.getCapsuleExecutionAuthorityEpoch(capsule.id);
    const currentActivity = await input.store.getActivityEvent(activity.id);
    const provenance = currentState && await recoveryPlanForStateVersion(input.store, capsule, currentState);
    if (stableStringify(existing) !== stableStringify(run) ||
      stableStringify(currentState) !== stableStringify(stateVersion) ||
      stableStringify(currentActivity) !== stableStringify(activity) ||
      capsule.status !== "error" || capsule.currentStateVersionId !== stateVersion.id ||
      capsule.currentStateGeneration !== 1 || capsule.currentOutputId !== undefined ||
      capsule.updatedAt !== run.finishedAt ||
      currentEpoch !== (plan.capsuleExecutionAuthorityEpoch ?? 0) + 1 ||
      provenance?.id !== plan.id ||
      artifact.workspaceId !== capsule.workspaceId || artifact.capsuleId !== capsule.id ||
      artifact.environment !== capsule.environment || artifact.generation !== 1 ||
      artifact.recoveryRunId !== run.id || artifact.stateRef !== stateVersion.stateRef ||
      artifact.plaintextSha256 !== stateVersion.digest ||
      artifact.encryptedDigest !== run.stateRecovery?.encryptedDigest ||
      artifact.evidenceDigest !== run.stateRecovery?.artifactEvidenceDigest) {
      throw recoveryConflict("state recovery replay no longer matches its immutable commit");
    }
    return { status: "replayed", run: existing, stateVersion: currentState!, capsule };
  }
  assertRecoveryCommitCandidate(command);
  return await input.store.commitRecoveredState(command);
}
