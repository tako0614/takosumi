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

export function shouldKeepInstallAttemptAfterFailure(error: unknown): boolean {
  return isMutationOutcomeUnknown(error);
}

export function retainedPendingInstallAttempt<T extends { idempotencyKey: string }>(
  attempt: T | undefined,
  current: T | undefined,
  error: unknown,
): T | undefined {
  if (
    !attempt ||
    attempt.idempotencyKey !== current?.idempotencyKey ||
    !shouldKeepInstallAttemptAfterFailure(error)
  ) {
    return undefined;
  }
  return current;
}
