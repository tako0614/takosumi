/**
 * Run + RunGroup contract (`runs` / `run_groups`).
 *
 * A Run is ONE execution ledger row. Most rows execute against an Installation;
 * `source_sync` rows are Source-scoped before any Installation exists.
 * Destroy is 2-phase (`destroy_plan` -> approval -> `destroy_apply`,
 * invariant 16). Apply-kind runs only ever execute a saved plan after
 * verifying plan digest / source snapshot / dependency snapshot / state
 * generation (invariants 6-10).
 *
 * A RunGroup orders multiple Runs across the dependency DAG (e.g. a Space
 * update after stale propagation); `graphJson` records the planned order.
 */

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
  // `restore` is RESERVED but NOT YET IMPLEMENTED. It has an OpenAPI enum
  // entry, but no producer, no store accessors, no queue
  // action, no controller handler, and no API route. Restore overwrites tfstate
  // from a Backup (a destructive operation) and is intentionally deferred until
  // a safe design (approval gate, state-generation rollback, stale propagation,
  // runner restore action) exists. The run queue consumer fail-closes against a
  // `restore` queue action. See docs/core-conformance.md (Backup / Export model
  // and Future Extensions). Do not create `restore` Runs until implemented.
  | "restore";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type RunPolicyStatus = "pass" | "warn" | "deny";

export interface Run {
  readonly id: string;
  readonly runGroupId?: string;
  readonly spaceId: string;
  /** Present for Source-scoped rows such as `source_sync`. */
  readonly sourceId?: string;
  /** Required for Installation-bound rows; absent for Source-scoped rows. */
  readonly installationId?: string;
  readonly environment?: string;
  readonly type: RunType;
  readonly status: RunStatus;
  readonly sourceSnapshotId?: string;
  readonly dependencySnapshotId?: string;
  readonly compatibilityReportId?: string;
  readonly baseStateGeneration?: number;
  readonly planDigest?: string;
  readonly planArtifactKey?: string;
  readonly policyStatus?: RunPolicyStatus;
  readonly errorCode?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
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
 * Body of `GET /api/runs/:runId/logs`. MVP: the run record's
 * structured diagnostics + the run-level audit trail (the per-run policy /
 * lease / dispatch trace). Logs pass through redaction (invariant 15); no
 * credential material or sensitive output values appear here.
 */
export interface RunLogsResponse {
  readonly diagnostics: readonly RunDiagnostic[];
  readonly auditEvents: readonly RunAuditEvent[];
}

/**
 * Body of `GET /api/runs/:runId/events`. MVP: the run-level audit
 * trail only.
 */
export interface RunEventsResponse {
  readonly auditEvents: readonly RunAuditEvent[];
}

/**
 * Public, non-secret cost projection for a `plan` / `destroy_plan` Run
 * (`GET /api/runs/:runId/cost`). It surfaces the billing reservation values the
 * controller ALREADY computed at plan time so a dashboard can explain, before
 * apply, why an apply would be blocked under `enforce` mode (insufficient
 * credits / a billing-plan limit). It carries no credit cost formula and no
 * secret material — only counts already recorded on the run's billing audit.
 *
 *   - `billingMode`        — the Space's billing mode at plan time
 *                            (`disabled` / `showback` / `enforce`).
 *   - `estimatedCredits`   — the credits the controller estimated this plan
 *                            would consume on apply.
 *   - `availableCredits`   — the Space's available credit balance observed when
 *                            a reservation was attempted, when known.
 *   - `reservationStatus`  — `reserved` when credits were held, or
 *                            `insufficient_credits` when the reservation could
 *                            not be made (the apply would be blocked under
 *                            `enforce`). Absent when no reservation was needed.
 *   - `creditShortfall`    — `estimatedCredits - availableCredits` when that is
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
  readonly billingMode: "disabled" | "showback" | "enforce";
  readonly estimatedCredits: number;
  readonly availableCredits?: number;
  readonly reservationStatus?: "reserved" | "insufficient_credits";
  readonly creditShortfall?: number;
  readonly blocked: boolean;
  readonly reasons: readonly string[];
}

/** Body of `GET /api/runs/:runId/cost`. */
export interface RunCostResponse {
  readonly cost: RunCostInfo;
}

export type RunGroupType =
  | "space_update"
  | "space_drift_check"
  | "installation_install"
  | "installation_update"
  | "installation_destroy"
  | "migration";

export type RunGroupStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunGroup {
  readonly id: string;
  readonly spaceId: string;
  readonly type: RunGroupType;
  readonly status: RunGroupStatus;
  /** JSON-encoded DAG-ordered plan of member runs. */
  readonly graphJson: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
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
