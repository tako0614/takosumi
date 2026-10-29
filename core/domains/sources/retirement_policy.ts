import type { StoredSource } from "../deploy-control/store.ts";
import { deterministicInitialCapsuleId, isInstallPlanSourceReservation } from "../install-plans/source-reservation.ts";
import type { StoredGitInstallPlan } from "../install-plans/store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shared by automatic orphan recovery and the operator ownership inventory. */
export function sourceCreatorPlanAllowsRetirement(plan: StoredGitInstallPlan, now: number, graceMs = DAY_MS): boolean {
  const elapsed = (timestamp: string | undefined) => {
    const time = Date.parse(timestamp ?? "");
    return Number.isFinite(now) && Number.isFinite(time) && time + graceMs <= now;
  };
  if (plan.phase === "discarded" || (plan.phase === "failed" && plan.mode !== "attempt")) {
    return elapsed(plan.completedAt ?? plan.updatedAt);
  }
  // Failed attempts remain resumable; expiry is a read-time fact. A confirming
  // create cannot expire, and a reviewable plan retains its Capsule authority.
  return plan.mode === "attempt" && plan.phase !== "reviewable" &&
    !plan.creationAttempted && elapsed(plan.expiresAt);
}

/** A lost Source acknowledgement may leave the creator's sourceId unset. */
export function sourceCreatorPlanMatchesSource(source: StoredSource, plan: StoredGitInstallPlan): boolean {
  return source.createdByInstallPlanId === plan.id && source.workspaceId === plan.workspaceId &&
    (plan.operation === undefined || plan.operation === "install") &&
    (plan.sourceId === undefined || plan.sourceId === source.id) &&
    (source.ownerCapsuleId === undefined || isInstallPlanSourceReservation(source)) &&
    (plan.capsuleId === undefined || plan.capsuleId === deterministicInitialCapsuleId(plan.id));
}
