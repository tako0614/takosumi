import type { RuntimeDesiredState } from "../../domains/runtime/mod.ts";
import type {
  ProviderMaterializationPlan,
  ProviderMaterializer,
  ProviderOperation,
} from "./types.ts";

export class NoopProviderMaterializer implements ProviderMaterializer {
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
    const operation: ProviderOperation = freezeClone({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "noop",
      provider: "noop",
      desiredStateId: desiredState.id,
      targetId: desiredState.id,
      targetName: desiredState.appName,
      command: [],
      details: {
        workloadCount: desiredState.workloads.length,
        resourceCount: desiredState.resources.length,
        routeCount: desiredState.routes.length,
      },
      recordedAt,
    });
    this.#operations.push(operation);
    return Promise.resolve(freezeClone({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "noop",
      desiredStateId: desiredState.id,
      recordedAt,
      operations: [operation],
    }));
  }

  listRecordedOperations(): Promise<readonly ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }

  #now(): string {
    return this.#clock().toISOString();
  }
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
