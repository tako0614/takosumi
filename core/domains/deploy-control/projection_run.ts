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
import type { JsonValue } from "takosumi-contract";
import {
  legacyCreditsToUsdMicros,
  usdMicrosToLegacyCredits,
} from "takosumi-contract/billing";

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
  /** Installation the plan targets (spec §5: one Installation = one root). */
  readonly installationId?: string;
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
    spaceId: planRun.workspaceId ?? planRun.spaceId,
    ...(options.installationId
      ? {
          capsuleId: options.installationId,
          installationId: options.installationId,
        }
      : {}),
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
      ? { planArtifactKey: planRun.planArtifact.ref }
      : {}),
    ...(planRun.planDigest && planRun.planArtifact
      ? { applyExpected: projectApplyExpectedGuard(planRun) }
      : {}),
    ...(planRun.summary ? { summary: planRun.summary } : {}),
    ...(planRun.planResourceChanges
      ? { planResources: planRun.planResourceChanges }
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
  const capsuleId = planRun.capsuleId ?? planRun.installationId;
  return {
    planId: planRun.id,
    ...(capsuleId ? { capsuleId } : {}),
    ...(planRun.installationId
      ? { installationId: planRun.installationId }
      : {}),
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
    ...(planRun.resolvedProviderEnvBindingsDigest
      ? {
          resolvedProviderEnvBindingsDigest:
            planRun.resolvedProviderEnvBindingsDigest,
        }
      : {}),
  };
}

export interface ProjectApplyRunOptions {
  readonly installationId?: string;
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
    spaceId: applyRun.workspaceId ?? applyRun.spaceId,
    ...(options.installationId
      ? {
          capsuleId: options.installationId,
          installationId: options.installationId,
        }
      : {}),
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
    spaceId: run.spaceId,
    type: "source_sync",
    status: syncUnifiedStatus(run.status),
    ...(run.snapshotId && run.status === "succeeded"
      ? { sourceSnapshotId: run.snapshotId }
      : {}),
    createdBy: DEFAULT_CREATED_BY,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { errorCode: "source_sync_failed" } : {}),
  };
}

function errorCodeFromPlan(planRun: PlanRun): string {
  const message = planRun.diagnostics?.find(
    (d) => d.severity === "error",
  )?.message;
  return message ? compactErrorCode(message) : "plan_failed";
}

function errorCodeFromApply(applyRun: ApplyRun): string {
  const message = applyRun.diagnostics?.find(
    (d) => d.severity === "error",
  )?.message;
  return message ? compactErrorCode(message) : "apply_failed";
}

/**
 * Derives a short stable error code token from a diagnostic message. Picks a
 * leading `snake_case:` token when present (the controller emits these, e.g.
 * `state_generation_mismatch: ...`); otherwise falls back to a generic code so
 * the public Run never leaks a full diagnostic string.
 */
export function compactErrorCode(message: string): string {
  if (isCreditRequiredErrorMessage(message)) return "credits_required";
  if (isProviderConnectionChangedErrorMessage(message)) {
    return "provider_connection_changed";
  }
  if (isProviderConnectionNotReadyErrorMessage(message)) {
    return "provider_connection_not_ready";
  }
  if (isProviderConnectionSetupErrorMessage(message)) {
    return "provider_connection_setup_required";
  }
  if (isCredentialServiceUnavailableErrorMessage(message)) {
    return "credential_service_unavailable";
  }
  const match = message.match(/^([a-z][a-z0-9_]{2,63}):/);
  return match ? match[1] : "run_failed";
}

function isCreditRequiredErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cloud_extension_insufficient_credits") ||
    normalized.includes('"reason":"insufficient_credits"') ||
    normalized.includes('"reason": "insufficient_credits"') ||
    (normalized.includes("reservationstatus") &&
      normalized.includes("insufficient_credits")) ||
    normalized.includes("usd balance reservation failed") ||
    normalized.includes("insufficient credits")
  );
}

function isProviderConnectionChangedErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("resolved_bindings_changed") ||
    normalized.includes("re-plan before apply")
  );
}

function isProviderConnectionNotReadyErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("credential_mint_failed") &&
      normalized.includes("not verified")) ||
    normalized.includes("pending (not verified)") ||
    (normalized.includes("provider connection") &&
      normalized.includes("status pending is not verified"))
  );
}

function isProviderConnectionSetupErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("credential_mint_failed") &&
    (normalized.includes("provider connection evidence is required") ||
      normalized.includes("provider connection resolution is required") ||
      normalized.includes("root-only provider connection is required") ||
      (normalized.includes("connection ") &&
        normalized.includes(" not found")) ||
      normalized.includes("provider connection is required") ||
      normalized.includes("belongs to another space") ||
      normalized.includes("git source connection") ||
      normalized.includes("cannot back a provider env binding") ||
      (normalized.includes("provider ") &&
        normalized.includes(" does not match")))
  );
}

function isCredentialServiceUnavailableErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("credential_mint_failed") &&
    (normalized.includes("connection vault is not configured") ||
      normalized.includes("requires a managed provider credential issuer") ||
      normalized.includes("could not mint a run-scoped provider token") ||
      normalized.includes("gateway materialization is takosumi cloud-only") ||
      normalized.includes("mint driver"))
  );
}

/** The billing audit object recorded under `plan.policy_evaluated.billing`. */
function planBillingAudit(
  planRun: PlanRun,
): Readonly<Record<string, JsonValue>> | undefined {
  const evaluated = planRun.auditEvents.find(
    (event) => event.type === "plan.policy_evaluated",
  );
  const billing = evaluated?.data?.billing;
  return billing && typeof billing === "object" && !Array.isArray(billing)
    ? (billing as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function numberOrUndefined(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Projects the public {@link RunCostInfo} for a `plan` / `destroy_plan` PlanRun.
 *
 * This is a PURE re-projection of values the controller ALREADY computed and
 * recorded on the run at plan time: the billing audit attached to the
 * `plan.policy_evaluated` event (mode / estimated USD / available USD /
 * reservation status) and the billing-shortfall reasons recorded on the run's
 * policy decision. It computes no cost (it never calls the credit estimator) and
 * surfaces no secret material — only the counts and reasons already persisted —
 * so a dashboard can explain, before apply, why an apply would be blocked under
 * `enforce` mode (insufficient USD balance / a billing-plan limit).
 *
 * A plan that never reached billing evaluation (no `plan.policy_evaluated`
 * event, e.g. a still-queued or pre-policy-failure run) projects a
 * `disabled`-mode, zero-USD, non-blocked cost so the field is always present.
 */
export function projectPlanRunCost(planRun: PlanRun): RunCostInfo {
  const billing = planBillingAudit(planRun);
  const modeValue = billing?.mode;
  // OSS resolves only disabled|showback. A legacy/Cloud-written `enforce` audit
  // value is surfaced as `showback` here; the actual gating (if any) is reported
  // via `blocked` / `reasons` recorded by the injected enforcement port.
  const billingMode: RunCostInfo["billingMode"] =
    modeValue === "showback" || modeValue === "enforce"
      ? "showback"
      : "disabled";
  const legacyEstimatedCredits = numberOrUndefined(billing?.estimatedCredits);
  const legacyAvailableCredits = numberOrUndefined(billing?.availableCredits);
  const estimatedUsdMicros =
    numberOrUndefined(billing?.estimatedUsdMicros) ??
    legacyCreditsToUsdMicros(legacyEstimatedCredits ?? 0);
  const availableUsdMicros =
    numberOrUndefined(billing?.availableUsdMicros) ??
    (legacyAvailableCredits === undefined
      ? undefined
      : legacyCreditsToUsdMicros(legacyAvailableCredits));
  const estimatedCredits = usdMicrosToLegacyCredits(estimatedUsdMicros);
  const availableCredits =
    availableUsdMicros === undefined
      ? undefined
      : usdMicrosToLegacyCredits(availableUsdMicros);
  const reservationValue = billing?.reservationStatus;
  const reservationStatus: RunCostInfo["reservationStatus"] | undefined =
    reservationValue === "reserved" ||
    reservationValue === "insufficient_credits"
      ? reservationValue
      : undefined;
  const shortfallUsdMicros =
    availableUsdMicros !== undefined && estimatedUsdMicros > availableUsdMicros
      ? estimatedUsdMicros - availableUsdMicros
      : undefined;
  // Billing blocks the plan only when the run is policy-`blocked`: a passed
  // plan never blocks on billing even in `enforce`. The credit-shortfall and
  // plan-limit messages are recorded verbatim on the policy decision; keep the
  // public-safe ones (they carry only credit counts and the billing plan id).
  const reasons =
    planRun.policy.status === "blocked"
      ? planRun.policy.reasons.filter(isBillingReason)
      : [];
  // Billing blocks only when an injected Cloud enforcement port recorded an
  // enforce decision (`mode: "enforce"` in its billing audit) AND that decision
  // is a shortfall / plan-limit on a policy-`blocked` run. OSS showback uses the
  // no-op port, which never records `enforce`, so this is structurally false for
  // an OSS-only deployment (enforcement is reachable only via the injected port).
  const enforcedByPort = modeValue === "enforce";
  const blocked =
    enforcedByPort &&
    (reservationStatus === "insufficient_credits" || reasons.length > 0);
  return {
    runId: planRun.id,
    billingMode,
    estimatedUsdMicros,
    ...(availableUsdMicros !== undefined ? { availableUsdMicros } : {}),
    ...(shortfallUsdMicros !== undefined ? { shortfallUsdMicros } : {}),
    estimatedCredits,
    ...(availableCredits !== undefined ? { availableCredits } : {}),
    ...(reservationStatus ? { reservationStatus } : {}),
    ...(shortfallUsdMicros !== undefined
      ? { creditShortfall: usdMicrosToLegacyCredits(shortfallUsdMicros) }
      : {}),
    blocked,
    reasons,
  };
}

/**
 * True for a policy reason string that describes a billing/USD-balance block.
 * The controller emits USD balance reasons starting `USD balance reservation
 * failed:` and billing-plan limit reasons starting `billing plan `; legacy
 * credit reasons are accepted only for old persisted runs. These strings carry
 * only amounts / a billing plan id, never secrets.
 */
function isBillingReason(reason: string): boolean {
  return (
    reason.startsWith("USD balance reservation failed:") ||
    reason.startsWith("credit reservation failed:") ||
    reason.startsWith("billing plan ")
  );
}
