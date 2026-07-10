/**
 * Shared deploy-approval predicate for review runs.
 *
 * A succeeded, policy-passed review run (plan / destroy_plan) "awaits deploy
 * approval" only until SOME apply / destroy_apply for the same Capsule has
 * been created at/after it — any apply attempt consumes the approval,
 * regardless of that apply's outcome. Both the run history rows and the run
 * detail screen (承認待ち badge + デプロイを実行 CTA) MUST derive from this
 * one predicate so an already-applied plan opened from history can never
 * present an active deploy approval again.
 */
import type { Run } from "./control-api.ts";

/** The wire Run keeps the legacy `installationId` alias next to `capsuleId`
 * (backup runs record only the alias) — read both so those runs still resolve
 * their Capsule. */
export function runCapsuleId(run: Run): string | undefined {
  return (
    run.capsuleId ??
    (run as Run & { readonly installationId?: string }).installationId
  );
}

/** True when `run` is a review run (plan / destroy_plan). */
export function isReviewRun(run: Run): boolean {
  return run.type === "plan" || run.type === "destroy_plan";
}

/** Run-local part of the predicate: a succeeded, policy-passed review run.
 * Only these runs CAN await a deploy approval; whether the approval is still
 * open additionally depends on the sibling runs (see
 * {@link awaitsDeployApproval}). */
export function isDeployApprovalCandidate(run: Run): boolean {
  return (
    isReviewRun(run) &&
    run.status === "succeeded" &&
    run.policyStatus === "pass"
  );
}

/**
 * True when a succeeded review run (plan / destroy_plan) is still waiting on
 * the user's deploy approval: policy passed, and no apply / destroy_apply for
 * the same Capsule has been created at/after it. `runs` is the Workspace Run
 * ledger (or the newest slice of it) the plan lives in.
 */
export function awaitsDeployApproval(run: Run, runs: readonly Run[]): boolean {
  if (!isDeployApprovalCandidate(run)) return false;
  const planCapsuleId = runCapsuleId(run);
  if (!planCapsuleId) return false;
  const planCreatedAt = Date.parse(run.createdAt);
  return !runs.some((candidate) => {
    if (candidate.type !== "apply" && candidate.type !== "destroy_apply") {
      return false;
    }
    if (runCapsuleId(candidate) !== planCapsuleId) return false;
    if (Number.isNaN(planCreatedAt)) return true;
    const candidateCreatedAt = Date.parse(candidate.createdAt);
    return Number.isNaN(candidateCreatedAt)
      ? true
      : candidateCreatedAt >= planCreatedAt;
  });
}
