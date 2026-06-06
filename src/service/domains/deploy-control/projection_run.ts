/**
 * Unified Run facade (Core Specification §6.8).
 *
 * The internal ledger keeps three concrete record kinds: SourceSyncRun, PlanRun,
 * and ApplyRun (the latter covers both apply and destroy_apply). The spec
 * exposes ONE `Run` type with `type` and `status` that generalize these. This
 * module is a pure projection — it never mutates the internal records.
 *
 * Status mapping (the load-bearing part):
 *   - PlanRun.status `blocked` projects to `waiting_approval` when the block is a
 *     policy gate that an approval can clear (template `requiresConfirmation`, a
 *     destroy_plan, or an environment that requires approval); otherwise a
 *     genuinely policy-denied plan projects to `failed`.
 *   - The remaining internal statuses map 1:1 to the unified statuses; the
 *     internal model has no `expired`, so it is never produced here.
 */

import type {
  ApplyRun,
  PlanRun,
} from "takosumi-contract/deploy-control-api";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type { Run, RunType, UnifiedRunStatus } from "takosumi-contract/lanes";
import { runTypeForOperation } from "takosumi-contract/lanes";

/** ISO timestamp from an epoch-millis field, or undefined when absent. */
function iso(at: number | undefined): string | undefined {
  return at === undefined ? undefined : new Date(at).toISOString();
}

/**
 * Maps a PlanRun status to the unified status. A `blocked` plan becomes
 * `waiting_approval` when an approval can move it forward; a policy-denied plan
 * with no approval path becomes `failed`. `awaitingApproval` is set by the
 * caller from the environment/plan policy decision.
 */
function planUnifiedStatus(
  status: PlanRun["status"],
  awaitingApproval: boolean,
): UnifiedRunStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return awaitingApproval ? "waiting_approval" : "succeeded";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return awaitingApproval ? "waiting_approval" : "failed";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function applyUnifiedStatus(status: ApplyRun["status"]): UnifiedRunStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "blocked":
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function syncUnifiedStatus(status: SourceSyncRun["status"]): UnifiedRunStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function policyStatusFor(
  status: "passed" | "blocked",
): "pass" | "deny" {
  return status === "passed" ? "pass" : "deny";
}

export interface ProjectPlanRunOptions {
  /**
   * Whether this plan is waiting on an approval (the environment requires
   * approval, the run is a destroy_plan, or the template flagged a destructive
   * change). When true, a succeeded/blocked plan projects to
   * `waiting_approval`.
   */
  readonly awaitingApproval?: boolean;
  readonly appId?: string;
  readonly environmentId?: string;
  /** Resolved SourceSnapshot id, when the plan referenced one. */
  readonly sourceSnapshotId?: string;
}

/** Projects a PlanRun onto the unified §6.8 Run. */
export function projectPlanRun(
  planRun: PlanRun,
  options: ProjectPlanRunOptions = {},
): Run {
  const type: RunType = runTypeForOperation(planRun.operation, "plan");
  const errorCode = planRun.status === "failed"
    ? errorCodeFromPlan(planRun)
    : undefined;
  return {
    id: planRun.id,
    spaceId: planRun.spaceId,
    ...(options.appId ? { appId: options.appId } : {}),
    ...(options.environmentId ? { environmentId: options.environmentId } : {}),
    type,
    status: planUnifiedStatus(planRun.status, options.awaitingApproval ?? false),
    ...(options.sourceSnapshotId
      ? { sourceSnapshotId: options.sourceSnapshotId }
      : {}),
    ...(planRun.baseStateGeneration !== undefined
      ? { baseStateGeneration: planRun.baseStateGeneration }
      : {}),
    ...(planRun.planDigest ? { planDigest: planRun.planDigest } : {}),
    ...(planRun.planArtifact?.ref
      ? { planArtifactKey: planRun.planArtifact.ref }
      : {}),
    policyStatus: policyStatusFor(planRun.policy.status),
    ...(errorCode ? { errorCode } : {}),
    createdAt: new Date(planRun.createdAt).toISOString(),
    ...(iso(planRun.startedAt) ? { startedAt: iso(planRun.startedAt)! } : {}),
    ...(iso(planRun.finishedAt) ? { finishedAt: iso(planRun.finishedAt)! } : {}),
  };
}

export interface ProjectApplyRunOptions {
  readonly appId?: string;
  readonly environmentId?: string;
  readonly sourceSnapshotId?: string;
}

/** Projects an ApplyRun (apply or destroy_apply) onto the unified §6.8 Run. */
export function projectApplyRun(
  applyRun: ApplyRun,
  options: ProjectApplyRunOptions = {},
): Run {
  const type: RunType = runTypeForOperation(applyRun.operation, "apply");
  const errorCode = applyRun.status === "failed"
    ? errorCodeFromApply(applyRun)
    : undefined;
  return {
    id: applyRun.id,
    spaceId: applyRun.spaceId,
    ...(options.appId ? { appId: options.appId } : {}),
    ...(options.environmentId ? { environmentId: options.environmentId } : {}),
    type,
    status: applyUnifiedStatus(applyRun.status),
    ...(options.sourceSnapshotId
      ? { sourceSnapshotId: options.sourceSnapshotId }
      : {}),
    ...(applyRun.expected.planDigest
      ? { planDigest: applyRun.expected.planDigest }
      : {}),
    ...(errorCode ? { errorCode } : {}),
    createdAt: new Date(applyRun.createdAt).toISOString(),
    ...(iso(applyRun.startedAt) ? { startedAt: iso(applyRun.startedAt)! } : {}),
    ...(iso(applyRun.finishedAt) ? { finishedAt: iso(applyRun.finishedAt)! } : {}),
  };
}

/** Projects a SourceSyncRun onto the unified §6.8 Run. */
export function projectSourceSyncRun(run: SourceSyncRun): Run {
  return {
    id: run.id,
    spaceId: run.spaceId,
    type: "source_sync",
    status: syncUnifiedStatus(run.status),
    ...(run.snapshotId && run.status === "succeeded"
      ? { sourceSnapshotId: run.snapshotId }
      : {}),
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { errorCode: "source_sync_failed" } : {}),
  };
}

function errorCodeFromPlan(planRun: PlanRun): string {
  const message = planRun.diagnostics?.find((d) => d.severity === "error")
    ?.message;
  return message ? compactErrorCode(message) : "plan_failed";
}

function errorCodeFromApply(applyRun: ApplyRun): string {
  const message = applyRun.diagnostics?.find((d) => d.severity === "error")
    ?.message;
  return message ? compactErrorCode(message) : "apply_failed";
}

/**
 * Derives a short stable error code token from a diagnostic message. Picks a
 * leading `snake_case:` token when present (the controller emits these, e.g.
 * `state_generation_mismatch: ...`); otherwise falls back to a generic code so
 * the public Run never leaks a full diagnostic string.
 */
function compactErrorCode(message: string): string {
  const match = message.match(/^([a-z][a-z0-9_]{2,63}):/);
  return match ? match[1] : "run_failed";
}
