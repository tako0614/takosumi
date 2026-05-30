import type {
  BindingSetRevision,
  BindingSetRevisionId,
  GroupId,
  MigrationLedgerEntry,
  MigrationLedgerId,
  ResourceBinding,
  ResourceBindingId,
  ResourceInstance,
  ResourceInstanceId,
  SpaceId,
} from "./types.ts";

export interface ResourceInstanceStore {
  create(instance: ResourceInstance): Promise<ResourceInstance>;
  get(id: ResourceInstanceId): Promise<ResourceInstance | undefined>;
  listBySpace(spaceId: SpaceId): Promise<readonly ResourceInstance[]>;
  listByGroup(groupId: GroupId): Promise<readonly ResourceInstance[]>;
  update(instance: ResourceInstance): Promise<ResourceInstance>;
}

export interface ResourceBindingStore {
  create(binding: ResourceBinding): Promise<ResourceBinding>;
  get(id: ResourceBindingId): Promise<ResourceBinding | undefined>;
  findByClaim(
    groupId: GroupId,
    claimAddress: string,
  ): Promise<ResourceBinding | undefined>;
  listByGroup(groupId: GroupId): Promise<readonly ResourceBinding[]>;
  listByInstance(
    instanceId: ResourceInstanceId,
  ): Promise<readonly ResourceBinding[]>;
}

export interface BindingSetRevisionStore {
  create(revision: BindingSetRevision): Promise<BindingSetRevision>;
  get(id: BindingSetRevisionId): Promise<BindingSetRevision | undefined>;
  listByGroup(groupId: GroupId): Promise<readonly BindingSetRevision[]>;
}

export interface MigrationLedgerStore {
  append(entry: MigrationLedgerEntry): Promise<MigrationLedgerEntry>;
  get(id: MigrationLedgerId): Promise<MigrationLedgerEntry | undefined>;
  listByResource(
    instanceId: ResourceInstanceId,
  ): Promise<readonly MigrationLedgerEntry[]>;
}

export class InMemoryResourceInstanceStore implements ResourceInstanceStore {
  readonly #instances = new Map<ResourceInstanceId, ResourceInstance>();

  create(instance: ResourceInstance): Promise<ResourceInstance> {
    const existing = this.#instances.get(instance.id);
    if (existing) return Promise.resolve(existing);
    this.#instances.set(instance.id, instance);
    return Promise.resolve(instance);
  }

  get(id: ResourceInstanceId): Promise<ResourceInstance | undefined> {
    return Promise.resolve(this.#instances.get(id));
  }

  listBySpace(spaceId: SpaceId): Promise<readonly ResourceInstance[]> {
    return Promise.resolve(
      [...this.#instances.values()].filter((instance) =>
        instance.spaceId === spaceId
      ),
    );
  }

  listByGroup(groupId: GroupId): Promise<readonly ResourceInstance[]> {
    return Promise.resolve(
      [...this.#instances.values()].filter((instance) =>
        instance.groupId === groupId
      ),
    );
  }

  update(instance: ResourceInstance): Promise<ResourceInstance> {
    this.#instances.set(instance.id, instance);
    return Promise.resolve(instance);
  }
}

export class InMemoryResourceBindingStore implements ResourceBindingStore {
  readonly #bindings = new Map<ResourceBindingId, ResourceBinding>();

  create(binding: ResourceBinding): Promise<ResourceBinding> {
    const existing = this.#bindings.get(binding.id);
    if (existing) return Promise.resolve(existing);
    this.#bindings.set(binding.id, binding);
    return Promise.resolve(binding);
  }

  get(id: ResourceBindingId): Promise<ResourceBinding | undefined> {
    return Promise.resolve(this.#bindings.get(id));
  }

  findByClaim(
    groupId: GroupId,
    claimAddress: string,
  ): Promise<ResourceBinding | undefined> {
    for (const binding of this.#bindings.values()) {
      if (
        binding.groupId === groupId && binding.claimAddress === claimAddress
      ) return Promise.resolve(binding);
    }
    return Promise.resolve(undefined);
  }

  listByGroup(groupId: GroupId): Promise<readonly ResourceBinding[]> {
    return Promise.resolve(
      [...this.#bindings.values()].filter((binding) =>
        binding.groupId === groupId
      ),
    );
  }

  listByInstance(
    instanceId: ResourceInstanceId,
  ): Promise<readonly ResourceBinding[]> {
    return Promise.resolve(
      [...this.#bindings.values()].filter((binding) =>
        binding.instanceId === instanceId
      ),
    );
  }
}

export class InMemoryBindingSetRevisionStore
  implements BindingSetRevisionStore {
  readonly #revisions = new Map<BindingSetRevisionId, BindingSetRevision>();

  create(revision: BindingSetRevision): Promise<BindingSetRevision> {
    const existing = this.#revisions.get(revision.id);
    if (existing) return Promise.resolve(existing);
    this.#revisions.set(revision.id, revision);
    return Promise.resolve(revision);
  }

  get(id: BindingSetRevisionId): Promise<BindingSetRevision | undefined> {
    return Promise.resolve(this.#revisions.get(id));
  }

  listByGroup(groupId: GroupId): Promise<readonly BindingSetRevision[]> {
    return Promise.resolve(
      [...this.#revisions.values()].filter((revision) =>
        revision.groupId === groupId
      ),
    );
  }
}

export class InMemoryMigrationLedgerStore implements MigrationLedgerStore {
  readonly #entries = new Map<MigrationLedgerId, MigrationLedgerEntry>();

  append(entry: MigrationLedgerEntry): Promise<MigrationLedgerEntry> {
    const existing = this.#entries.get(entry.id);
    if (existing) return Promise.resolve(existing);
    this.#entries.set(entry.id, entry);
    return Promise.resolve(entry);
  }

  get(id: MigrationLedgerId): Promise<MigrationLedgerEntry | undefined> {
    return Promise.resolve(this.#entries.get(id));
  }

  listByResource(
    instanceId: ResourceInstanceId,
  ): Promise<readonly MigrationLedgerEntry[]> {
    return Promise.resolve(
      [...this.#entries.values()].filter((entry) =>
        entry.resourceInstanceId === instanceId
      ),
    );
  }
}
