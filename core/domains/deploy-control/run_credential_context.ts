import type { OpenTofuControlStore } from "./store.ts";

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

  const runtimeSafety = await store.getCapsuleRuntimeSafety(capsuleId);
  const persistedPartialApplyRecoveryMatches =
    input.phase !== "destroy" &&
    planOperation !== "destroy" &&
    runtimeSafety?.phase === "unknown" &&
    runtimeSafety.runType === "apply" &&
    capsule.currentStateVersionId !== undefined &&
    plannedCapsuleStateVersionId === capsule.currentStateVersionId &&
    (await persistedPartialApplyMatches(
      store,
      runtimeSafety.runId,
      workspaceId,
      capsuleId,
      capsule.currentStateVersionId,
      capsule.currentOutputId,
      capsule.status,
      capsule.environment,
      capsule.currentStateGeneration,
    ));
  const currentApplyExecutionMatches =
    input.phase === "apply" &&
    planOperation !== "destroy" &&
    runtimeSafety?.phase === "unknown" &&
    runtimeSafety.runType === "apply" &&
    runtimeSafety.runId === runId;
  const runtimeSafetyMatches =
    input.phase === "destroy"
      ? runtimeSafety?.phase === "terminating" &&
        runtimeSafety.runType === "destroy_apply" &&
        runtimeSafety.runId === runId
      : input.phase === "plan" && planOperation === "destroy"
        ? runtimeSafety === undefined ||
          runtimeSafety.phase === "safe" ||
          runtimeSafety.phase === "unknown"
        : runtimeSafety === undefined ||
          runtimeSafety.phase === "safe" ||
          currentApplyExecutionMatches ||
          persistedPartialApplyRecoveryMatches;
  if (!runtimeSafetyMatches) {
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

/**
 * A provider-dispatched ordinary apply can fail after partial state persistence
 * or after its provider-applied StateVersion/Output were durably committed but
 * post-apply lifecycle failed. A fresh reviewed plan/apply is the only normal
 * convergence path. Bind that recovery to the decisive failed ApplyRun and its
 * exact receipt; runtime safety itself remains unknown, and every other
 * unknown/restore/destroy or stale-state condition remains fail-closed.
 */
async function persistedPartialApplyMatches(
  store: CapsuleRunCredentialLedger,
  failedApplyRunId: string,
  workspaceId: string,
  capsuleId: string,
  currentStateVersionId: string,
  currentOutputId: string | undefined,
  capsuleStatus: string,
  capsuleEnvironment: string,
  currentStateGeneration: number,
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
  if (persistedProviderFailureReceipt) return true;

  if (
    capsuleStatus !== "error" ||
    failed.outputId === undefined ||
    currentOutputId === undefined ||
    failed.outputId !== currentOutputId
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
  // Audit events are append-only, while both terminal receipts may share the
  // same commit clock. Array order is therefore the canonical happens-before.
  if (
    completedReceipt.index >= failedReceipt.index ||
    completedReceipt.event.data?.stateVersionId !== currentStateVersionId ||
    completedReceipt.event.data.outputId !== currentOutputId ||
    failedReceipt.event.data?.providerDispatched !== true ||
    failedReceipt.event.data.providerApplySucceeded !== true ||
    failedReceipt.event.data.lifecycleActionPhase !== "post_apply" ||
    !terminalLifecycleFailureStatus(
      failedReceipt.event.data.lifecycleActionStatus,
    )
  ) {
    return false;
  }

  const [stateVersion, output] = await Promise.all([
    store.getStateVersion(currentStateVersionId),
    store.getOutput(currentOutputId),
  ]);
  return (
    stateVersion?.id === currentStateVersionId &&
    stateVersion.workspaceId === workspaceId &&
    stateVersion.capsuleId === capsuleId &&
    stateVersion.environment === capsuleEnvironment &&
    stateVersion.generation === currentStateGeneration &&
    stateVersion.createdByRunId === failed.id &&
    output?.id === currentOutputId &&
    output.workspaceId === workspaceId &&
    output.capsuleId === capsuleId &&
    output.stateGeneration === stateVersion.generation &&
    output.stateGeneration === currentStateGeneration
  );
}

function terminalLifecycleFailureStatus(value: unknown): boolean {
  return (
    value === "failed" ||
    value === "skipped" ||
    value === "unavailable" ||
    value === "error"
  );
}

function exactNonEmpty(value: string): string | undefined {
  return value.length > 0 && value.trim() === value ? value : undefined;
}
