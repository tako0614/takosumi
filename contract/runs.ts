/**
 * Run + RunGroup contract (`runs` / `run_groups`).
 *
 * A Run is ONE execution ledger row. Most rows execute against an Capsule;
 * `source_sync` rows are Source-scoped before any Capsule exists.
 * Destroy is 2-phase (`destroy_plan` -> approval -> `destroy_apply`,
 * invariant 16). Apply-kind runs only ever execute a saved plan after
 * verifying plan digest / source snapshot / dependency snapshot / state
 * generation (invariants 6-10).
 *
 * A RunGroup orders multiple Runs across the dependency DAG (e.g. a Workspace
 * update after stale propagation); `graphJson` records the planned order.
 */

import type {
  ProviderResolution,
  PublicProviderResolution,
} from "./provider-resolution.ts";
import type { JsonValue } from "./types.ts";

export type RunType =
  | "source_sync"
  | "compatibility_check"
  | "plan"
  | "apply"
  | "destroy_plan"
  | "destroy_apply"
  | "drift_check"
  | "backup"
  // `restore` is a destructive Backup-backed state restore. It is created in
  // `waiting_approval`; approval dispatches it to write a new StateVersion
  // generation and mark downstream consumers stale. Service-data restore is
  // opt-in and succeeds only when the runner acknowledges the service-data
  // artifact restored.
  | "restore";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

/** Default page size for a Workspace Run listing when no limit is given. */
export const RUN_LIST_DEFAULT_LIMIT = 100;
/** Maximum page size accepted on the Workspace Run listing route. */
export const RUN_LIST_MAX_LIMIT = 500;

export type RunPolicyStatus = "pass" | "warn" | "deny";

export interface RunChangeSummary {
  readonly add?: number;
  readonly change?: number;
  readonly destroy?: number;
}

/**
 * Public, value-free resource projection from `tofu show -json tfplan`.
 * It intentionally carries only address/type/action tokens and sanitized
 * provider scope metadata. Raw before/after values and provider secrets never
 * appear on Run records.
 */
export interface RunPlanResource {
  readonly address: string;
  readonly type: string;
  readonly actions: readonly string[];
  readonly scope?: {
    readonly cloudflareAccountId?: string;
    readonly cloudflareZoneId?: string;
    readonly awsAccountId?: string;
    readonly awsRegion?: string;
  };
}

export interface RunApplyExpectedGuard {
  readonly planRunId: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly currentStateVersionId?: string | null;
  readonly runnerProfileId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest: string;
  readonly planArtifactDigest: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly resolvedProviderEnvBindingsDigest?: string;
}

/** Non-secret service-data restore evidence recorded on restore Runs. */
export interface RunServiceDataRestoreResult {
  readonly status: "restored";
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly restoredCount?: number;
}

export interface Run {
  readonly id: string;
  readonly runGroupId?: string;
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId: string;
  /** Present for Source-scoped rows such as `source_sync`. */
  readonly sourceId?: string;
  /** Required for Capsule-bound rows; absent for Source-scoped rows. */
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  /** @deprecated Retired Deployment ledger pointer. */
  readonly installationCurrentDeploymentId?: string;
  readonly environment?: string;
  readonly type: RunType;
  readonly status: RunStatus;
  readonly sourceSnapshotId?: string;
  readonly dependencySnapshotId?: string;
  readonly compatibilityReportId?: string;
  readonly baseStateGeneration?: number;
  readonly planDigest?: string;
  readonly planArtifactKey?: string;
  /**
   * Non-secret guard the client must echo when applying a reviewed plan.
   * Present only on plan/destroy_plan rows that have a saved immutable plan.
   */
  readonly applyExpected?: RunApplyExpectedGuard;
  /** Non-secret OpenTofu plan counts. Raw resource values stay in artifacts. */
  readonly summary?: RunChangeSummary;
  /** Non-secret resource/action review lines. No raw resource values. */
  readonly planResources?: readonly RunPlanResource[];
  readonly policyStatus?: RunPolicyStatus;
  readonly providerResolutions?: readonly ProviderResolution[];
  readonly runEnvironmentEvidenceDigest?: string;
  readonly redactionProfileId?: string;
  /** True when the reviewed plan carried a human approval/destructive gate. */
  readonly requiresApproval?: boolean;
  readonly backupId?: string;
  readonly restoreStateGeneration?: number;
  readonly restoreServiceData?: boolean;
  readonly restoredStateVersionId?: string;
  readonly restoredFromStateVersionId?: string;
  /** @deprecated Use restoredStateVersionId. */
  readonly restoredStateSnapshotId?: string;
  /** @deprecated Use restoredFromStateVersionId. */
  readonly restoredFromStateSnapshotId?: string;
  readonly restoredServiceData?: RunServiceDataRestoreResult;
  readonly errorCode?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  /**
   * Internal liveness marker refreshed while an executable Run is owned by a
   * runner. Normal public projections do not need to render it, but backup /
   * restore rows share the single runs ledger and use the same lease fencing as
   * plan/apply/source_sync.
   */
  readonly heartbeatAt?: number;
  readonly finishedAt?: string;
}

export type PublicRun = Omit<Run, "providerResolutions"> & {
  readonly providerResolutions?: readonly PublicProviderResolution[];
};

/** Body of `GET /api/v1/workspaces/:workspaceId/runs`. */
export interface ListRunsResponse {
  readonly runs: readonly PublicRun[];
}

export interface RunDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly detail?: string;
}

export interface RunAuditEvent {
  readonly id: string;
  readonly type: string;
  readonly at: number;
  readonly actor?: string;
  readonly message?: string;
  readonly data?: Readonly<Record<string, JsonValue>>;
}

/**
 * Body of `GET /internal/v1/runs/:runId/logs`. MVP: the run record's
 * structured diagnostics + the run-level audit trail (the per-run policy /
 * lease / dispatch trace). Logs pass through redaction (invariant 15); no
 * credential material or sensitive output values appear here.
 */
export interface RunLogsResponse {
  readonly diagnostics: readonly RunDiagnostic[];
  readonly auditEvents: readonly RunAuditEvent[];
}

/**
 * Body of `GET /internal/v1/runs/:runId/events`. MVP: the run-level audit
 * trail only.
 */
export interface RunEventsResponse {
  readonly auditEvents: readonly RunAuditEvent[];
}

/**
 * Public, non-secret cost projection for a `plan` / `destroy_plan` Run
 * (`GET /internal/v1/runs/:runId/cost`). It surfaces the billing reservation values the
 * controller ALREADY computed at plan time so a dashboard can explain, before
 * apply, why an apply would be blocked under `enforce` mode (insufficient
 * USD balance / a billing-plan limit). It carries no cost formula and no
 * secret material — only counts already recorded on the run's billing audit.
 *
 *   - `billingMode`        — the Workspace's billing mode at plan time
 *                            (`disabled` / `showback` / `enforce`).
 *   - `estimatedUsdMicros` — the USD amount the controller estimated this plan
 *                            would consume on apply, in micros.
 *   - `availableUsdMicros` — the Workspace's available USD balance observed when
 *                            a reservation was attempted, in micros, when known.
 *   - `reservationStatus`  — `reserved` when credits were held, or
 *                            `insufficient_credits` when the reservation could
 *                            not be made (the apply would be blocked under
 *                            `enforce`). Absent when no reservation was needed.
 *   - `shortfallUsdMicros` — `estimatedUsdMicros - availableUsdMicros` when that is
 *                            positive (the missing amount), else absent.
 *   - `blocked`            — true when billing blocks this plan from applying
 *                            under `enforce` mode.
 *   - `reasons`            — public-safe human reasons billing blocked the plan
 *                            (the credit-shortfall / plan-limit messages already
 *                            recorded on the run's policy decision). Empty when
 *                            nothing billing-related blocked the plan.
 */
export interface RunCostInfo {
  readonly runId: string;
  /**
   * OSS resolves only `disabled` | `showback`. A Cloud-injected
   * {@link BillingEnforcement} port reports its own gating through `blocked` /
   * `reasons`; the mode stays `showback` from the OSS controller's perspective.
   */
  readonly billingMode: "disabled" | "showback";
  readonly estimatedUsdMicros: number;
  readonly availableUsdMicros?: number;
  readonly shortfallUsdMicros?: number;
  /** @deprecated Use estimatedUsdMicros. */
  readonly estimatedCredits: number;
  /** @deprecated Use availableUsdMicros. */
  readonly availableCredits?: number;
  readonly reservationStatus?: "reserved" | "insufficient_credits";
  /** @deprecated Use shortfallUsdMicros. */
  readonly creditShortfall?: number;
  readonly blocked: boolean;
  readonly reasons: readonly string[];
}

/** Body of `GET /internal/v1/runs/:runId/cost`. */
export interface RunCostResponse {
  readonly cost: RunCostInfo;
}

export type RunGroupType =
  | "space_update"
  | "space_drift_check"
  | "installation_install"
  | "installation_update"
  | "installation_destroy";

export type RunGroupStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunGroup {
  readonly id: string;
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly type: RunGroupType;
  readonly status: RunGroupStatus;
  /** JSON-encoded DAG-ordered plan of member runs. */
  readonly graphJson: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

/** Internal deploy-control seam response: RunGroup plus member Runs. */
export interface RunGroupWithRuns {
  readonly runGroup: RunGroup;
  /** Member Runs, in the row's recorded topological order. */
  readonly runs: readonly Run[];
}

/** Public control surface response: RunGroup plus public-safe member Runs. */
export interface RunGroupResponse {
  readonly runGroup: RunGroup;
  /** Member Runs, in the row's recorded topological order. */
  readonly runs: readonly PublicRun[];
}

/**
 * Non-public artifact ledger row (`artifacts`).
 *
 * Artifact bytes live in R2_SOURCE / R2_ARTIFACTS / R2_STATE / R2_BACKUPS.
 * The D1 ledger stores only this pointer metadata so a Run can be audited
 * without copying encrypted artifact bodies into D1.
 */
export interface ArtifactRecord {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}
