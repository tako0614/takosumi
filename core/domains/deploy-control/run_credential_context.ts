import type { OpenTofuControlStore } from "./store.ts";

export type CapsuleRunCredentialPhase = "plan" | "apply" | "destroy";

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
  }

  const runtimeSafety = await store.getCapsuleRuntimeSafety(capsuleId);
  const runtimeSafetyMatches =
    input.phase === "destroy"
      ? runtimeSafety?.phase === "terminating" &&
        runtimeSafety.runType === "destroy_apply" &&
        runtimeSafety.runId === runId
      : input.phase === "plan" && planOperation === "destroy"
        ? runtimeSafety === undefined ||
          runtimeSafety.phase === "safe" ||
          runtimeSafety.phase === "unknown"
        : runtimeSafety === undefined || runtimeSafety.phase === "safe";
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
    },
  };
}

function exactNonEmpty(value: string): string | undefined {
  return value.length > 0 && value.trim() === value ? value : undefined;
}
