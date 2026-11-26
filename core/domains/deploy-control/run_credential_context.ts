import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import { assertRunExecutionEvidence } from "takosumi-contract/runs";
import type { StateVersion } from "takosumi-contract/state-versions";

import type { OpenTofuControlStore } from "./store.ts";
import { exactCommittedPostApplyRecoveryRowsMatch } from "./committed_post_apply_recovery.ts";
import { recoveryPlanForStateVersion, stateVersionIdForRecoveryRun } from "./operator_state_recovery.ts";

export type CapsuleRunCredentialPhase = "plan" | "apply" | "destroy";
export type CapsuleRunCredentialLifecycleIntent = "provision" | "destroy";

/**
 * Canonical, non-secret Run authority re-read from the durable control ledger.
 * Caller-supplied metadata is only a lookup key and is never returned unless
 * every Capsule and Run invariant below matches the current stored rows.
 */
export interface CanonicalCapsuleRunCredentialContext {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly installingPrincipalId: string;
  readonly phase: CapsuleRunCredentialPhase;
  /** Derived only from the canonical PlanRun operation, never caller input. */
  readonly lifecycleIntent: CapsuleRunCredentialLifecycleIntent;
}

export type CanonicalCapsuleRunCredentialContextResult =
  | {
      readonly ok: true;
      readonly context: CanonicalCapsuleRunCredentialContext;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_context"
        | "capsule_unavailable"
        | "plan_run_mismatch"
        | "apply_run_mismatch"
        | "apply_plan_mismatch"
        | "runtime_safety_mismatch";
    };

export type CapsuleRunCredentialLedger = Pick<
  OpenTofuControlStore,
  | "getCapsule"
  | "getPlanRun"
  | "getApplyRun"
  | "getStateVersion"
  | "getOutput"
  | "getCapsuleRuntimeSafety"
  | "getStateRecoveryRun"
  | "getSourceSnapshot"
>;

export async function resolveCanonicalCapsuleRunCredentialContext(
  store: CapsuleRunCredentialLedger,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly runId: string;
    readonly phase: CapsuleRunCredentialPhase;
  },
): Promise<CanonicalCapsuleRunCredentialContextResult> {
  const workspaceId = exactNonEmpty(input.workspaceId);
  const capsuleId = exactNonEmpty(input.capsuleId);
  const runId = exactNonEmpty(input.runId);
  if (
    !workspaceId ||
    !capsuleId ||
    !runId ||
    (input.phase !== "plan" &&
      input.phase !== "apply" &&
      input.phase !== "destroy")
  ) {
    return { ok: false, reason: "invalid_context" };
  }

  const capsule = await store.getCapsule(capsuleId);
  const installingPrincipalId = exactNonEmpty(
    capsule?.installingPrincipalId ?? "",
  );
  if (
    !capsule ||
    capsule.workspaceId !== workspaceId ||
    capsule.status === "destroyed" ||
    !installingPrincipalId
  ) {
    return { ok: false, reason: "capsule_unavailable" };
  }

  let planOperation: "create" | "update" | "destroy" | undefined;
  let plannedCapsuleStateVersionId: string | null | undefined;
  if (input.phase === "plan") {
    const run = await store.getPlanRun(runId);
    if (
      !run ||
      run.status !== "running" ||
      run.workspaceId !== workspaceId ||
      run.capsuleId !== capsuleId ||
      (run.capsuleContext !== undefined &&
        (run.capsuleContext.workspaceId !== workspaceId ||
          run.capsuleContext.capsuleId !== capsuleId))
    ) {
      return { ok: false, reason: "plan_run_mismatch" };
    }
    planOperation = run.operation;
    plannedCapsuleStateVersionId = run.capsuleCurrentStateVersionId;
  } else {
    const run = await store.getApplyRun(runId);
    if (
      !run ||
      run.status !== "running" ||
      run.workspaceId !== workspaceId ||
      run.capsuleId !== capsuleId ||
      (run.operation === "destroy") !== (input.phase === "destroy")
    ) {
      return { ok: false, reason: "apply_run_mismatch" };
    }
    const planRun = await store.getPlanRun(run.planRunId);
    if (
      !planRun ||
      planRun.workspaceId !== workspaceId ||
      planRun.capsuleId !== capsuleId ||
      planRun.operation !== run.operation
    ) {
      return { ok: false, reason: "apply_plan_mismatch" };
    }
    planOperation = planRun.operation;
    plannedCapsuleStateVersionId = planRun.capsuleCurrentStateVersionId;
  }

  if (!(await capsuleRunRuntimeSafetyMatches(store, {
    capsule,
    runId,
    phase: input.phase,
    planOperation,
    plannedCapsuleStateVersionId,
  }))) {
    return { ok: false, reason: "runtime_safety_mismatch" };
  }

  return {
    ok: true,
    context: {
      workspaceId,
      capsuleId,
      runId,
      installingPrincipalId,
      phase: input.phase,
      lifecycleIntent: planOperation === "destroy" ? "destroy" : "provision",
    },
  };
}

/** Shared non-secret mutation admission: credentials are not required to use this fence. */
export async function capsuleRunRuntimeSafetyMatches(
  store: CapsuleRunCredentialLedger,
  input: {
    readonly capsule: Capsule;
    readonly runId: string;
    readonly phase: CapsuleRunCredentialPhase;
    readonly planOperation: "create" | "update" | "destroy" | undefined;
    readonly plannedCapsuleStateVersionId: string | null | undefined;
  },
): Promise<boolean> {
  const { capsule, runId, phase, planOperation, plannedCapsuleStateVersionId } = input;
  const { workspaceId, id: capsuleId } = capsule;
  const runtimeSafety = await store.getCapsuleRuntimeSafety(capsuleId);
  const persistedProviderPartialApplyRecoveryMatches =
    phase !== "destroy" &&
    planOperation !== "destroy" &&
    runtimeSafety?.phase === "unknown" &&
    runtimeSafety.runType === "apply" &&
    capsule.currentStateVersionId !== undefined &&
    plannedCapsuleStateVersionId === capsule.currentStateVersionId &&
    (await persistedProviderPartialApplyMatches(
      store,
      runtimeSafety.runId,
      workspaceId,
      capsuleId,
      capsule.currentStateVersionId,
    ));
  const committedPostApplyRecoveryMatches =
    phase !== "destroy" &&
    planOperation !== "destroy" &&
    runtimeSafety?.phase === "unknown" &&
    runtimeSafety.runType === "apply" &&
    capsule.currentStateVersionId !== undefined &&
    plannedCapsuleStateVersionId === capsule.currentStateVersionId &&
    (await committedPostApplyRecoveryRowsMatch(
      store,
      runtimeSafety.runId,
      capsule,
    ));
  const currentApplyExecutionMatches =
    phase === "apply" &&
    planOperation !== "destroy" &&
    runtimeSafety?.phase === "unknown" &&
    runtimeSafety.runType === "apply" &&
    runtimeSafety.runId === runId;
  const runtimeSafetyMatches =
    phase === "destroy"
      ? runtimeSafety?.phase === "terminating" &&
        runtimeSafety.runType === "destroy_apply" &&
        runtimeSafety.runId === runId
      : phase === "plan" && planOperation === "destroy"
        ? runtimeSafety === undefined ||
          runtimeSafety.phase === "safe" ||
          runtimeSafety.phase === "unknown"
        : runtimeSafety === undefined ||
          runtimeSafety.phase === "safe" ||
          currentApplyExecutionMatches ||
          persistedProviderPartialApplyRecoveryMatches ||
          committedPostApplyRecoveryMatches;
  if (!runtimeSafetyMatches) return false;
  if (phase !== "destroy") return true;

  // A queued/running Destroy is deliberately the latest runtime-safety
  // candidate. Exclude only THIS Run to examine the state it is about to
  // mutate; its own terminating projection cannot certify a stale base safe.
  const priorSafety = await store.getCapsuleRuntimeSafety(capsuleId, {
    excludeRunId: runId,
  });
  if (priorSafety === undefined || priorSafety.phase === "safe") return true;
  if (
    priorSafety.phase !== "unknown" ||
    capsule.currentStateVersionId === undefined ||
    plannedCapsuleStateVersionId !== capsule.currentStateVersionId
  ) return false;
  if (priorSafety.runType === "destroy_apply") {
    return persistedProviderPartialDestroyRecoveryMatches(
      store,
      priorSafety.runId,
      capsule,
      runId,
      plannedCapsuleStateVersionId,
    );
  }
  if (priorSafety.runType !== "apply") return false;
  return (
    (await persistedProviderPartialApplyMatches(
      store,
      priorSafety.runId,
      workspaceId,
      capsuleId,
      capsule.currentStateVersionId,
    )) ||
    (await committedPostApplyRecoveryRowsMatch(
      store,
      priorSafety.runId,
      capsule,
    )) ||
    (await committedOutputProjectionFailureMatches(
      store,
      priorSafety.runId,
      capsule,
      plannedCapsuleStateVersionId,
      runId,
    )) ||
    (await recoveredInitialCreateDestroyMatches(
      store,
      priorSafety.runId,
      capsule,
      runId,
      plannedCapsuleStateVersionId,
    ))
  );
}

/** Read the exact provider-failed Destroy that produced this retained state. */
export async function readPersistedProviderPartialDestroyPlan(
  store: Pick<CapsuleRunCredentialLedger, "getApplyRun" | "getPlanRun" | "getStateVersion">,
  failedDestroyApplyRunId: string,
  capsule: Capsule,
  plannedStateVersionId: string,
  purpose: "recovery" | "retirement" = "recovery",
) {
  // Retirement only reads this prior cursor after verifying the completed
  // Destroy that consumed it. Live recovery still requires the error state.
  const expectedStatus = purpose === "retirement" ? "destroyed" : "error";
  if (
    capsule.status !== expectedStatus ||
    capsule.currentStateVersionId !== plannedStateVersionId ||
    capsule.currentOutputId !== undefined ||
    capsule.currentStateGeneration === undefined
  ) return undefined;

  const [failedDestroy, state] = await Promise.all([
    store.getApplyRun(failedDestroyApplyRunId),
    store.getStateVersion(plannedStateVersionId),
  ]);
  let failedEvidence: ReturnType<typeof assertRunExecutionEvidence>;
  try {
    failedEvidence = assertRunExecutionEvidence(failedDestroy?.executionEvidence);
  } catch {
    return undefined;
  }
  if (
    !failedDestroy || failedDestroy.id !== failedDestroyApplyRunId ||
    failedDestroy.status !== "failed" || failedDestroy.operation !== "destroy" ||
    failedDestroy.workspaceId !== capsule.workspaceId ||
    failedDestroy.capsuleId !== capsule.id ||
    failedDestroy.stateVersionId !== plannedStateVersionId ||
    failedDestroy.outputId !== undefined ||
    failedEvidence.runId !== failedDestroy.id ||
    failedEvidence.planRunId !== failedDestroy.planRunId ||
    failedEvidence.action !== "destroy" ||
    failedEvidence.outcome !== "provider_failed_state_persisted" ||
    failedEvidence.receipt.operationId !== failedDestroy.id ||
    failedEvidence.commit.stateVersionId !== plannedStateVersionId ||
    !state || state.id !== plannedStateVersionId ||
    state.workspaceId !== capsule.workspaceId || state.capsuleId !== capsule.id ||
    state.environment !== capsule.environment ||
    state.generation !== capsule.currentStateGeneration ||
    state.createdByRunId !== failedDestroy.id
  ) return undefined;

  const persistedDestroyFailureReceipts = failedDestroy.auditEvents.filter(
    (event) => event.type === "destroy.failed" &&
      event.data?.providerDispatched === true &&
      event.data.providerDestroySucceeded === false &&
      event.data.statePersistence === "persisted" &&
      event.data.stateVersionId === state.id,
  );
  if (persistedDestroyFailureReceipts.length !== 1) return undefined;

  const appliedPlan = await store.getPlanRun(failedDestroy.planRunId);
  if (
    !appliedPlan || appliedPlan.id !== failedDestroy.planRunId ||
    appliedPlan.status !== "succeeded" || appliedPlan.operation !== "destroy" ||
    appliedPlan.workspaceId !== capsule.workspaceId ||
    appliedPlan.capsuleId !== capsule.id ||
    appliedPlan.appliedApplyRunId !== failedDestroy.id ||
    appliedPlan.capsuleCurrentStateVersionId !==
      failedDestroy.expected.currentStateVersionId ||
    appliedPlan.baseStateGeneration === undefined ||
    state.generation !== appliedPlan.baseStateGeneration + 1 ||
    !appliedPlan.resolvedProviderBindingsDigest ||
    appliedPlan.planDigest !== failedEvidence.plan.digest ||
    appliedPlan.planArtifact?.digest !== failedEvidence.plan.artifactDigest ||
    appliedPlan.requiredProviderRequirements === undefined
  ) return undefined;
  return appliedPlan;
}

/**
 * To consume a retained partial Destroy, the newly approved manual Plan and
 * its Apply must also name the exact failed provider operation and state.
 */
async function persistedProviderPartialDestroyRecoveryMatches(
  store: CapsuleRunCredentialLedger,
  failedDestroyApplyRunId: string,
  capsule: Capsule,
  destroyApplyRunId: string,
  plannedStateVersionId: string,
): Promise<boolean> {
  const [appliedPlan, destroyApply] = await Promise.all([
    readPersistedProviderPartialDestroyPlan(store, failedDestroyApplyRunId, capsule, plannedStateVersionId),
    store.getApplyRun(destroyApplyRunId),
  ]);
  if (
    !appliedPlan || !destroyApply || destroyApply.id !== destroyApplyRunId ||
    destroyApply.status !== "running" || destroyApply.operation !== "destroy" ||
    destroyApply.workspaceId !== capsule.workspaceId ||
    destroyApply.capsuleId !== capsule.id ||
    destroyApply.expected.planRunId !== destroyApply.planRunId ||
    destroyApply.expected.capsuleId !== capsule.id ||
    destroyApply.expected.currentStateVersionId !== plannedStateVersionId ||
    destroyApply.expected.capsuleExecutionAuthorityEpoch === undefined
  ) return false;

  const recoveryPlan = await store.getPlanRun(destroyApply.planRunId);
  const recovery = recoveryPlan?.destroyConnectionRecovery;
  if (
    !recoveryPlan || recoveryPlan.id !== destroyApply.planRunId ||
    recoveryPlan.status !== "succeeded" || recoveryPlan.operation !== "destroy" ||
    recoveryPlan.workspaceId !== capsule.workspaceId ||
    recoveryPlan.capsuleId !== capsule.id ||
    recoveryPlan.baseStateGeneration !== capsule.currentStateGeneration ||
    recoveryPlan.capsuleCurrentStateVersionId !== plannedStateVersionId ||
    recoveryPlan.approval === undefined ||
    recoveryPlan.appliedApplyRunId !== undefined ||
    recoveryPlan.origin?.kind === "scheduled_uninstall" ||
    recoveryPlan.createdBy === "system:scheduled-uninstall" ||
    !recovery || recovery.appliedPlanRunId !== appliedPlan.id ||
    recovery.appliedProviderBindingsDigest !==
      appliedPlan.resolvedProviderBindingsDigest ||
    recovery.replacements.length === 0 ||
    destroyApply.expected.resolvedProviderBindingsDigest !==
      recoveryPlan.resolvedProviderBindingsDigest ||
    destroyApply.expected.capsuleExecutionAuthorityEpoch !==
      recoveryPlan.capsuleExecutionAuthorityEpoch
  ) return false;
  return true;
}

/** A recovered initial create has no provider-success receipt. Only a newly
 * reviewed destroy of its exact generation-one state may consume that state. */
async function recoveredInitialCreateDestroyMatches(
  store: CapsuleRunCredentialLedger,
  failedApplyRunId: string,
  capsule: Capsule,
  destroyApplyRunId: string,
  plannedStateVersionId: string,
): Promise<boolean> {
  if (
    capsule.status !== "error" || capsule.currentStateGeneration !== 1 ||
    capsule.currentOutputId !== undefined ||
    capsule.currentStateVersionId !== plannedStateVersionId
  ) return false;

  const [state, destroyApply] = await Promise.all([
    store.getStateVersion(plannedStateVersionId),
    store.getApplyRun(destroyApplyRunId),
  ]);
  if (
    !state || state.id !== plannedStateVersionId ||
    state.workspaceId !== capsule.workspaceId || state.capsuleId !== capsule.id ||
    state.environment !== capsule.environment || state.generation !== 1 ||
    !destroyApply || destroyApply.id !== destroyApplyRunId ||
    destroyApply.status !== "running" || destroyApply.operation !== "destroy" ||
    destroyApply.workspaceId !== capsule.workspaceId ||
    destroyApply.capsuleId !== capsule.id ||
    destroyApply.expected.currentStateVersionId !== state.id ||
    destroyApply.stateVersionId !== undefined || destroyApply.outputId !== undefined
  ) return false;

  const [recovery, destroyPlan] = await Promise.all([
    store.getStateRecoveryRun(state.createdByRunId),
    store.getPlanRun(destroyApply.planRunId),
  ]);
  if (
    !recovery || recovery.id !== state.createdByRunId ||
    recovery.type !== "state_recovery" || recovery.status !== "succeeded" ||
    recovery.executionEvidence !== undefined ||
    recovery.stateRecovery?.failedApplyRunId !== failedApplyRunId ||
    recovery.stateRecovery.recoveredStateVersionId !== state.id ||
    recovery.stateRecovery.plaintextSha256 !== state.digest ||
    state.createdAt !== recovery.finishedAt ||
    state.id !== await stateVersionIdForRecoveryRun(recovery.id) ||
    !destroyPlan || destroyPlan.id !== destroyApply.planRunId ||
    destroyPlan.status !== "succeeded" || destroyPlan.operation !== "destroy" ||
    destroyPlan.approval === undefined ||
    destroyPlan.workspaceId !== capsule.workspaceId ||
    destroyPlan.capsuleId !== capsule.id ||
    destroyPlan.baseStateGeneration !== 1 ||
    destroyPlan.capsuleCurrentStateVersionId !== state.id ||
    destroyPlan.capsuleExecutionAuthorityEpoch !==
      destroyApply.expected.capsuleExecutionAuthorityEpoch ||
    (destroyPlan.appliedApplyRunId !== undefined &&
      destroyPlan.appliedApplyRunId !== destroyApply.id)
  ) return false;

  const originalPlan = await recoveryPlanForStateVersion(store, capsule, state);
  if (!originalPlan) return false;
  const failed = await store.getApplyRun(failedApplyRunId);
  return failed?.id === failedApplyRunId &&
    failed.planRunId === originalPlan.id &&
    failed.executionEvidence === undefined &&
    failed.stateVersionId === undefined && failed.outputId === undefined;
}

/**
 * A provider-dispatched ordinary apply can fail after partial state persistence.
 * This exception stays separate from committed provider success followed by a
 * lifecycle failure: it must never authorize InstallConfig re-adoption.
 */
async function persistedProviderPartialApplyMatches(
  store: CapsuleRunCredentialLedger,
  failedApplyRunId: string,
  workspaceId: string,
  capsuleId: string,
  currentStateVersionId: string,
): Promise<boolean> {
  const failed = await store.getApplyRun(failedApplyRunId);
  if (
    !failed ||
    failed.status !== "failed" ||
    (failed.operation !== "create" && failed.operation !== "update") ||
    failed.workspaceId !== workspaceId ||
    failed.capsuleId !== capsuleId ||
    failed.stateVersionId !== currentStateVersionId
  ) {
    return false;
  }
  const persistedProviderFailureReceipt = failed.auditEvents.some(
    (event) =>
      event.type === "apply.failed" &&
      event.data?.providerDispatched === true &&
      event.data.providerApplySucceeded === false &&
      event.data.statePersistence === "persisted" &&
      event.data.stateVersionId === currentStateVersionId,
  );
  return persistedProviderFailureReceipt;
}

async function committedPostApplyRecoveryRowsMatch(
  store: CapsuleRunCredentialLedger,
  failedApplyRunId: string,
  capsule: Capsule,
): Promise<boolean> {
  if (
    capsule.currentStateVersionId === undefined ||
    capsule.currentOutputId === undefined
  ) {
    return false;
  }
  const [failedApplyRun, stateVersion, output] = await Promise.all([
    store.getApplyRun(failedApplyRunId),
    store.getStateVersion(capsule.currentStateVersionId),
    store.getOutput(capsule.currentOutputId),
  ]);
  return Boolean(
    failedApplyRun &&
      stateVersion &&
      output &&
      exactCommittedPostApplyRecoveryRowsMatch(capsule, {
        failedApplyRun,
        stateVersion,
        output,
      }),
  );
}

/** Only the exact committed Apply whose output projection failed supplies this state. */
export function committedOutputProjectionStateMatches(
  capsule: Capsule,
  state: StateVersion,
  apply: ApplyRun,
  plan: PlanRun,
): boolean {
  if (
    capsule.currentOutputId !== undefined ||
    capsule.currentStateVersionId !== state.id ||
    apply.status !== "failed" || (apply.operation !== "create" && apply.operation !== "update") ||
    apply.workspaceId !== capsule.workspaceId || apply.capsuleId !== capsule.id ||
    apply.stateVersionId !== state.id || apply.outputId !== undefined ||
    state.workspaceId !== capsule.workspaceId || state.capsuleId !== capsule.id ||
    state.environment !== capsule.environment || state.generation !== capsule.currentStateGeneration ||
    state.createdByRunId !== apply.id
  ) return false;
  const receipts = apply.auditEvents.filter(({ type }) => type === "apply.output_projection_failed");
  if (receipts.length !== 1 || receipts[0]?.data?.stateVersionId !== state.id ||
    receipts[0]?.data?.stateDigest !== state.digest) return false;
  let evidence: ReturnType<typeof assertRunExecutionEvidence>;
  try {
    evidence = assertRunExecutionEvidence(apply.executionEvidence);
  } catch {
    return false;
  }
  return (
    plan.id === apply.planRunId && plan.workspaceId === capsule.workspaceId &&
    plan.capsuleId === capsule.id && plan.status === "succeeded" &&
    plan.operation === apply.operation && plan.appliedApplyRunId === apply.id &&
    (plan.baseStateGeneration ?? 0) + 1 === state.generation &&
    evidence.runId === apply.id && evidence.planRunId === plan.id &&
    evidence.action === "apply" && evidence.outcome === "committed" &&
    evidence.receipt.operationId === apply.id && evidence.commit.stateVersionId === state.id &&
    evidence.plan.digest === plan.planDigest && evidence.plan.artifactDigest === plan.planArtifact?.digest
  );
}

async function committedOutputProjectionFailureMatches(
  store: CapsuleRunCredentialLedger,
  failedRunId: string,
  capsule: Capsule,
  stateVersionId: string,
  destroyRunId: string,
): Promise<boolean> {
  if (capsule.status !== "error" || capsule.currentOutputId !== undefined) return false;
  const [failed, state, destroy] = await Promise.all([
    store.getApplyRun(failedRunId),
    store.getStateVersion(stateVersionId),
    store.getApplyRun(destroyRunId),
  ]);
  if (
    !failed || failed.id !== failedRunId || !state || state.id !== stateVersionId ||
    !destroy || destroy.id !== destroyRunId || destroy.status !== "running" ||
    destroy.operation !== "destroy" || destroy.workspaceId !== capsule.workspaceId ||
    destroy.capsuleId !== capsule.id || destroy.expected.planRunId !== destroy.planRunId ||
    destroy.expected.capsuleId !== capsule.id || destroy.expected.currentStateVersionId !== state.id
  ) return false;
  const [plan, destroyPlan] = await Promise.all([
    store.getPlanRun(failed.planRunId),
    store.getPlanRun(destroy.planRunId),
  ]);
  return Boolean(
    plan && committedOutputProjectionStateMatches(capsule, state, failed, plan) &&
    destroyPlan && destroyPlan.id === destroy.planRunId &&
    destroyPlan.workspaceId === capsule.workspaceId && destroyPlan.capsuleId === capsule.id &&
    destroyPlan.operation === "destroy" && destroyPlan.capsuleCurrentStateVersionId === state.id &&
    destroyPlan.baseStateGeneration === state.generation &&
    (destroyPlan.appliedApplyRunId === undefined || destroyPlan.appliedApplyRunId === destroy.id) &&
    destroyPlan.status === "succeeded" && destroyPlan.approval !== undefined &&
    destroyPlan.origin?.kind !== "scheduled_uninstall" &&
    destroyPlan.createdBy !== "system:scheduled-uninstall"
  );
}

function exactNonEmpty(value: string): string | undefined {
  return value.length > 0 && value.trim() === value ? value : undefined;
}
