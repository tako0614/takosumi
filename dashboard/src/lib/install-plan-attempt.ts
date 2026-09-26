import type { CreateGitInstallPlanRequest } from "takosumi-contract";

/** In-memory only: the exact request may contain user-supplied variables. */
export interface InstallPlanAttempt {
  readonly workspaceId: string;
  readonly requestJson: string;
  readonly idempotencyKey: string;
}

/** A changed request is a new deliberate attempt, never an old-key replay. */
export function getOrCreateInstallPlanAttempt(
  retained: InstallPlanAttempt | undefined,
  workspaceId: string,
  request: CreateGitInstallPlanRequest,
): InstallPlanAttempt {
  const requestJson = JSON.stringify(request);
  if (
    retained?.workspaceId === workspaceId &&
    retained.requestJson === requestJson
  ) return retained;
  return Object.freeze({
    workspaceId,
    requestJson,
    idempotencyKey: crypto.randomUUID(),
  });
}

/** Decode a fresh copy so later edits cannot change the retained wire body. */
export function installPlanAttemptRequest(
  attempt: InstallPlanAttempt,
): CreateGitInstallPlanRequest {
  return JSON.parse(attempt.requestJson) as CreateGitInstallPlanRequest;
}
