import type {
  ProviderMaterializationPlan,
  ProviderOperationExecution,
} from "../../adapters/provider/mod.ts";
import type {
  Deployment,
  DeploymentCondition,
  DeploymentStatus,
} from "takosumi-contract";
import type { RuntimeAgentWorkItem } from "../../agents/mod.ts";
import type { DeploymentStore } from "../../domains/deploy/deployment_service.ts";
import type { ProviderMaterializationStore } from "./stores.ts";

export interface RuntimeAgentTerminalWorkProjectionResult {
  readonly providerMaterialization?: ProviderMaterializationPlan;
  readonly deployment?: Deployment;
}

export interface RuntimeAgentTerminalWorkProjectorOptions {
  readonly providerMaterializationStore?: ProviderMaterializationStore;
  readonly deploymentStore?: Pick<
    DeploymentStore,
    "getDeployment" | "putDeployment"
  >;
  readonly clock?: () => Date;
}

/**
 * Folds terminal runtime-agent results back into existing operator
 * surfaces when the work result carries enough correlation metadata.
 */
export class RuntimeAgentTerminalWorkProjector {
  readonly #providerMaterializationStore?: ProviderMaterializationStore;
  readonly #deploymentStore?: Pick<
    DeploymentStore,
    "getDeployment" | "putDeployment"
  >;
  readonly #clock: () => Date;

  constructor(options: RuntimeAgentTerminalWorkProjectorOptions = {}) {
    this.#providerMaterializationStore = options.providerMaterializationStore;
    this.#deploymentStore = options.deploymentStore;
    this.#clock = options.clock ?? (() => new Date());
  }

  complete(
    work: RuntimeAgentWorkItem,
  ): Promise<RuntimeAgentTerminalWorkProjectionResult> {
    return this.project(work);
  }

  fail(
    work: RuntimeAgentWorkItem,
  ): Promise<RuntimeAgentTerminalWorkProjectionResult> {
    return this.project(work);
  }

  async project(
    work: RuntimeAgentWorkItem,
  ): Promise<RuntimeAgentTerminalWorkProjectionResult> {
    const [providerMaterialization, deployment] = await Promise.all([
      this.#projectProviderMaterialization(work),
      this.#projectDeployment(work),
    ]);
    return { providerMaterialization, deployment };
  }

  async #projectProviderMaterialization(
    work: RuntimeAgentWorkItem,
  ): Promise<ProviderMaterializationPlan | undefined> {
    if (!this.#providerMaterializationStore) return undefined;
    const result = work.result ?? {};
    const materializationId = stringValue(
      result.materializationId ?? work.metadata.materializationId,
    );
    const desiredStateId = stringValue(
      result.desiredStateId ?? work.metadata.desiredStateId,
    );
    const operationId = stringValue(
      result.providerOperationId ?? result.operationId ??
        work.metadata.providerOperationId,
    );
    if (!operationId) return undefined;
    const plan = materializationId
      ? await this.#providerMaterializationStore.get(materializationId)
      : desiredStateId
      ? await this.#providerMaterializationStore.latestForDesiredState(
        desiredStateId,
      )
      : undefined;
    if (!plan) return undefined;
    let updated = false;
    const execution = executionFromWork(work);
    const operations = plan.operations.map((operation) => {
      if (operation.id !== operationId) return operation;
      updated = true;
      return { ...operation, execution };
    });
    if (!updated) return undefined;
    return await this.#providerMaterializationStore.put(
      freezeClone({ ...plan, operations }),
    );
  }

  async #projectDeployment(
    work: RuntimeAgentWorkItem,
  ): Promise<Deployment | undefined> {
    if (!this.#deploymentStore) return undefined;
    const result = work.result ?? {};
    const deploymentId = stringValue(
      result.deploymentId ?? work.metadata.deploymentId,
    );
    if (!deploymentId) return undefined;
    const current = await this.#deploymentStore.getDeployment(deploymentId);
    if (!current) return undefined;
    const condition = conditionFromWork(work, current.conditions.length + 1);
    const nextStatus = deploymentStatusValue(result.deploymentStatus);
    const next: Deployment = {
      ...current,
      status: nextStatus ?? current.status,
      conditions: condition
        ? [...current.conditions, condition]
        : current.conditions,
      finalized_at: nextStatus && isTerminalDeploymentStatus(nextStatus)
        ? stringValue(result.finalizedAt) ??
          terminalObservedAt(work, this.#clock)
        : current.finalized_at,
    };
    return await this.#deploymentStore.putDeployment(freezeClone(next));
  }
}

function executionFromWork(
  work: RuntimeAgentWorkItem,
): ProviderOperationExecution {
  const execution = recordValue(work.result?.execution);
  const completedAt = terminalObservedAt(work, () => new Date());
  return {
    status: work.status === "completed" ? "succeeded" : "failed",
    code: numberValue(execution?.code) ?? (work.status === "completed" ? 0 : 1),
    stdout: stringValue(execution?.stdout),
    stderr: stringValue(execution?.stderr ?? work.failureReason),
    startedAt: stringValue(execution?.startedAt) ?? work.queuedAt,
    completedAt: stringValue(execution?.completedAt) ?? completedAt,
  };
}

function conditionFromWork(
  work: RuntimeAgentWorkItem,
  observedGeneration: number,
): DeploymentCondition | undefined {
  const result = work.result ?? {};
  const provided = recordValue(result.deploymentCondition);
  if (provided) {
    const type = stringValue(provided.type);
    const status = conditionStatusValue(provided.status);
    const reason = stringValue(provided.reason);
    const lastTransition = stringValue(provided.last_transition_time) ??
      terminalObservedAt(work, () => new Date());
    if (type && status && reason) {
      return {
        type,
        status,
        reason,
        message: stringValue(provided.message),
        observed_generation: numberValue(provided.observed_generation) ??
          observedGeneration,
        last_transition_time: lastTransition,
        scope: recordValue(provided.scope) as DeploymentCondition["scope"] ??
          { kind: "operation", ref: work.id },
      };
    }
  }
  const deploymentId = stringValue(
    result.deploymentId ?? work.metadata.deploymentId,
  );
  if (!deploymentId) return undefined;
  const objectAddress = stringValue(
    result.objectAddress ?? work.metadata.objectAddress,
  ) ?? work.id;
  const success = work.status === "completed";
  return {
    type: success ? "RuntimeAgentWorkCompleted" : "RuntimeAgentWorkFailed",
    status: success ? "true" : "false",
    reason: stringValue(result.reason) ??
      (success ? "RuntimeAgentWorkCompleted" : "RuntimeAgentWorkFailed"),
    message: stringValue(result.message ?? work.failureReason),
    observed_generation: observedGeneration,
    last_transition_time: terminalObservedAt(work, () => new Date()),
    scope: { kind: "operation", ref: objectAddress },
  };
}

function terminalObservedAt(
  work: RuntimeAgentWorkItem,
  clock: () => Date,
): string {
  return work.completedAt ?? work.failedAt ?? clock().toISOString();
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function conditionStatusValue(
  value: unknown,
): DeploymentCondition["status"] | undefined {
  return value === "true" || value === "false" || value === "unknown"
    ? value
    : undefined;
}

function deploymentStatusValue(value: unknown): DeploymentStatus | undefined {
  return value === "preview" || value === "resolved" ||
      value === "applying" || value === "applied" || value === "failed" ||
      value === "rolled-back"
    ? value
    : undefined;
}

function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return status === "applied" || status === "failed" ||
    status === "rolled-back";
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
