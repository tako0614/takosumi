/**
 * Run + RunGroup contract (Core Specification §19 / §27 `runs` /
 * `run_groups`).
 *
 * A Run is ONE execution against an Installation — the single ledger row that
 * replaces the retired PlanRun/ApplyRun split; the kind lives in `type`.
 * Destroy is 2-phase (`destroy_plan` -> approval -> `destroy_apply`,
 * invariant 16). Apply-kind runs only ever execute a saved plan after
 * verifying plan digest / source snapshot / dependency snapshot / state
 * generation (invariants 6-10).
 *
 * A RunGroup orders multiple Runs across the dependency DAG (e.g. a Space
 * update after stale propagation); `graphJson` records the planned order.
 */

import type {
  DeployControlAuditEvent,
  RunDiagnostic,
} from "./deploy-control-api.ts";

export type RunType =
  | "source_sync"
  | "plan"
  | "apply"
  | "destroy_plan"
  | "destroy_apply"
  | "drift_check"
  | "backup"
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
  /**
   * Spec-required (§27 NOT NULL); optional here only because `source_sync`
   * rows are Source-scoped until sources bind to Installations — tracked in
   * core-conformance.md.
   */
  readonly installationId?: string;
  readonly environment?: string;
  readonly type: RunType;
  readonly status: RunStatus;
  readonly sourceSnapshotId?: string;
  readonly dependencySnapshotId?: string;
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

/**
 * Body of `GET /api/runs/:runId/logs` (spec §30). MVP: the run record's
 * structured diagnostics + the run-level audit trail (the per-run policy /
 * lease / dispatch trace). Logs pass through redaction (invariant 15); no
 * credential material or sensitive output values appear here.
 */
export interface RunLogsResponse {
  readonly diagnostics: readonly RunDiagnostic[];
  readonly auditEvents: readonly DeployControlAuditEvent[];
}

/**
 * Body of `GET /api/runs/:runId/events` (spec §30). MVP: the run-level audit
 * trail only.
 */
export interface RunEventsResponse {
  readonly auditEvents: readonly DeployControlAuditEvent[];
}

export type RunGroupType =
  | "space_update"
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
