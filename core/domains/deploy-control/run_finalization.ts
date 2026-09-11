import type { ApplyRun } from "@takosumi/internal/deploy-control-api";

/** Durable outcomes appended to the existing ApplyRun audit history. */
export const APPLY_BILLING_CAPTURE_PENDING_EVENT = "billing.capture.pending" as const;
export const APPLY_BILLING_CAPTURE_COMPLETED_EVENT = "billing.capture.completed" as const;
export const APPLY_RUNTIME_SECRET_RETIREMENT_PENDING_EVENT = "runtime_secret.retirement.pending" as const;
export const APPLY_RUNTIME_SECRET_RETIREMENT_COMPLETED_EVENT = "runtime_secret.retirement.completed" as const;
export const APPLY_RUNTIME_SECRET_RETIREMENT_DEFERRED_EVENT = "runtime_secret.retirement.deferred" as const;

export function applyRunBillingCapturePending(run: ApplyRun): boolean {
  return pendingAfterCompletion(run, APPLY_BILLING_CAPTURE_PENDING_EVENT, APPLY_BILLING_CAPTURE_COMPLETED_EVENT);
}

export function applyRunRuntimeSecretRetirementPending(run: ApplyRun): boolean {
  return pendingAfterCompletion(run, APPLY_RUNTIME_SECRET_RETIREMENT_PENDING_EVENT, APPLY_RUNTIME_SECRET_RETIREMENT_COMPLETED_EVENT);
}

function pendingAfterCompletion(run: ApplyRun, pending: string, completed: string): boolean {
  let latestPending = -1;
  let latestCompleted = -1;
  for (let index = 0; index < run.auditEvents.length; index += 1) {
    const type = run.auditEvents[index]?.type;
    if (type === pending) latestPending = index;
    if (type === completed) latestCompleted = index;
  }
  return latestPending > latestCompleted;
}
