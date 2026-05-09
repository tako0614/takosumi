import type { RuntimeDesiredState } from "../../domains/runtime/mod.ts";
import type {
  ProviderMaterializationPlan,
  ProviderMaterializer,
  ProviderOperation,
} from "./types.ts";

export class DryRunProviderMaterializer implements ProviderMaterializer {
  readonly #operations: ProviderOperation[] = [];
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(
    options: {
      readonly clock?: () => Date;
      readonly idGenerator?: () => string;
    } = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<ProviderMaterializationPlan> {
    const recordedAt = this.#now();
    const planId = `provider_plan_${this.#idGenerator()}`;
    const operations: ProviderOperation[] = [
      ...desiredState.workloads.map((workload) =>
        this.#operation({
          kind: "runtime.workload.ensure",
          desiredState,
          targetId: workload.id,
          targetName: workload.componentName,
          details: {
            runtimeName: workload.runtimeName,
            type: workload.type,
            image: workload.image,
          },
          recordedAt,
        })
      ),
      ...desiredState.resources.map((resource) =>
        this.#operation({
          kind: "runtime.resource.ensure",
          desiredState,
          targetId: resource.id,
          targetName: resource.resourceName,
          details: {
            runtimeName: resource.runtimeName,
            type: resource.type,
          },
          recordedAt,
        })
      ),
      ...desiredState.routes.map((route) =>
        this.#operation({
          kind: queueProtocol(route.protocol ?? "https")
            ? "queue.subscription.ensure"
            : "router.listener.ensure",
          desiredState,
          targetId: route.id,
          targetName: route.routeName,
          details: {
            protocol: route.protocol ?? "https",
            host: route.host,
            path: route.path,
            port: route.port,
            source: route.source,
            targetComponentName: route.targetComponentName,
            targetPort: route.targetPort,
          },
          recordedAt,
        })
      ),
    ];
    this.#operations.push(...operations);
    return Promise.resolve(freezeClone({
      id: planId,
      provider: "provider.dry-run",
      desiredStateId: desiredState.id,
      recordedAt,
      operations,
    }));
  }

  listRecordedOperations(): Promise<readonly ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }

  #operation(input: {
    readonly kind: string;
    readonly desiredState: RuntimeDesiredState;
    readonly targetId: string;
    readonly targetName: string;
    readonly details: Record<string, unknown>;
    readonly recordedAt: string;
  }): ProviderOperation {
    return freezeClone({
      id: `provider_op_${this.#idGenerator()}`,
      kind: input.kind,
      provider: "provider.dry-run",
      desiredStateId: input.desiredState.id,
      targetId: input.targetId,
      targetName: input.targetName,
      command: [],
      details: input.details,
      recordedAt: input.recordedAt,
    });
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function queueProtocol(protocol: string): boolean {
  return protocol === "queue";
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
