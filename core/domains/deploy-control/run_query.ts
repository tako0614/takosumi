/**
 * Unified Run read-projection facade (Core Specification §6.8 / §19 / §30).
 *
 * A thin collaborator pulled out of `OpenTofuController`: every method
 * here is a read-only projection over the {@link OpenTofuControlStore} (no
 * mutation, no run-execution coupling, no credential mint). The controller holds
 * one instance and re-exposes the public reads (`getRun` / `getRunLogs` /
 * `getRunEvents` / `getRunCost`) on its public API unchanged, so the `/api` run
 * ledger route layers keep calling the controller surface.
 *
 * Two pure projection helpers — {@link RunQueryService.planAwaitsApproval} and
 * {@link RunQueryService.capsuleProjection} — are owned here because they are
 * functions of a stored PlanRun alone (no controller mutation state). The
 * controller's run-engine mutations (`cancelRun` / `approveRun`) call back into
 * this service for those helpers so the §25 approval-gate logic and the §19 Run
 * Capsule projection live in exactly one place.
 */

import type {
  ApplyRun,
  DeployControlAuditEvent,
  PlanRun,
  RunDiagnostic,
} from "@takosumi/internal/deploy-control-api";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type {
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
} from "takosumi-contract/runs";
import {
  isResourceOperationRun,
  type ResourceOperationRun,
  type OpenTofuControlStore,
  type RecoverableOpenTofuRunListOptions,
  type StoredRunRecord,
} from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import {
  projectApplyRun,
  projectPlanRun,
  projectPlanRunCost,
  projectSourceSyncRun,
} from "./projection_run.ts";

/**
 * Recorded Capsule context + source/dependency snapshot projection threaded
 * onto the §19 Run projection options. Empty for runs without Capsule
 * context.
 */
export interface RunCapsuleProjection {
  capsuleId?: string;
  resourceId?: string;
  environment?: string;
  sourceSnapshotId?: string;
  dependencySnapshotId?: string;
  runGroupId?: string;
}

/** Read-only unified Run projections over the run ledger. */
export class RunQueryService {
  readonly #store: OpenTofuControlStore;

  constructor(store: OpenTofuControlStore) {
    this.#store = store;
  }

  /**
   * Resolves a run id to the unified §6.8 {@link Run} projection, looking across
   * the PlanRun / ApplyRun / SourceSyncRun ledgers by id prefix. `waiting_approval`
   * is now a PERSISTED status (an approval gate parks the plan there at
   * completion); the projection reads it back directly.
   */
  async getRun(id: string): Promise<Run> {
    requireNonEmptyString(id, "runId");
    const planRun = await this.#store.getPlanRun(id);
    if (planRun) {
      return projectPlanRun(planRun, {
        awaitingApproval: await this.planAwaitsApproval(planRun),
        ...this.capsuleProjection(planRun),
      });
    }
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      // The ApplyRun does not carry env context; recover it from its PlanRun so
      // the unified Run still projects capsuleId / environment / sourceSnapshotId.
      const plan = await this.#store.getPlanRun(applyRun.planRunId);
      return projectApplyRun(
        applyRun,
        plan ? this.capsuleProjection(plan) : {},
      );
    }
    const sync = await this.#store.getSourceSyncRun(id);
    if (sync) return projectSourceSyncRun(sync);
    const resourceOperation = await this.#store.getResourceOperationRun(id);
    if (resourceOperation)
      return projectResourceOperationRun(resourceOperation);
    const compatibilityCheck = await this.#store.getCompatibilityCheckRun(id);
    if (compatibilityCheck) return compatibilityCheck;
    const backupRun = await this.#store.getBackupRun(id);
    if (backupRun) return backupRun;
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Lists a Workspace's unified Run projections newest first. The store returns
   * raw internal run rows with DB-side limit/order. Project them directly so
   * the dashboard list does not re-read every selected row by id; ApplyRun rows
   * still read their source PlanRun once when they need Capsule context.
   */
  async listRuns(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly Run[]> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const rows = await this.#store.listRunsByWorkspace(workspaceId, options);
    return await Promise.all(rows.map((row) => this.#projectStoredRun(row)));
  }

  async listRecoverableOpenTofuRuns(
    options: RecoverableOpenTofuRunListOptions,
  ): Promise<readonly Run[]> {
    const rows = await this.#store.listRecoverableOpenTofuRuns(options);
    return await Promise.all(rows.map((row) => this.#projectStoredRun(row)));
  }

  async #projectStoredRun(row: StoredRunRecord): Promise<Run> {
    if (isStoredPlanRun(row)) {
      return projectPlanRun(row, {
        awaitingApproval: await this.planAwaitsApproval(row),
        ...this.capsuleProjection(row),
      });
    }
    if (isStoredApplyRun(row)) {
      const plan = await this.#store.getPlanRun(row.planRunId);
      return projectApplyRun(row, plan ? this.capsuleProjection(plan) : {});
    }
    if (isStoredSourceSyncRun(row)) return projectSourceSyncRun(row);
    if (isResourceOperationRun(row)) {
      return projectResourceOperationRun(row);
    }
    if (isPublicRunRecord(row)) return row;
    const _exhaustive: never = row;
    void _exhaustive;
    throw new OpenTofuControllerError("not_found", "unsupported run record");
  }

  /**
   * Reads the run-level diagnostics + audit trail for a Run (spec §30 `GET
   * /internal/v1/runs/:runId/logs`). Diagnostics + audit events are recorded on the
   * underlying PlanRun / ApplyRun ledger record; a `source_sync` run projects
   * public-safe phase timings plus its single `error`, when present. Returns
   * the unified `{ diagnostics, auditEvents }` shape. A missing run is a typed
   * 404.
   */
  async getRunLogs(id: string): Promise<RunLogsResponse> {
    requireNonEmptyString(id, "runId");
    const record = await this.#requireRunRecordWithLogs(id);
    return { diagnostics: record.diagnostics, auditEvents: record.auditEvents };
  }

  /**
   * Reads the run-level audit trail for a Run (spec §30 `GET
   * /internal/v1/runs/:runId/events`). MVP: the run-level audit events only.
   */
  async getRunEvents(id: string): Promise<RunEventsResponse> {
    requireNonEmptyString(id, "runId");
    const record = await this.#requireRunRecordWithLogs(id);
    return { auditEvents: record.auditEvents };
  }

  /**
   * Public, non-secret cost projection for a `plan` / `destroy_plan` Run. It
   * re-projects the values the controller ALREADY computed at plan time
   * (estimated USD, showback or host-extension decision, and policy reasons),
   * so a dashboard can explain the decision before apply. It computes no cost
   * and surfaces no secret material. Only a PlanRun (and the
   * destroy_plan that is a PlanRun) carries billing; an ApplyRun / SourceSyncRun
   * resolves to the PlanRun that produced it where possible, else `not_found`.
   */
  async getRunCost(id: string): Promise<RunCostInfo> {
    requireNonEmptyString(id, "runId");
    const planRun = await this.#store.getPlanRun(id);
    if (planRun) return projectPlanRunCost(planRun);
    // An apply / destroy_apply carries no billing of its own; resolve the
    // PlanRun it was applied from so the cost view follows the same run lineage.
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      const plan = await this.#store.getPlanRun(applyRun.planRunId);
      if (plan) return projectPlanRunCost(plan);
    }
    throw new OpenTofuControllerError(
      "not_found",
      `cost not available for run ${id}`,
    );
  }

  /**
   * Resolves a Run id to its underlying ledger record's `{ diagnostics,
   * auditEvents }`. PlanRun / ApplyRun carry both; a SourceSyncRun projects
   * public-safe phase timings and its `error`; its audit trail is empty. A
   * missing run is a typed 404. Used by the run logs/events routes; no
   * credential material or sensitive output value enters these projections.
   */
  async #requireRunRecordWithLogs(id: string): Promise<{
    readonly diagnostics: readonly RunDiagnostic[];
    readonly auditEvents: readonly DeployControlAuditEvent[];
  }> {
    const planRun = await this.#store.getPlanRun(id);
    if (planRun) {
      return {
        diagnostics: planRun.diagnostics ?? [],
        auditEvents: planRun.auditEvents,
      };
    }
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      return {
        diagnostics: applyRun.diagnostics ?? [],
        auditEvents: applyRun.auditEvents,
      };
    }
    const sync = await this.#store.getSourceSyncRun(id);
    if (sync) {
      return {
        diagnostics: sourceSyncDiagnostics(sync),
        auditEvents: [],
      };
    }
    const resourceOperation = await this.#store.getResourceOperationRun(id);
    if (resourceOperation) {
      return {
        diagnostics: resourceOperation.errorCode
          ? [
              {
                severity: "error",
                code: resourceOperation.errorCode,
                message: resourceOperation.errorCode,
              },
            ]
          : [],
        auditEvents: [],
      };
    }
    const compatibilityCheck = await this.#store.getCompatibilityCheckRun(id);
    if (compatibilityCheck) {
      return {
        diagnostics: compatibilityCheck.errorCode
          ? [
              {
                severity: "error",
                code: compatibilityCheck.errorCode,
                message: compatibilityCheck.errorCode,
              },
            ]
          : [],
        auditEvents: [],
      };
    }
    const backupRun = await this.#store.getBackupRun(id);
    if (backupRun) {
      return {
        diagnostics: backupRun.errorCode
          ? [
              {
                severity: "error",
                code: backupRun.errorCode,
                message: backupRun.errorCode,
              },
            ]
          : [],
        auditEvents: [],
      };
    }
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Projects a PlanRun's recorded Capsule context + source snapshot onto
   * the §19 Run projection options. Empty for runs without Capsule
   * context.
   */
  capsuleProjection(planRun: PlanRun): RunCapsuleProjection {
    return {
      ...(planRun.capsuleContext
        ? {
            capsuleId: planRun.capsuleContext.capsuleId,
            environment: planRun.capsuleContext.environment,
          }
        : {}),
      ...(planRun.resourceContext
        ? {
            resourceId: planRun.resourceContext.resourceId,
            environment: planRun.resourceContext.environment,
          }
        : {}),
      ...(planRun.sourceSnapshotId
        ? { sourceSnapshotId: planRun.sourceSnapshotId }
        : {}),
      ...(planRun.dependencySnapshotId
        ? { dependencySnapshotId: planRun.dependencySnapshotId }
        : {}),
      ...(planRun.runGroupId ? { runGroupId: planRun.runGroupId } : {}),
    };
  }

  /**
   * Whether a plan run is parked awaiting an explicit approval before its apply
   * may proceed (§25 action policy). `waiting_approval` is now a PERSISTED status
   * (the plan completion parks the plan there when it is a destroy plan, an
   * action-policy delete/replace `requiresApproval` change), so this is a pure read of the persisted
   * status: a plan awaits approval iff it is still `waiting_approval` and has not
   * already been approved/applied.
   *
   * A legacy row persisted `succeeded` (before the persisted-status change) that
   * still carries an approval gate is also surfaced as awaiting approval, so old
   * rows keep their two-stage behavior.
   */
  planAwaitsApproval(planRun: PlanRun): Promise<boolean> {
    if (planRun.appliedApplyRunId) return Promise.resolve(false);
    if (planRun.approval) return Promise.resolve(false);
    if (planRun.status === "waiting_approval") return Promise.resolve(true);
    // Back-compat for rows persisted `succeeded` before `waiting_approval` was a
    // persisted status. A §19 drift_check is read-only and never parks.
    if (planRun.driftCheck === true) return Promise.resolve(false);
    if (planRun.status !== "succeeded") return Promise.resolve(false);
    if (planRun.operation === "destroy") return Promise.resolve(true);
    if (planRun.requiresApproval === true) return Promise.resolve(true);
    return Promise.resolve(false);
  }
}

function isStoredPlanRun(row: StoredRunRecord): row is PlanRun {
  const candidate = row as Partial<PlanRun>;
  return (
    typeof candidate.sourceDigest === "string" &&
    typeof candidate.variablesDigest === "string" &&
    typeof candidate.policyDecisionDigest === "string" &&
    candidate.policy !== undefined
  );
}

function isStoredApplyRun(row: StoredRunRecord): row is ApplyRun {
  const candidate = row as Partial<ApplyRun>;
  return (
    typeof candidate.planRunId === "string" &&
    candidate.expected !== undefined &&
    candidate.stateBackend !== undefined
  );
}

function isStoredSourceSyncRun(row: StoredRunRecord): row is SourceSyncRun {
  return (row as Partial<SourceSyncRun>).kind === "source_sync";
}

function isPublicRunRecord(row: StoredRunRecord): row is Run {
  return typeof (row as Partial<Run>).type === "string";
}

function projectResourceOperationRun(run: ResourceOperationRun): Run {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    subject: run.subject,
    resourceOperation: run.resourceOperation,
    type: run.type,
    status: run.status,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
  };
}

function sourceSyncDiagnostics(sync: SourceSyncRun): readonly RunDiagnostic[] {
  const diagnostics: RunDiagnostic[] = [];
  const timingDetail = sourceSyncTimingDetail(sync);
  if (timingDetail) {
    diagnostics.push({
      severity: "info",
      message: "source sync phase timings recorded",
      detail: timingDetail,
    });
  }
  if (sync.error) {
    diagnostics.push({
      severity: "error",
      ...(sync.errorCode ? { code: sync.errorCode } : {}),
      message: sync.error,
    });
  }
  return diagnostics;
}

function sourceSyncTimingDetail(sync: SourceSyncRun): string | undefined {
  const details =
    sync.phaseTimings?.flatMap((timing) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(timing.phase)) return [];
      if (
        typeof timing.durationMs !== "number" ||
        !Number.isFinite(timing.durationMs) ||
        timing.durationMs < 0
      ) {
        return [];
      }
      return [`${timing.phase}=${Math.round(timing.durationMs)}ms`];
    }) ?? [];
  return details.length > 0 ? details.join(", ") : undefined;
}
