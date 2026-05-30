// In-memory implementations of the runtime domain stores:
//   - MemoryRuntimeDesiredStateStore
//   - MemoryRuntimeObservedStateStore
//   - MemoryProviderObservationStore

import type {
  ProviderObservationStore,
  RuntimeDesiredStateStore,
  RuntimeObservedStateStore,
} from "../../../domains/runtime/stores.ts";
import type {
  ProviderObservation,
  RuntimeDesiredState,
  RuntimeDesiredStateId,
  RuntimeObservedStateId,
  RuntimeObservedStateSnapshot,
} from "../../../domains/runtime/types.ts";
import { immutable } from "./helpers.ts";

export class MemoryRuntimeDesiredStateStore
  implements RuntimeDesiredStateStore {
  constructor(
    private readonly states: Map<RuntimeDesiredStateId, RuntimeDesiredState>,
  ) {}

  put(state: RuntimeDesiredState): Promise<RuntimeDesiredState> {
    const value = immutable(state);
    this.states.set(value.id, value);
    return Promise.resolve(value);
  }

  get(id: RuntimeDesiredStateId): Promise<RuntimeDesiredState | undefined> {
    return Promise.resolve(this.states.get(id));
  }

  findByActivation(
    spaceId: string,
    groupId: string,
    activationId: string,
  ): Promise<RuntimeDesiredState | undefined> {
    for (const state of this.states.values()) {
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
      [...this.states.values()].filter((state) =>
        state.spaceId === spaceId && state.groupId === groupId
      ),
    );
  }
}

export class MemoryRuntimeObservedStateStore
  implements RuntimeObservedStateStore {
  constructor(
    private readonly snapshots: Map<
      RuntimeObservedStateId,
      RuntimeObservedStateSnapshot
    >,
  ) {}

  record(
    snapshot: RuntimeObservedStateSnapshot,
  ): Promise<RuntimeObservedStateSnapshot> {
    const value = immutable(snapshot);
    this.snapshots.set(value.id, value);
    return Promise.resolve(value);
  }

  get(
    id: RuntimeObservedStateId,
  ): Promise<RuntimeObservedStateSnapshot | undefined> {
    return Promise.resolve(this.snapshots.get(id));
  }

  latestForGroup(
    spaceId: string,
    groupId: string,
  ): Promise<RuntimeObservedStateSnapshot | undefined> {
    return Promise.resolve(
      [...this.snapshots.values()]
        .filter((snapshot) =>
          snapshot.spaceId === spaceId && snapshot.groupId === groupId
        )
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0],
    );
  }

  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RuntimeObservedStateSnapshot[]> {
    return Promise.resolve(
      [...this.snapshots.values()].filter((snapshot) =>
        snapshot.spaceId === spaceId && snapshot.groupId === groupId
      ),
    );
  }
}

export class MemoryProviderObservationStore
  implements ProviderObservationStore {
  constructor(private readonly observations: ProviderObservation[]) {}

  record(observation: ProviderObservation): Promise<ProviderObservation> {
    const value = immutable(observation);
    this.observations.push(value);
    return Promise.resolve(value);
  }

  latestForMaterialization(
    materializationId: string,
  ): Promise<ProviderObservation | undefined> {
    return Promise.resolve(
      this.observations
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
      this.observations.filter((observation) =>
        observation.materializationId === materializationId
      ),
    );
  }
}
