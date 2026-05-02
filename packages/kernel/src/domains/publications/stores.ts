import type {
  CorePublicationResolution,
  CorePublicationResolutionId,
  GroupId,
  Publication,
  PublicationConsumerBinding,
  PublicationGrant,
  PublicationId,
  PublicationProjection,
  PublicationProjectionId,
  PublicationQuery,
  SpaceId,
} from "./types.ts";

export interface PublicationStore {
  put(publication: Publication): Promise<Publication>;
  get(id: PublicationId): Promise<Publication | undefined>;
  findCurrentByAddress(
    spaceId: SpaceId,
    address: string,
  ): Promise<Publication | undefined>;
  list(query?: PublicationQuery): Promise<readonly Publication[]>;
}

export interface PublicationConsumerBindingStore {
  put(binding: PublicationConsumerBinding): Promise<PublicationConsumerBinding>;
  get(id: string): Promise<PublicationConsumerBinding | undefined>;
  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly PublicationConsumerBinding[]>;
  listByPublicationAddress(
    spaceId: SpaceId,
    publicationAddress: string,
  ): Promise<readonly PublicationConsumerBinding[]>;
}

export interface PublicationGrantStore {
  put(grant: PublicationGrant): Promise<PublicationGrant>;
  get(ref: string): Promise<PublicationGrant | undefined>;
  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly PublicationGrant[]>;
}

export interface PublicationProjectionStore {
  put(projection: PublicationProjection): Promise<PublicationProjection>;
  get(id: PublicationProjectionId): Promise<PublicationProjection | undefined>;
  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly PublicationProjection[]>;
  listByPublication(
    publicationId: PublicationId,
  ): Promise<readonly PublicationProjection[]>;
}

export interface CorePublicationResolutionStore {
  put(
    resolution: CorePublicationResolution,
  ): Promise<CorePublicationResolution>;
  get(
    id: CorePublicationResolutionId,
  ): Promise<CorePublicationResolution | undefined>;
  listByBinding(
    bindingId: string,
  ): Promise<readonly CorePublicationResolution[]>;
  listByPublication(
    publicationId: PublicationId,
  ): Promise<readonly CorePublicationResolution[]>;
}

export class InMemoryPublicationStore implements PublicationStore {
  readonly #publications = new Map<PublicationId, Publication>();

  put(publication: Publication): Promise<Publication> {
    const frozen = deepFreeze(structuredClone(publication));
    this.#publications.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: PublicationId): Promise<Publication | undefined> {
    return Promise.resolve(this.#publications.get(id));
  }

  findCurrentByAddress(
    spaceId: SpaceId,
    address: string,
  ): Promise<Publication | undefined> {
    const matches = [...this.#publications.values()]
      .filter((publication) =>
        publication.spaceId === spaceId && publication.address === address &&
        !publication.withdrawnAt
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Promise.resolve(matches[0]);
  }

  list(query: PublicationQuery = {}): Promise<readonly Publication[]> {
    return Promise.resolve(
      [...this.#publications.values()].filter((publication) =>
        matchesPublication(publication, query)
      ),
    );
  }
}

export class InMemoryPublicationConsumerBindingStore
  implements PublicationConsumerBindingStore {
  readonly #bindings = new Map<string, PublicationConsumerBinding>();

  put(
    binding: PublicationConsumerBinding,
  ): Promise<PublicationConsumerBinding> {
    const frozen = deepFreeze(structuredClone(binding));
    this.#bindings.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: string): Promise<PublicationConsumerBinding | undefined> {
    return Promise.resolve(this.#bindings.get(id));
  }

  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly PublicationConsumerBinding[]> {
    return Promise.resolve(
      [...this.#bindings.values()].filter((binding) =>
        binding.spaceId === spaceId &&
        binding.consumerGroupId === consumerGroupId
      ),
    );
  }

  listByPublicationAddress(
    spaceId: SpaceId,
    publicationAddress: string,
  ): Promise<readonly PublicationConsumerBinding[]> {
    return Promise.resolve(
      [...this.#bindings.values()].filter((binding) =>
        binding.spaceId === spaceId &&
        binding.publicationAddress === publicationAddress
      ),
    );
  }
}

export class InMemoryPublicationGrantStore implements PublicationGrantStore {
  readonly #grants = new Map<string, PublicationGrant>();

  put(grant: PublicationGrant): Promise<PublicationGrant> {
    const frozen = deepFreeze(structuredClone(grant));
    this.#grants.set(frozen.ref, frozen);
    return Promise.resolve(frozen);
  }

  get(ref: string): Promise<PublicationGrant | undefined> {
    return Promise.resolve(this.#grants.get(ref));
  }

  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly PublicationGrant[]> {
    return Promise.resolve(
      [...this.#grants.values()].filter((grant) =>
        grant.spaceId === spaceId &&
        grant.consumerGroupId === consumerGroupId
      ),
    );
  }
}

export class InMemoryPublicationProjectionStore
  implements PublicationProjectionStore {
  readonly #projections = new Map<
    PublicationProjectionId,
    PublicationProjection
  >();

  put(projection: PublicationProjection): Promise<PublicationProjection> {
    const frozen = deepFreeze(structuredClone(projection));
    this.#projections.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: PublicationProjectionId): Promise<PublicationProjection | undefined> {
    return Promise.resolve(this.#projections.get(id));
  }

  listByConsumer(
    spaceId: SpaceId,
    consumerGroupId: GroupId,
  ): Promise<readonly PublicationProjection[]> {
    return Promise.resolve(
      [...this.#projections.values()].filter((projection) =>
        projection.spaceId === spaceId &&
        projection.consumerGroupId === consumerGroupId
      ),
    );
  }

  listByPublication(
    publicationId: PublicationId,
  ): Promise<readonly PublicationProjection[]> {
    return Promise.resolve(
      [...this.#projections.values()].filter((projection) =>
        projection.publicationId === publicationId
      ),
    );
  }
}

export class InMemoryCorePublicationResolutionStore
  implements CorePublicationResolutionStore {
  readonly #resolutions = new Map<
    CorePublicationResolutionId,
    CorePublicationResolution
  >();

  put(
    resolution: CorePublicationResolution,
  ): Promise<CorePublicationResolution> {
    const frozen = deepFreeze(structuredClone(resolution));
    this.#resolutions.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(
    id: CorePublicationResolutionId,
  ): Promise<CorePublicationResolution | undefined> {
    return Promise.resolve(this.#resolutions.get(id));
  }

  listByBinding(
    bindingId: string,
  ): Promise<readonly CorePublicationResolution[]> {
    return Promise.resolve(
      [...this.#resolutions.values()].filter((resolution) =>
        resolution.bindingId === bindingId
      ),
    );
  }

  listByPublication(
    publicationId: PublicationId,
  ): Promise<readonly CorePublicationResolution[]> {
    return Promise.resolve(
      [...this.#resolutions.values()].filter((resolution) =>
        resolution.publicationId === publicationId
      ),
    );
  }
}

function matchesPublication(
  publication: Publication,
  query: PublicationQuery,
): boolean {
  if (query.spaceId && publication.spaceId !== query.spaceId) return false;
  if (
    query.producerGroupId &&
    publication.producerGroupId !== query.producerGroupId
  ) return false;
  if (query.address && publication.address !== query.address) return false;
  if (!query.includeWithdrawn && publication.withdrawnAt) return false;
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
