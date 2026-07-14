/**
 * Unified Run facade (Core Specification §19).
 *
 * The internal ledger keeps three concrete record kinds: SourceSyncRun, PlanRun,
 * and ApplyRun (the latter covers both apply and destroy_apply). The spec
 * exposes ONE `Run` type with `type` and `status` that generalize these. This
 * module is a pure projection — it never mutates the internal records.
 *
 * Status mapping (the load-bearing part):
 *   - RunStatus is ONE vocabulary now (`queued | running | waiting_approval |
 *     succeeded | failed | cancelled | expired`). The internal PlanRun / ApplyRun
 *     records persist that same set, so the projection is mostly identity.
 *   - `waiting_approval` is a PERSISTED status (an approval gate parks the plan
 *     there at completion). A legacy row persisted `succeeded` that the caller
 *     still observes as awaiting approval is mapped to `waiting_approval` for
 *     back-compat; a legacy `blocked` row coerces to `failed`.
 */

import type {
  ApplyRun,
  OpenTofuOperation,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type {
  Run,
  RunCostInfo,
  RunStatus,
  RunType,
} from "takosumi-contract/runs";
import { normalizePlanResourceScope, type JsonValue } from "takosumi-contract";

type RunEnvironmentEvidenceProjection = Pick<
  Run,
  "providerResolutions" | "runEnvironmentEvidenceDigest" | "redactionProfileId"
>;

/** ISO timestamp from an epoch-millis field, or undefined when absent. */
function iso(at: number | undefined): string | undefined {
  return at === undefined ? undefined : new Date(at).toISOString();
}

function runEnvironmentEvidence(
  run: PlanRun | ApplyRun,
): Partial<RunEnvironmentEvidenceProjection> {
  return {
    ...(run.providerResolutions
      ? { providerResolutions: run.providerResolutions }
      : {}),
    ...(run.runEnvironmentEvidenceDigest
      ? { runEnvironmentEvidenceDigest: run.runEnvironmentEvidenceDigest }
      : {}),
    ...(run.redactionProfileId
      ? { redactionProfileId: run.redactionProfileId }
      : {}),
  };
}

/**
 * The §19 RunType for an internal PlanRun/ApplyRun, given the run phase. A
 * `destroy` operation splits into `destroy_plan` / `destroy_apply` (invariant
 * 16); every other operation collapses to the bare phase (`plan` / `apply`).
 */
function runTypeForOperation(
  operation: OpenTofuOperation,
  phase: "plan" | "apply",
): RunType {
  if (operation === "destroy") {
    return phase === "plan" ? "destroy_plan" : "destroy_apply";
  }
  return phase;
}

/**
 * Maps a PlanRun status to the unified status. RunStatus is now ONE vocabulary,
 * so a status that is already unified (`waiting_approval` included) passes
 * through. `awaitingApproval` is retained for legacy/back-compat: a legacy row
 * persisted `succeeded` (before `waiting_approval` became a persisted status)
 * that the caller still observes as awaiting approval projects to
 * `waiting_approval`. A legacy persisted `blocked` coerces to `failed`.
 */
function planUnifiedStatus(
  status: PlanRun["status"],
  awaitingApproval: boolean,
): RunStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "waiting_approval":
      return "waiting_approval";
    case "succeeded":
      return awaitingApproval ? "waiting_approval" : "succeeded";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      // Legacy `blocked` (and any unknown) coerces to `failed`.
      return "failed";
  }
}

function applyUnifiedStatus(status: ApplyRun["status"]): RunStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "waiting_approval":
      return "waiting_approval";
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      // Legacy `blocked` (and any unknown) coerces to `failed`.
      return "failed";
  }
}

function syncUnifiedStatus(status: SourceSyncRun["status"]): RunStatus {
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

function policyStatusFor(status: "passed" | "blocked"): "pass" | "deny" {
  return status === "passed" ? "pass" : "deny";
}

/** §19 Run.createdBy is required; default when the internal record has none. */
const DEFAULT_CREATED_BY = "system";

export interface ProjectPlanRunOptions {
  /**
   * Whether this plan is waiting on an approval (the environment requires
   * approval, the run is a destroy_plan, or the template flagged a destructive
   * change). When true, a succeeded/blocked plan projects to
   * `waiting_approval`.
   */
  readonly awaitingApproval?: boolean;
  /** Capsule the plan targets. */
  readonly capsuleId?: string;
  readonly environment?: string;
  /** Resolved SourceSnapshot id, when the plan referenced one. */
  readonly sourceSnapshotId?: string;
}

/** Projects a PlanRun onto the unified §19 Run. */
export function projectPlanRun(
  planRun: PlanRun,
  options: ProjectPlanRunOptions = {},
): Run {
  // A drift-check plan projects to the §19 `drift_check` run type regardless of
  // its underlying operation (it is created as an `update`-kind internal plan).
  const type: RunType =
    planRun.driftCheck === true
      ? "drift_check"
      : runTypeForOperation(planRun.operation, "plan");
  const errorCode =
    planRun.status === "failed" ? errorCodeFromPlan(planRun) : undefined;
  return {
    id: planRun.id,
    ...(planRun.runGroupId ? { runGroupId: planRun.runGroupId } : {}),
    workspaceId: planRun.workspaceId,
    ...(planRun.resourceContext
      ? {
          subject: {
            kind: "resource" as const,
            id: planRun.resourceContext.resourceId,
          },
        }
      : {}),
    ...(options.capsuleId ? { capsuleId: options.capsuleId } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    type,
    status: planUnifiedStatus(
      planRun.status,
      options.awaitingApproval ?? false,
    ),
    ...(options.sourceSnapshotId
      ? { sourceSnapshotId: options.sourceSnapshotId }
      : {}),
    ...(planRun.dependencySnapshotId
      ? { dependencySnapshotId: planRun.dependencySnapshotId }
      : {}),
    ...(planRun.compatibilityReportId
      ? { compatibilityReportId: planRun.compatibilityReportId }
      : {}),
    ...(planRun.baseStateGeneration !== undefined
      ? { baseStateGeneration: planRun.baseStateGeneration }
      : {}),
    ...(planRun.planDigest ? { planDigest: planRun.planDigest } : {}),
    ...(planRun.planArtifact?.ref
      ? { planArtifactRef: planRun.planArtifact.ref }
      : {}),
    ...(planRun.planDigest && planRun.planArtifact
      ? { applyExpected: projectApplyExpectedGuard(planRun) }
      : {}),
    ...(planRun.summary ? { summary: planRun.summary } : {}),
    ...(planRun.planResourceChanges
      ? {
          planResources: planRun.planResourceChanges.map((change) => {
            const { scope, ...projection } = change;
            const normalizedScope = normalizePlanResourceScope(scope);
            return {
              ...projection,
              ...(normalizedScope ? { scope: normalizedScope } : {}),
            };
          }),
        }
      : {}),
    ...runEnvironmentEvidence(planRun),
    policyStatus: policyStatusFor(planRun.policy.status),
    ...(planRun.requiresApproval === true || type === "destroy_plan"
      ? { requiresApproval: true }
      : {}),
    ...(errorCode ? { errorCode } : {}),
    createdBy: DEFAULT_CREATED_BY,
    createdAt: new Date(planRun.createdAt).toISOString(),
    ...(iso(planRun.startedAt) ? { startedAt: iso(planRun.startedAt)! } : {}),
    ...(iso(planRun.finishedAt)
      ? { finishedAt: iso(planRun.finishedAt)! }
      : {}),
  };
}

function projectApplyExpectedGuard(planRun: PlanRun): Run["applyExpected"] {
  if (!planRun.planDigest || !planRun.planArtifact) return undefined;
  const capsuleId = planRun.capsuleId;
  return {
    planId: planRun.id,
    ...(capsuleId ? { capsuleId } : {}),
    ...(capsuleId
      ? { currentStateVersionId: planRun.capsuleCurrentStateVersionId ?? null }
      : {}),
    runnerId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest,
    planArtifactDigest: planRun.planArtifact.digest,
    ...(planRun.sourceCommit ? { sourceCommit: planRun.sourceCommit } : {}),
    ...(planRun.providerLockDigest
      ? { providerLockDigest: planRun.providerLockDigest }
      : {}),
    ...(planRun.resolvedProviderBindingsDigest
      ? {
          resolvedProviderBindingsDigest:
            planRun.resolvedProviderBindingsDigest,
        }
      : {}),
  };
}

export interface ProjectApplyRunOptions {
  readonly capsuleId?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  readonly sourceSnapshotId?: string;
  /** Pinned DependencySnapshot id (spec §17), threaded from the source PlanRun. */
  readonly dependencySnapshotId?: string;
  /** RunGroup id (spec §19), threaded from the source PlanRun. */
  readonly runGroupId?: string;
}

/** Projects an ApplyRun (apply or destroy_apply) onto the unified §19 Run. */
export function projectApplyRun(
  applyRun: ApplyRun,
  options: ProjectApplyRunOptions = {},
): Run {
  const type: RunType = runTypeForOperation(applyRun.operation, "apply");
  const errorCode =
    applyRun.status === "failed" ? errorCodeFromApply(applyRun) : undefined;
  return {
    id: applyRun.id,
    ...(options.runGroupId ? { runGroupId: options.runGroupId } : {}),
    workspaceId: applyRun.workspaceId,
    ...(options.resourceId
      ? { subject: { kind: "resource" as const, id: options.resourceId } }
      : {}),
    ...(options.capsuleId ? { capsuleId: options.capsuleId } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    type,
    status: applyUnifiedStatus(applyRun.status),
    ...(options.sourceSnapshotId
      ? { sourceSnapshotId: options.sourceSnapshotId }
      : {}),
    ...(options.dependencySnapshotId
      ? { dependencySnapshotId: options.dependencySnapshotId }
      : {}),
    ...(applyRun.expected.planDigest
      ? { planDigest: applyRun.expected.planDigest }
      : {}),
    ...runEnvironmentEvidence(applyRun),
    ...(errorCode ? { errorCode } : {}),
    createdBy: DEFAULT_CREATED_BY,
    createdAt: new Date(applyRun.createdAt).toISOString(),
    ...(iso(applyRun.startedAt) ? { startedAt: iso(applyRun.startedAt)! } : {}),
    ...(iso(applyRun.finishedAt)
      ? { finishedAt: iso(applyRun.finishedAt)! }
      : {}),
  };
}

/** Projects a SourceSyncRun onto the unified §19 Run. */
export function projectSourceSyncRun(run: SourceSyncRun): Run {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    type: "source_sync",
    status: syncUnifiedStatus(run.status),
    ...(run.snapshotId && run.status === "succeeded"
      ? { sourceSnapshotId: run.snapshotId }
      : {}),
    createdBy: DEFAULT_CREATED_BY,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.errorCode
      ? { errorCode: run.errorCode }
      : run.error
        ? { errorCode: "source_sync_failed" }
        : {}),
  };
}

function errorCodeFromPlan(planRun: PlanRun): string {
  const code = planRun.diagnostics?.find(
    (diagnostic) => diagnostic.severity === "error" && diagnostic.code,
  )?.code;
  if (code) return code;
  return planRun.policy.status === "blocked" ? "policy_denied" : "plan_failed";
}

function errorCodeFromApply(applyRun: ApplyRun): string {
  return (
    applyRun.diagnostics?.find(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.code,
    )?.code ?? "apply_failed"
  );
}

/** The billing audit object recorded under `plan.policy_evaluated.billing`. */
function planBillingAudit(
  planRun: PlanRun,
): Readonly<Record<string, JsonValue>> | undefined {
  for (let index = planRun.auditEvents.length - 1; index >= 0; index -= 1) {
    const event = planRun.auditEvents[index];
    if (event?.type !== "plan.policy_evaluated") continue;
    const billing = event.data?.billing;
    if (billing && typeof billing === "object" && !Array.isArray(billing)) {
      return billing as Readonly<Record<string, JsonValue>>;
    }
  }
  return undefined;
}

function numberOrUndefined(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Projects the public {@link RunCostInfo} for a `plan` / `destroy_plan` PlanRun.
 *
 * This is a PURE re-projection of the stable core fields recorded under the
 * `plan.policy_evaluated` billing audit. Host-owned commercial details remain
 * opaque under `extension`; core never interprets provider-specific strings,
 * balance fields, reservation statuses, or plan records.
 *
 * A plan that never reached billing evaluation (no `plan.policy_evaluated`
 * event, e.g. a still-queued or pre-policy-failure run) projects a
 * `disabled`-mode, zero-USD, non-blocked cost so the field is always present.
 */
export function projectPlanRunCost(planRun: PlanRun): RunCostInfo {
  const billing = planBillingAudit(planRun);
  const modeValue = billing?.mode;
  const billingMode: RunCostInfo["billingMode"] =
    modeValue === "showback" ? "showback" : "disabled";
  const ratingValue = billing?.ratingStatus;
  const ratingStatus: RunCostInfo["ratingStatus"] =
    billingMode === "disabled"
      ? "not_applicable"
      : ratingValue === "rated"
        ? "rated"
        : "unrated";
  const estimatedUsdMicros =
    ratingStatus === "rated"
      ? (numberOrUndefined(billing?.estimatedUsdMicros) ?? 0)
      : 0;
  const reasons = stringArray(billing?.reasons);
  const blocked =
    planRun.policy.status === "blocked" && billing?.blocked === true;
  const extension = billing?.extension;
  return {
    runId: planRun.id,
    billingMode,
    estimatedUsdMicros,
    ratingStatus,
    blocked,
    reasons,
    ...(extension && typeof extension === "object" && !Array.isArray(extension)
      ? { extension: extension as Readonly<Record<string, JsonValue>> }
      : {}),
  };
}

function stringArray(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
