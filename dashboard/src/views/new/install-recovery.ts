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

export function shouldKeepInstallAttemptAfterFailure(error: unknown): boolean {
  return isMutationOutcomeUnknown(error);
}
