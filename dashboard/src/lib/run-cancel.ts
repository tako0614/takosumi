/**
 * Shared cancel-eligibility predicate for the Run detail screen.
 *
 * `POST /api/v1/runs/:id/cancel` is a deliberately narrow, fenced operation
 * (`OpenTofuRunEngine.#cancelRun`, run_engine.ts). It settles ONLY a run whose
 * row is still waiting to start, so the Cancel control must be derived from
 * this one predicate: offering it anywhere else produces a 409
 * `failed_precondition` the user cannot act on (a live apply sat in `running`
 * for ~29 minutes while the dashboard kept offering Cancel).
 *
 * Mirrored backend rule:
 * - plan family (`plan` / `destroy_plan` / `drift_check`, i.e. PlanRun rows):
 *   `queued` AND never started, or parked `waiting_approval`;
 * - apply family (`apply` / `destroy_apply`, i.e. ApplyRun rows): `queued` AND
 *   never started;
 * - every other run kind (`source_sync`, `compatibility_check`, `backup`,
 *   `restore`, `artifact`): rejected as "not a cancellable plan or apply run".
 *
 * `startedAt` is NOT redundant with `queued`: a retryable runner-infrastructure
 * failure deliberately requeues the SAME row after it has run (an apply may
 * already carry provider/lifecycle mutation evidence, e.g. a succeeded
 * pre_destroy action), and the backend keeps that row fail-closed. A parked
 * `waiting_approval` plan keeps its historical cancellation semantics, so it is
 * cancellable whether or not it started.
 */
import type { Run } from "./control-api.ts";

/** Run types backed by the plan ledger (`PlanRun` rows). */
const PLAN_RUN_TYPES: ReadonlySet<Run["type"]> = new Set([
  "plan",
  "destroy_plan",
  "drift_check",
]);

/** Run types backed by the apply ledger (`ApplyRun` rows). */
const APPLY_RUN_TYPES: ReadonlySet<Run["type"]> = new Set([
  "apply",
  "destroy_apply",
]);

/**
 * True when the run API's cancel route would settle `run` instead of answering
 * 409. A `running` (or terminal, or non-ledger) run is never cancellable.
 */
export function canCancelRun(run: Run): boolean {
  const started = run.startedAt !== undefined;
  if (PLAN_RUN_TYPES.has(run.type)) {
    if (run.status === "waiting_approval") return true;
    return run.status === "queued" && !started;
  }
  if (APPLY_RUN_TYPES.has(run.type)) {
    return run.status === "queued" && !started;
  }
  return false;
}
