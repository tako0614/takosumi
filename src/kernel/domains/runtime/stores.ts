import type {
  ProviderObservation,
  RuntimeDesiredState,
  RuntimeDesiredStateId,
  RuntimeObservedStateId,
  RuntimeObservedStateSnapshot,
} from "./types.ts";

export interface RuntimeDesiredStateStore {
  put(state: RuntimeDesiredState): Promise<RuntimeDesiredState>;
  get(id: RuntimeDesiredStateId): Promise<RuntimeDesiredState | undefined>;
  findByActivation(
    spaceId: string,
    groupId: string,
    activationId: string,
  ): Promise<RuntimeDesiredState | undefined>;
  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RuntimeDesiredState[]>;
}

export interface RuntimeObservedStateStore {
  record(
    snapshot: RuntimeObservedStateSnapshot,
  ): Promise<RuntimeObservedStateSnapshot>;
  get(
    id: RuntimeObservedStateId,
  ): Promise<RuntimeObservedStateSnapshot | undefined>;
  latestForGroup(
    spaceId: string,
    groupId: string,
  ): Promise<RuntimeObservedStateSnapshot | undefined>;
  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RuntimeObservedStateSnapshot[]>;
}

export interface ProviderObservationStore {
  record(observation: ProviderObservation): Promise<ProviderObservation>;
  latestForMaterialization(
    materializationId: string,
  ): Promise<ProviderObservation | undefined>;
  listByMaterialization(
    materializationId: string,
  ): Promise<readonly ProviderObservation[]>;
}

export class InMemoryRuntimeDesiredStateStore
  implements RuntimeDesiredStateStore {
  readonly #states = new Map<RuntimeDesiredStateId, RuntimeDesiredState>();

  put(state: RuntimeDesiredState): Promise<RuntimeDesiredState> {
    const frozen = deepFreeze(structuredClone(state));
    this.#states.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: RuntimeDesiredStateId): Promise<RuntimeDesiredState | undefined> {
    return Promise.resolve(this.#states.get(id));
  }

  findByActivation(
    spaceId: string,
    groupId: string,
    activationId: string,
  ): Promise<RuntimeDesiredState | undefined> {
    for (const state of this.#states.values()) {
      if (
        state.spaceId === spaceId && state.groupId === groupId &&
        state.activationId === activationId
      ) {
        return Promise.resolve(state);
      }
    }
    return Promise.resolve(undefined);
  }

  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RuntimeDesiredState[]> {
    return Promise.resolve(
      [...this.#states.values()].filter((state) =>
        state.spaceId === spaceId && state.groupId === groupId
      ),
    );
  }
}

export class InMemoryRuntimeObservedStateStore
  implements RuntimeObservedStateStore {
  readonly #snapshots = new Map<
    RuntimeObservedStateId,
    RuntimeObservedStateSnapshot
  >();

  record(
    snapshot: RuntimeObservedStateSnapshot,
  ): Promise<RuntimeObservedStateSnapshot> {
    const frozen = deepFreeze(structuredClone(snapshot));
    this.#snapshots.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(
    id: RuntimeObservedStateId,
  ): Promise<RuntimeObservedStateSnapshot | undefined> {
    return Promise.resolve(this.#snapshots.get(id));
  }

  latestForGroup(
    spaceId: string,
    groupId: string,
  ): Promise<RuntimeObservedStateSnapshot | undefined> {
    const snapshots = [...this.#snapshots.values()]
      .filter((snapshot) =>
        snapshot.spaceId === spaceId && snapshot.groupId === groupId
      )
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    return Promise.resolve(snapshots[0]);
  }

  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RuntimeObservedStateSnapshot[]> {
    return Promise.resolve(
      [...this.#snapshots.values()].filter((snapshot) =>
        snapshot.spaceId === spaceId && snapshot.groupId === groupId
      ),
    );
  }
}

export class InMemoryProviderObservationStore
  implements ProviderObservationStore {
  readonly #observations: ProviderObservation[] = [];

  record(observation: ProviderObservation): Promise<ProviderObservation> {
    const frozen = deepFreeze(structuredClone(observation));
    this.#observations.push(frozen);
    return Promise.resolve(frozen);
  }

  latestForMaterialization(
    materializationId: string,
  ): Promise<ProviderObservation | undefined> {
    return Promise.resolve(
      this.#observations
        .filter((observation) =>
          observation.materializationId === materializationId
        )
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0],
    );
  }

  listByMaterialization(
    materializationId: string,
  ): Promise<readonly ProviderObservation[]> {
    return Promise.resolve(
      this.#observations.filter((observation) =>
        observation.materializationId === materializationId
      ),
    );
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
