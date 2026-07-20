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
import type { PlanResourceScope } from "./plan-scope.ts";
import type { JsonValue } from "./types.ts";

export type RunType =
  | "source_sync"
  | "compatibility_check"
  /** Host-backed immutable artifact staging; it does not mutate Resource state. */
  | "artifact"
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

/**
 * Run terminal status covers every phase pinned by the reviewed Plan. For an
 * apply with required post-apply lifecycle actions, `succeeded` means both the
 * provider apply and every action terminal-succeeded. `failed` may therefore
 * coexist with a retained provider-applied StateVersion/Output; audit/errorCode
 * distinguish that case from a provider execution failure.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type RunSubject =
  | { readonly kind: "capsule"; readonly id: string }
  | { readonly kind: "resource"; readonly id: string }
  | { readonly kind: "source"; readonly id: string };

/**
 * Exact Resource Deploy API operation represented by a canonical Run.
 *
 * OpenTofu-backed Resources keep their existing plan/apply Run pairs. Direct
 * adapter plugins use one Core-minted Run carrying this token so an opaque
 * backend request id can never become lifecycle authority.
 */
export type ResourceOperation =
  | "artifact"
  | "preview"
  | "apply"
  | "import"
  | "observe"
  | "refresh"
  | "delete";

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
  readonly scope?: PlanResourceScope;
}

export interface RunApplyExpectedGuard {
  readonly planId: string;
  readonly capsuleId?: string;
  readonly currentStateVersionId?: string | null;
  readonly runnerId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest: string;
  readonly planArtifactDigest: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly resolvedProviderBindingsDigest?: string;
}

/** Non-secret service-data restore evidence recorded on restore Runs. */
export interface RunServiceDataRestoreResult {
  readonly status: "restored";
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly restoredCount?: number;
}

export interface Run {
  readonly id: string;
  readonly runGroupId?: string;
  readonly workspaceId: string;
  /** Present for Source-scoped rows such as `source_sync`. */
  readonly sourceId?: string;
  /** Explicit execution subject for non-Capsule and new generic run flows. */
  readonly subject?: RunSubject;
  /** Exact Deploy API operation for a Resource-owned Run. */
  readonly resourceOperation?: ResourceOperation;
  /** Required for Capsule-bound rows; absent for Source-scoped rows. */
  readonly capsuleId?: string;
  readonly environment?: string;
  readonly type: RunType;
  readonly status: RunStatus;
  readonly sourceSnapshotId?: string;
  readonly dependencySnapshotId?: string;
  readonly compatibilityReportId?: string;
  readonly baseStateGeneration?: number;
  readonly planDigest?: string;
  readonly planArtifactRef?: string;
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
  /** Stable machine-readable classification; UI must not parse `message`. */
  readonly code?: string;
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
 * Public, non-secret showback projection for a plan Run. Core owns the stable
 * estimate/mode/decision fields. A host may attach an opaque, non-secret
 * extension object, but core and the OSS dashboard never infer commercial
 * balance, reservation, plan, or payment semantics from it.
 */
export interface RunCostInfo {
  readonly runId: string;
  readonly billingMode: "disabled" | "showback";
  readonly estimatedUsdMicros: number;
  readonly ratingStatus: "not_applicable" | "rated" | "unrated";
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly extension?: Readonly<Record<string, JsonValue>>;
}

/** Body of `GET /internal/v1/runs/:runId/cost`. */
export interface RunCostResponse {
  readonly cost: RunCostInfo;
}

export type RunGroupType =
  | "workspace_update"
  | "workspace_drift_check"
  | "capsule_install"
  | "capsule_update"
  | "capsule_destroy";

export type RunGroupStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunGroup {
  readonly id: string;
  readonly workspaceId: string;
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
 * Artifact bytes live behind a host storage adapter. The control ledger stores
 * only an opaque reference plus integrity metadata.
 */
export interface ArtifactRecord {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}
