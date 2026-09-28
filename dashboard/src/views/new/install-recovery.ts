import { isMutationOutcomeUnknown } from "../../lib/control-api.ts";
import type { GitInstallPlanResponse } from "takosumi-contract";

const INSTALL_PLAN_ID_PATTERN = /^gip_[a-f0-9]{16}$/u;

/** An install plan id is an untrusted locator, never install authority. */
export function installPlanRecoveryId(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll("installPlan");
  const value = values.length === 1 ? values[0] : undefined;
  return value && INSTALL_PLAN_ID_PATTERN.test(value) ? value : undefined;
}

export function hasInstallPlanRecoveryLocator(search: string): boolean {
  return new URLSearchParams(search).has("installPlan");
}

/** Replace all query data with the one opaque id needed for status recovery. */
export function installPlanRecoverySearch(planId: string): string {
  if (!INSTALL_PLAN_ID_PATTERN.test(planId)) {
    throw new TypeError("Invalid install plan locator.");
  }
  return `?installPlan=${encodeURIComponent(planId)}`;
}

export function installPlanRecoveryMatchesIdentity(
  response: GitInstallPlanResponse,
  workspaceId: string,
  principalId: string,
): boolean {
  return Boolean(
    workspaceId &&
      principalId &&
      response.installPlan.workspaceId === workspaceId &&
      response.installPlan.createdBy === principalId,
  );
}

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
