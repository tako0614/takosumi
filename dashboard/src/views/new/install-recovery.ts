import { isMutationOutcomeUnknown } from "../../lib/control-api.ts";

export type PendingInstallRecoveryNextAction =
  | "reconcile"
  | "review_run"
  | "none";

export function pendingInstallRecoveryAction(
  attemptWorkspaceId: string,
  currentWorkspaceId: string,
  viewWorkspaceId: string,
  nextAction: PendingInstallRecoveryNextAction,
):
  | "show-review"
  | "keep-pending"
  | "still-running"
  | "stopped"
  | "workspace-mismatch" {
  if (
    attemptWorkspaceId !== currentWorkspaceId ||
    attemptWorkspaceId !== viewWorkspaceId
  ) {
    return "workspace-mismatch";
  }
  if (nextAction === "review_run") return "show-review";
  return nextAction === "none" ? "stopped" : "still-running";
}

export function pendingInstallResumeCompletion(
  attemptWorkspaceId: string,
  currentWorkspaceId: string,
  viewWorkspaceId: string,
  nextAction: PendingInstallRecoveryNextAction,
): { action: ReturnType<typeof pendingInstallRecoveryAction>; phase: "review" | "pending-timeout" } {
  const action = pendingInstallRecoveryAction(
    attemptWorkspaceId,
    currentWorkspaceId,
    viewWorkspaceId,
    nextAction,
  );
  return {
    action,
    phase: action === "show-review" ? "review" : "pending-timeout",
  };
}

export function isPendingInstallWorkspaceSelected(
  attemptWorkspaceId: string,
  currentWorkspaceId: string,
  viewWorkspaceId: string,
): boolean {
  return (
    attemptWorkspaceId === currentWorkspaceId &&
    attemptWorkspaceId === viewWorkspaceId
  );
}

export function pendingInstallRunIdForSelectedWorkspace(
  planRunId: string | undefined,
  attemptWorkspaceId: string | undefined,
  currentWorkspaceId: string,
  viewWorkspaceId: string,
): string | undefined {
  if (
    !planRunId ||
    !attemptWorkspaceId ||
    !isPendingInstallWorkspaceSelected(
      attemptWorkspaceId,
      currentWorkspaceId,
      viewWorkspaceId,
    )
  ) {
    return undefined;
  }
  return planRunId;
}

export function shouldKeepInstallAttemptAfterFailure(error: unknown): boolean {
  return isMutationOutcomeUnknown(error);
}

export function installPlanAttemptFailureAction<
  T extends { idempotencyKey: string; installPlanId?: string },
>(
  attempt: T | undefined,
  current: T | undefined,
  error: unknown,
): "retain" | "clear" | "stale" {
  if (!attempt) return current ? "stale" : "clear";
  if (!current || attempt.idempotencyKey !== current.idempotencyKey) return "stale";
  // Once the server has acknowledged a coordinator identity, even a 4xx from
  // a later reconcile belongs to that coordinator and must not erase it.
  return current.installPlanId || shouldKeepInstallAttemptAfterFailure(error)
    ? "retain"
    : "clear";
}
