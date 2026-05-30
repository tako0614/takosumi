import type {
  CoreOutputResolution,
  CoreOutputResolutionId,
  GroupId,
  Output,
  OutputConsumerBinding,
  OutputGrant,
  OutputId,
  OutputProjection,
  OutputProjectionId,
  OutputQuery,
  SpaceId,
} from "./types.ts";

export interface OutputStore {
  put(output: Output): Promise<Output>;
  get(id: OutputId): Promise<Output | undefined>;
  findCurrentByAddress(
    spaceId: SpaceId,
    address: string,
  ): Promise<Output | undefined>;
  list(query?: OutputQuery): Promise<readonly Output[]>;
}

export interface OutputConsumerBindingStore {
  put(binding: OutputConsumerBinding): Promise<OutputConsumerBinding>;
  get(id: string): Promise<OutputConsumerBinding | undefined>;
  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly OutputConsumerBinding[]>;
  listByOutputAddress(
    spaceId: SpaceId,
    outputAddress: string,
  ): Promise<readonly OutputConsumerBinding[]>;
}

export interface OutputGrantStore {
  put(grant: OutputGrant): Promise<OutputGrant>;
  get(ref: string): Promise<OutputGrant | undefined>;
  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly OutputGrant[]>;
}

export interface OutputProjectionStore {
  put(projection: OutputProjection): Promise<OutputProjection>;
  get(id: OutputProjectionId): Promise<OutputProjection | undefined>;
  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly OutputProjection[]>;
  listByOutput(
    outputId: OutputId,
  ): Promise<readonly OutputProjection[]>;
}

export interface CoreOutputResolutionStore {
  put(
    resolution: CoreOutputResolution,
  ): Promise<CoreOutputResolution>;
  get(
    id: CoreOutputResolutionId,
  ): Promise<CoreOutputResolution | undefined>;
  listByBinding(
    bindingId: string,
  ): Promise<readonly CoreOutputResolution[]>;
  listByOutput(
    outputId: OutputId,
  ): Promise<readonly CoreOutputResolution[]>;
}

export class InMemoryOutputStore implements OutputStore {
  readonly #outputs = new Map<OutputId, Output>();

  put(output: Output): Promise<Output> {
    const frozen = deepFreeze(structuredClone(output));
    this.#outputs.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: OutputId): Promise<Output | undefined> {
    return Promise.resolve(this.#outputs.get(id));
  }

  findCurrentByAddress(
    spaceId: SpaceId,
    address: string,
  ): Promise<Output | undefined> {
    const matches = [...this.#outputs.values()]
      .filter((output) =>
        output.spaceId === spaceId && output.address === address &&
        !output.withdrawnAt
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Promise.resolve(matches[0]);
  }

  list(query: OutputQuery = {}): Promise<readonly Output[]> {
    return Promise.resolve(
      [...this.#outputs.values()].filter((output) =>
        matchesOutput(output, query)
      ),
    );
  }
}

export class InMemoryOutputConsumerBindingStore
  implements OutputConsumerBindingStore {
  readonly #bindings = new Map<string, OutputConsumerBinding>();

  put(
    binding: OutputConsumerBinding,
  ): Promise<OutputConsumerBinding> {
    const frozen = deepFreeze(structuredClone(binding));
    this.#bindings.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: string): Promise<OutputConsumerBinding | undefined> {
    return Promise.resolve(this.#bindings.get(id));
  }

  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly OutputConsumerBinding[]> {
    return Promise.resolve(
      [...this.#bindings.values()].filter((binding) =>
        binding.spaceId === spaceId &&
        binding.consumerGroupId === consumerGroupId
      ),
    );
  }

  listByOutputAddress(
    spaceId: SpaceId,
    outputAddress: string,
  ): Promise<readonly OutputConsumerBinding[]> {
    return Promise.resolve(
      [...this.#bindings.values()].filter((binding) =>
        binding.spaceId === spaceId &&
        binding.outputAddress === outputAddress
      ),
    );
  }
}

export class InMemoryOutputGrantStore implements OutputGrantStore {
  readonly #grants = new Map<string, OutputGrant>();

  put(grant: OutputGrant): Promise<OutputGrant> {
    const frozen = deepFreeze(structuredClone(grant));
    this.#grants.set(frozen.ref, frozen);
    return Promise.resolve(frozen);
  }

  get(ref: string): Promise<OutputGrant | undefined> {
    return Promise.resolve(this.#grants.get(ref));
  }

  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly OutputGrant[]> {
    return Promise.resolve(
      [...this.#grants.values()].filter((grant) =>
        grant.spaceId === spaceId &&
        grant.consumerGroupId === consumerGroupId
      ),
    );
  }
}

export class InMemoryOutputProjectionStore implements OutputProjectionStore {
  readonly #projections = new Map<
    OutputProjectionId,
    OutputProjection
  >();

  put(projection: OutputProjection): Promise<OutputProjection> {
    const frozen = deepFreeze(structuredClone(projection));
    this.#projections.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: OutputProjectionId): Promise<OutputProjection | undefined> {
    return Promise.resolve(this.#projections.get(id));
  }

  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly OutputProjection[]> {
    return Promise.resolve(
      [...this.#projections.values()].filter((projection) =>
        projection.spaceId === spaceId &&
        projection.consumerGroupId === consumerGroupId
      ),
    );
  }

  listByOutput(
    outputId: OutputId,
  ): Promise<readonly OutputProjection[]> {
    return Promise.resolve(
      [...this.#projections.values()].filter((projection) =>
        projection.outputId === outputId
      ),
    );
  }
}

export class InMemoryCoreOutputResolutionStore
  implements CoreOutputResolutionStore {
  readonly #resolutions = new Map<
    CoreOutputResolutionId,
    CoreOutputResolution
  >();

  put(
    resolution: CoreOutputResolution,
  ): Promise<CoreOutputResolution> {
    const frozen = deepFreeze(structuredClone(resolution));
    this.#resolutions.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(
    id: CoreOutputResolutionId,
  ): Promise<CoreOutputResolution | undefined> {
    return Promise.resolve(this.#resolutions.get(id));
  }

  listByBinding(
    bindingId: string,
  ): Promise<readonly CoreOutputResolution[]> {
    return Promise.resolve(
      [...this.#resolutions.values()].filter((resolution) =>
        resolution.bindingId === bindingId
      ),
    );
  }

  listByOutput(
    outputId: OutputId,
  ): Promise<readonly CoreOutputResolution[]> {
    return Promise.resolve(
      [...this.#resolutions.values()].filter((resolution) =>
        resolution.outputId === outputId
      ),
    );
  }
}

function matchesOutput(
  output: Output,
  query: OutputQuery,
): boolean {
  if (query.spaceId && output.spaceId !== query.spaceId) return false;
  if (
    query.producerGroupId &&
    output.producerGroupId !== query.producerGroupId
  ) return false;
  if (query.address && output.address !== query.address) return false;
  if (!query.includeWithdrawn && output.withdrawnAt) return false;
  return true;
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
