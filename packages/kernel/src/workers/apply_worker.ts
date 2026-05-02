// ApplyWorker — background worker that pulls apply jobs from a queue and
// promotes a Deployment from `resolved` to `applied` via
// `DeploymentService.applyDeployment(deploymentId)`.
//
// Phase 7A (post core-simplification) rewires this worker onto the canonical
// Deployment-centric service. The worker is a thin caller — all business
// logic (descriptor closure construction, binding resolution, provider
// materialization, condition emission policy) lives in
// `DeploymentService`/downstream domain helpers. This worker is responsible
// only for: (1) loading the Deployment by id, (2) calling
// `applyDeployment`, (3) translating success/failure into domain events and
// audit entries, (4) propagating retry semantics back to the queue.

import type {
  ActorContext,
  Deployment,
  DeploymentApproval,
  DeploymentCondition,
  GroupHead,
  IsoTimestamp,
  JsonObject,
} from "takosumi-contract";
import type { AuditStore } from "../domains/audit/mod.ts";
import type {
  DeploymentService,
  DeploymentStore,
} from "../domains/deploy/deployment_service.ts";
import {
  createDomainEvent,
  type DomainEvent,
  type OutboxStore,
} from "../shared/events.ts";

/**
 * Apply job pulled from the queue. The canonical key is `deploymentId`; an
 * optional `deployment` snapshot may be supplied to short-circuit the
 * initial store read (the worker still re-fetches before acting to avoid
 * operating on a stale snapshot).
 *
 * The job carries `plan?` (a Deployment record) and `operationId?` for job
 * authors that thread a Deployment object directly through the queue. When
 * `deploymentId` is omitted, the worker falls back to `plan.id`. The job is
 * rejected at runtime if neither is supplied.
 */
export interface ApplyWorkerJob {
  readonly deploymentId?: string;
  readonly deployment?: Deployment;
  readonly appliedAt?: IsoTimestamp;
  readonly approval?: DeploymentApproval;
  readonly actor?: ActorContext;
  readonly correlationId?: string;
  readonly plan?: Deployment;
  readonly operationId?: string;
}

/**
 * Result of a single `process` invocation. `deployment` is the post-apply
 * Deployment record; `head` is the current GroupHead pointer (if the store
 * exposes one). `events` is the set of outbox events the worker emitted.
 */
export interface ApplyWorkerResult {
  readonly deployment: Deployment;
  readonly head?: GroupHead;
  readonly events: readonly DomainEvent[];
}

export interface ApplyWorkerOptions {
  readonly store: DeploymentStore;
  readonly deploymentService: DeploymentService;
  readonly auditStore?: AuditStore;
  readonly outboxStore?: OutboxStore;
  readonly clock?: () => Date;
}

/**
 * Stable error codes emitted on the `deploy.apply.failed` event payload. The
 * worker maps every failure into one of these codes so downstream consumers
 * (queue retry policy, dashboards, audit) can route uniformly.
 */
export type ApplyFailureCode =
  | "DEPLOYMENT_STALE"
  | "POLICY_BLOCKED"
  | "PROVIDER_FAILED"
  | "APPLY_FAILED";

export class ApplyWorker {
  readonly #store: DeploymentStore;
  readonly #service: DeploymentService;
  readonly #auditStore?: AuditStore;
  readonly #outboxStore?: OutboxStore;
  readonly #clock: () => Date;

  constructor(options: ApplyWorkerOptions) {
    this.#store = options.store;
    this.#service = options.deploymentService;
    this.#auditStore = options.auditStore;
    this.#outboxStore = options.outboxStore;
    this.#clock = options.clock ?? (() => new Date());
  }

  async process(job: ApplyWorkerJob): Promise<ApplyWorkerResult> {
    const startedAt = this.#clock().toISOString();
    const deploymentId = job.deploymentId ?? job.deployment?.id ?? job.plan?.id;
    if (!deploymentId) {
      throw new Error(
        "ApplyWorkerJob requires `deploymentId` (or a `deployment`/`plan` carrying an id)",
      );
    }
    const initial = await this.#store.getDeployment(deploymentId);
    if (!initial) {
      const failure: ApplyFailureInfo = {
        message: `unknown deployment: ${deploymentId}`,
        code: "APPLY_FAILED",
      };
      await this.#emitFailed(job, deploymentId, undefined, startedAt, failure);
      throw new Error(failure.message);
    }

    try {
      const applied = await this.#service.applyDeployment({
        deploymentId,
        appliedAt: job.appliedAt ?? startedAt,
        approval: job.approval,
      });
      const completedAt = this.#clock().toISOString();
      const head = await this.#store.getGroupHead({
        spaceId: applied.space_id,
        groupId: applied.group_id,
      });
      const events = await this.#emitSucceeded(job, applied, head, completedAt);
      return { deployment: applied, head, events };
    } catch (error) {
      const failedAt = this.#clock().toISOString();
      const failure = classifyApplyFailure(error);
      await this.#emitFailed(job, deploymentId, initial, failedAt, failure);
      throw error;
    }
  }

  async #emitSucceeded(
    job: ApplyWorkerJob,
    deployment: Deployment,
    head: GroupHead | undefined,
    occurredAt: IsoTimestamp,
  ): Promise<readonly DomainEvent[]> {
    const payload: JsonObject = {
      deploymentId: deployment.id,
      groupId: deployment.group_id,
      groupHeadDeploymentId: head?.current_deployment_id ?? null,
      groupHeadGeneration: head?.generation ?? null,
      status: deployment.status,
      conditions: serializeConditions(deployment.conditions),
    };
    const event = createDomainEvent({
      type: "deploy.apply.succeeded",
      aggregateType: "deploy.deployment",
      aggregateId: deployment.id,
      payload,
      metadata: { correlationId: job.correlationId, actor: job.actor },
    });
    await this.#outboxStore?.append(event);
    await this.#auditStore?.append({
      id: `audit_${event.id}`,
      eventClass: "compliance",
      type: event.type,
      severity: "info",
      actor: job.actor,
      spaceId: deployment.space_id,
      groupId: deployment.group_id,
      targetType: "deploy.deployment",
      targetId: deployment.id,
      payload,
      occurredAt,
      requestId: job.actor?.requestId,
      correlationId: job.correlationId,
    });
    return [event];
  }

  async #emitFailed(
    job: ApplyWorkerJob,
    deploymentId: string,
    deployment: Deployment | undefined,
    occurredAt: IsoTimestamp,
    failure: ApplyFailureInfo,
  ): Promise<void> {
    const payload: JsonObject = {
      deploymentId,
      error: failure.message,
      code: failure.code,
    };
    if (failure.staleEntries) payload.staleEntries = failure.staleEntries;
    if (deployment) {
      payload.groupId = deployment.group_id;
      payload.status = deployment.status;
      payload.conditions = serializeConditions(deployment.conditions);
    }
    const event = createDomainEvent({
      type: "deploy.apply.failed",
      aggregateType: "deploy.deployment",
      aggregateId: deploymentId,
      payload,
      metadata: { correlationId: job.correlationId, actor: job.actor },
    });
    await this.#outboxStore?.append(event);
    await this.#auditStore?.append({
      id: `audit_${event.id}`,
      eventClass: "compliance",
      type: event.type,
      severity: "warning",
      actor: job.actor,
      spaceId: deployment?.space_id,
      groupId: deployment?.group_id,
      targetType: "deploy.deployment",
      targetId: deploymentId,
      payload,
      occurredAt,
      requestId: job.actor?.requestId,
      correlationId: job.correlationId,
    });
  }
}

interface ApplyFailureInfo {
  readonly message: string;
  readonly code: ApplyFailureCode;
  readonly staleEntries?: JsonObject[];
}

function classifyApplyFailure(error: unknown): ApplyFailureInfo {
  const message = error instanceof Error ? error.message : String(error);
  if (isStaleDeploymentError(error)) {
    const stale = (error as { staleEntries?: readonly unknown[] }).staleEntries;
    return {
      message,
      code: "DEPLOYMENT_STALE",
      staleEntries: stale?.map(toJsonObject),
    };
  }
  if (isPolicyBlockedError(error)) {
    return { message, code: "POLICY_BLOCKED" };
  }
  if (isProviderFailureError(error)) {
    return { message, code: "PROVIDER_FAILED" };
  }
  return { message, code: "APPLY_FAILED" };
}

function isStaleDeploymentError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error.name === "DeploymentStaleError") return true;
  return error.message.startsWith("stale group head") ||
    error.message.includes("stale read-set");
}

function isPolicyBlockedError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error.name === "DeploymentBlockedError") return true;
  return error.message.startsWith("deployment blocked by");
}

function isProviderFailureError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return error.name === "ProviderFailureError" ||
    error.message.startsWith("provider materialization failed");
}

function serializeConditions(
  conditions: readonly DeploymentCondition[],
): JsonObject[] {
  return conditions.map((condition) => ({
    type: condition.type,
    status: condition.status,
    reason: condition.reason ?? null,
    message: condition.message ?? null,
    observedGeneration: condition.observed_generation ?? null,
    lastTransitionTime: condition.last_transition_time ?? null,
  }));
}

function toJsonObject(entry: unknown): JsonObject {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return { ...(entry as Record<string, unknown>) } as JsonObject;
  }
  return { value: String(entry) };
}
