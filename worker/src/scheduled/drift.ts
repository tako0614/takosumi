/**
 * Scheduled per-app sweep (Core Specification §28 `scheduled/drift.ts`; §19
 * `drift_check`; TASK-0118 stage 9.1).
 *
 * Every cron tick on which at least one opt-in flag is on, the sweep reserves
 * ONE bounded page of live Capsules (`active` or `stale`) from the store's
 * `active_capsules` cursor lane and decides for each app on its own:
 *
 * - a `stale` Capsule (Source moved past the applied revision) gets at most one
 *   reviewable update Plan when the stale auto-plan flag is on. Core source sync
 *   only marks Capsules `stale`; this never applies anything, and normal Run
 *   approval/apply semantics stay in charge.
 * - an `active` Capsule gets one read-only `drift_check` when the drift flag is
 *   on. A drift check runs `tofu plan` against the live state, NEVER parks
 *   waiting_approval and can NEVER be applied; on a non-empty change summary
 *   the controller emits `capsule.drift_detected`.
 *
 * Neither step lists Workspaces, reads another app, or creates a RunGroup (the
 * Workspace-wide RunGroup is retired). The page is reserved before any work,
 * so successive ticks walk every live app even when some keep failing, and
 * one failing app never aborts the rest of the page.
 */

import type { Run } from "takosumi-contract/runs";

/** Capsules reserved per tick. One page serves both steps. */
export const CAPSULE_SWEEP_PAGE_LIMIT = 25;

/** Newest plan Runs read per stale app to find an open update Plan. */
export const CAPSULE_SWEEP_PLAN_LOOKBACK = 100;

/** Recorded actor for a legacy stale app without an owner row. */
export const STALE_AUTO_PLAN_SYSTEM_ACTOR = "system:stale-auto-plan";

/** Recorded actor for a legacy active app without an owner row. */
export const DRIFT_CHECK_SYSTEM_ACTOR = "system:drift-check";

/** The Capsule fields the sweep reads. */
export interface CapsuleSweepCapsule {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
}

/**
 * The narrow operations the sweep needs. The platform worker adapts its
 * in-process deploy-control facade; tests pass a stub.
 */
export interface CapsuleSweepOperations {
  /** Reserves the next page of live (`active` or `stale`) Capsules. */
  listCapsulesForScheduledSweep(
    limit: number,
  ): Promise<readonly CapsuleSweepCapsule[]>;
  /** Current app ownership; absent for a legacy Capsule without an owner row. */
  getOwnership?(capsuleId: string): Promise<
    | { readonly ownerAccountId: string; readonly managementState: string }
    | undefined
  >;
  /** One app's newest plan Runs (never a Workspace listing). */
  listCapsulePlanRuns(
    capsule: CapsuleSweepCapsule,
    limit: number,
  ): Promise<readonly Pick<Run, "type" | "status">[]>;
  createCapsulePlan(
    capsuleId: string,
    options: { readonly actor: string; readonly origin: { readonly kind: "update" } },
  ): Promise<unknown>;
  createCapsuleDriftCheck(
    capsuleId: string,
    options: { readonly actor: string },
  ): Promise<unknown>;
  /** Activity for a created stale auto-plan (best-effort). */
  recordStaleAutoPlan?(capsule: CapsuleSweepCapsule): Promise<void>;
}

export interface CapsuleSweepOptions {
  /** `TAKOSUMI_AUTO_PLAN_STALE_CAPSULES=1`. */
  readonly autoPlanStale: boolean;
  /** `TAKOSUMI_DRIFT_CHECK_ENABLED=1`. */
  readonly driftCheck: boolean;
  /** Capsules reserved this tick (default {@link CAPSULE_SWEEP_PAGE_LIMIT}). */
  readonly limit?: number;
  /** Plan Runs read per stale app (default {@link CAPSULE_SWEEP_PLAN_LOOKBACK}). */
  readonly planLookback?: number;
}

export interface CapsuleSweepResult {
  /** Capsules in the reserved page. */
  readonly scanned: number;
  /** Stale apps that got a new update Plan. */
  readonly plansCreated: number;
  /** Active apps that got a new drift check. */
  readonly driftChecksCreated: number;
}

const EMPTY_RESULT: CapsuleSweepResult = {
  scanned: 0,
  plansCreated: 0,
  driftChecksCreated: 0,
};

/**
 * Runs one sweep tick. With both flags off (or a non-positive limit) it
 * reserves nothing, so the cursor only moves while a step can use the page.
 */
export async function sweepCapsules(
  operations: CapsuleSweepOperations,
  options: CapsuleSweepOptions,
): Promise<CapsuleSweepResult> {
  if (!options.autoPlanStale && !options.driftCheck) return EMPTY_RESULT;
  const limit = options.limit === undefined
    ? CAPSULE_SWEEP_PAGE_LIMIT
    : Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : 0;
  // A non-positive page reserves nothing.
  if (limit === 0) return EMPTY_RESULT;
  const planLookback = positiveInteger(
    options.planLookback,
    CAPSULE_SWEEP_PLAN_LOOKBACK,
  );
  const capsules = await operations.listCapsulesForScheduledSweep(limit);
  let plansCreated = 0;
  let driftChecksCreated = 0;
  for (const capsule of capsules) {
    const step = capsule.status === "stale" && options.autoPlanStale
      ? "auto_plan"
      : capsule.status === "active" && options.driftCheck
        ? "drift_check"
        : undefined;
    if (!step) continue;
    try {
      const ownership = await operations.getOwnership?.(capsule.id);
      // An app being transferred, drained or retired takes no system work.
      if (ownership && ownership.managementState !== "active") continue;
      const owner = ownership?.ownerAccountId.trim() || undefined;
      if (step === "auto_plan") {
        const runs = await operations.listCapsulePlanRuns(capsule, planLookback);
        if (runs.some(isPendingPlan)) continue;
        await operations.createCapsulePlan(capsule.id, {
          actor: owner ?? STALE_AUTO_PLAN_SYSTEM_ACTOR,
          origin: { kind: "update" },
        });
        plansCreated += 1;
        try {
          await operations.recordStaleAutoPlan?.(capsule);
        } catch {
          console.warn("scheduled.stale_auto_plan_activity_failed");
        }
      } else {
        await operations.createCapsuleDriftCheck(capsule.id, {
          actor: owner ?? DRIFT_CHECK_SYSTEM_ACTOR,
        });
        driftChecksCreated += 1;
      }
    } catch {
      // Best-effort: one bad app must not abort the rest of the page.
      console.warn(
        step === "auto_plan"
          ? "scheduled.stale_auto_plan_create_failed"
          : "scheduled.drift_check_create_failed",
      );
    }
  }
  return { scanned: capsules.length, plansCreated, driftChecksCreated };
}

function isPendingPlan(run: Pick<Run, "type" | "status">): boolean {
  return run.type === "plan" &&
    (run.status === "queued" ||
      run.status === "running" ||
      run.status === "waiting_approval");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}
