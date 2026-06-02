import type {
  ProviderMaterializationPlan,
  ProviderOperation,
} from "../../adapters/provider/mod.ts";

export type ProviderMaterializationPlanId = string;

export interface ProviderMaterializationStore {
  put(plan: ProviderMaterializationPlan): Promise<ProviderMaterializationPlan>;
  get(
    id: ProviderMaterializationPlanId,
  ): Promise<ProviderMaterializationPlan | undefined>;
  latestForDesiredState(
    desiredStateId: string,
  ): Promise<ProviderMaterializationPlan | undefined>;
  listByDesiredState(
    desiredStateId: string,
  ): Promise<readonly ProviderMaterializationPlan[]>;
  listRecordedOperations(
    desiredStateId?: string,
  ): Promise<readonly ProviderOperation[]>;
}

export class InMemoryProviderMaterializationStore
  implements ProviderMaterializationStore {
  readonly #plans = new Map<
    ProviderMaterializationPlanId,
    ProviderMaterializationPlan
  >();

  put(plan: ProviderMaterializationPlan): Promise<ProviderMaterializationPlan> {
    const frozen = deepFreeze(structuredClone(plan));
    this.#plans.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(
    id: ProviderMaterializationPlanId,
  ): Promise<ProviderMaterializationPlan | undefined> {
    return Promise.resolve(this.#plans.get(id));
  }

  latestForDesiredState(
    desiredStateId: string,
  ): Promise<ProviderMaterializationPlan | undefined> {
    const plans = [...this.#plans.values()]
      .filter((plan) => plan.desiredStateId === desiredStateId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return Promise.resolve(plans[0]);
  }

  listByDesiredState(
    desiredStateId: string,
  ): Promise<readonly ProviderMaterializationPlan[]> {
    return Promise.resolve(
      [...this.#plans.values()].filter((plan) =>
        plan.desiredStateId === desiredStateId
      ),
    );
  }

  listRecordedOperations(
    desiredStateId?: string,
  ): Promise<readonly ProviderOperation[]> {
    const operations = [...this.#plans.values()]
      .filter((plan) =>
        desiredStateId === undefined || plan.desiredStateId === desiredStateId
      )
      .flatMap((plan) => [...plan.operations]);
    return Promise.resolve(operations);
  }
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
