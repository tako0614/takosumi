/**
 * Unified Run read-projection facade (Core Specification §6.8 / §19 / §30).
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: every method
 * here is a read-only projection over the {@link OpenTofuDeploymentStore} (no
 * mutation, no run-execution coupling, no credential mint). The controller holds
 * one instance and re-exposes the public reads (`getRun` / `getRunLogs` /
 * `getRunEvents` / `getRunCost`) on its public API unchanged, so the `/api` run
 * ledger route layers keep calling the controller surface.
 *
 * Two pure projection helpers — {@link RunQueryService.planAwaitsApproval} and
 * {@link RunQueryService.installationProjection} — are owned here because they are
 * functions of a stored PlanRun alone (no controller mutation state). The
 * controller's run-engine mutations (`cancelRun` / `approveRun`) call back into
 * this service for those helpers so the §25 approval-gate logic and the §19 Run
 * installation projection live in exactly one place.
 */

import type {
  DeployControlAuditEvent,
  PlanRun,
  RunDiagnostic,
} from "@takosumi/internal/deploy-control-api";
import type {
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
} from "takosumi-contract/runs";
import type {
  OpenTofuDeploymentStore,
  RecoverableOpenTofuRunListOptions,
} from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import {
  projectApplyRun,
  projectPlanRun,
  projectPlanRunCost,
  projectSourceSyncRun,
} from "./projection_run.ts";

/**
 * Recorded installation context + source/dependency snapshot projection threaded
 * onto the §19 Run projection options. Empty for runs without installation
 * context.
 */
export interface RunInstallationProjection {
  installationId?: string;
  environment?: string;
  sourceSnapshotId?: string;
  dependencySnapshotId?: string;
  runGroupId?: string;
}

/** Read-only unified Run projections over the run ledger. */
export class RunQueryService {
  readonly #store: OpenTofuDeploymentStore;

  constructor(store: OpenTofuDeploymentStore) {
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
        ...this.installationProjection(planRun),
      });
    }
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      // The ApplyRun does not carry env context; recover it from its PlanRun so
      // the unified Run still projects installationId / environment / sourceSnapshotId.
      const plan = await this.#store.getPlanRun(applyRun.planRunId);
      return projectApplyRun(
        applyRun,
        plan ? this.installationProjection(plan) : {},
      );
    }
    const sync = await this.#store.getSourceSyncRun(id);
    if (sync) return projectSourceSyncRun(sync);
    const compatibilityCheck = await this.#store.getCompatibilityCheckRun(id);
    if (compatibilityCheck) return compatibilityCheck;
    const backupRun = await this.#store.getBackupRun(id);
    if (backupRun) return backupRun;
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Lists a Workspace's unified Run projections newest first. The store returns
   * raw internal run rows, then each row is re-read through `getRun` so the
   * public projection stays identical to `GET /runs/:id` and never exposes
   * internal PlanRun / ApplyRun fields or credential material.
   */
  async listRuns(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly Run[]> {
    requireNonEmptyString(spaceId, "spaceId");
    const rows = await this.#store.listRunsBySpace(spaceId, options);
    return await Promise.all(rows.map((row) => this.getRun(row.id)));
  }

  async listRecoverableOpenTofuRuns(
    options: RecoverableOpenTofuRunListOptions,
  ): Promise<readonly Run[]> {
    const rows = await this.#store.listRecoverableOpenTofuRuns(options);
    return await Promise.all(rows.map((row) => this.getRun(row.id)));
  }

  /**
   * Reads the run-level diagnostics + audit trail for a Run (spec §30 `GET
   * /internal/v1/runs/:runId/logs`). Diagnostics + audit events are recorded on the
   * underlying PlanRun / ApplyRun ledger record; a `source_sync` run carries no
   * structured diagnostics, so its single `error`, when present, is surfaced as
   * one error diagnostic. Returns the unified `{ diagnostics, auditEvents }`
   * shape. A missing run is a typed 404.
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
   * re-projects the billing reservation values the controller ALREADY computed
   * at plan time (estimated credits / available credits / reservation status /
   * the credit-shortfall + plan-limit reasons recorded on the run's policy
   * decision), so a dashboard can explain, before apply, why an apply would be
   * blocked under `enforce` mode. It computes no cost (never calls the credit
   * estimator) and surfaces no secret material. Only a PlanRun (and the
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
   * auditEvents }`. PlanRun / ApplyRun carry both; a SourceSyncRun has neither,
   * so its `error` is projected to a single error diagnostic and its audit trail
   * is empty. A missing run is a typed 404. Used by the run logs/events routes;
   * no credential material or sensitive output value enters these projections.
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
        diagnostics: sync.error
          ? [{ severity: "error", message: sync.error }]
          : [],
        auditEvents: [],
      };
    }
    const compatibilityCheck = await this.#store.getCompatibilityCheckRun(id);
    if (compatibilityCheck) {
      return {
        diagnostics: compatibilityCheck.errorCode
          ? [{ severity: "error", message: compatibilityCheck.errorCode }]
          : [],
        auditEvents: [],
      };
    }
    const backupRun = await this.#store.getBackupRun(id);
    if (backupRun) {
      return {
        diagnostics: backupRun.errorCode
          ? [{ severity: "error", message: backupRun.errorCode }]
          : [],
        auditEvents: [],
      };
    }
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Projects a PlanRun's recorded installation context + source snapshot onto
   * the §19 Run projection options. Empty for runs without installation
   * context.
   */
  installationProjection(planRun: PlanRun): RunInstallationProjection {
    return {
      ...(planRun.installationContext
        ? {
            installationId: planRun.installationContext.installationId,
            environment: planRun.installationContext.environment,
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
   * action-policy delete/replace `requiresApproval` change, or a template
   * destructive-confirmation change), so this is a pure read of the persisted
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
    if (planRun.templateBinding?.requiresConfirmation === true) {
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
}
