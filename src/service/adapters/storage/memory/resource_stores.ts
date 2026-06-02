// In-memory implementations of the resource domain stores:
//   - MemoryResourceInstanceStore
//   - MemoryResourceBindingStore
//   - MemoryBindingSetRevisionStore
//   - MemoryMigrationLedgerStore

import type {
  BindingSetRevisionStore,
  MigrationLedgerStore,
  ResourceBindingStore,
  ResourceInstanceStore,
} from "../../../domains/resources/stores.ts";
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
} from "../../../domains/resources/types.ts";
import { immutable } from "./helpers.ts";

export class MemoryResourceInstanceStore implements ResourceInstanceStore {
  constructor(
    private readonly instances: Map<ResourceInstanceId, ResourceInstance>,
  ) {}

  create(instance: ResourceInstance): Promise<ResourceInstance> {
    const existing = this.instances.get(instance.id);
    if (existing) return Promise.resolve(existing);
    const value = immutable(instance);
    this.instances.set(instance.id, value);
    return Promise.resolve(value);
  }

  get(id: ResourceInstanceId): Promise<ResourceInstance | undefined> {
    return Promise.resolve(this.instances.get(id));
  }

  listBySpace(spaceId: string): Promise<readonly ResourceInstance[]> {
    return Promise.resolve(
      [...this.instances.values()].filter((instance) =>
        instance.spaceId === spaceId
      ),
    );
  }

  listByGroup(groupId: GroupId): Promise<readonly ResourceInstance[]> {
    return Promise.resolve(
      [...this.instances.values()].filter((instance) =>
        instance.groupId === groupId
      ),
    );
  }

  update(instance: ResourceInstance): Promise<ResourceInstance> {
    const value = immutable(instance);
    this.instances.set(instance.id, value);
    return Promise.resolve(value);
  }
}

export class MemoryResourceBindingStore implements ResourceBindingStore {
  constructor(
    private readonly bindings: Map<ResourceBindingId, ResourceBinding>,
  ) {}

  create(binding: ResourceBinding): Promise<ResourceBinding> {
    const existing = this.bindings.get(binding.id);
    if (existing) return Promise.resolve(existing);
    const value = immutable(binding);
    this.bindings.set(binding.id, value);
    return Promise.resolve(value);
  }

  get(id: ResourceBindingId): Promise<ResourceBinding | undefined> {
    return Promise.resolve(this.bindings.get(id));
  }

  findByClaim(
    groupId: GroupId,
    claimAddress: string,
  ): Promise<ResourceBinding | undefined> {
    for (const binding of this.bindings.values()) {
      if (
        binding.groupId === groupId && binding.claimAddress === claimAddress
      ) {
        return Promise.resolve(binding);
      }
    }
    return Promise.resolve(undefined);
  }

  listByGroup(groupId: GroupId): Promise<readonly ResourceBinding[]> {
    return Promise.resolve(
      [...this.bindings.values()].filter((binding) =>
        binding.groupId === groupId
      ),
    );
  }

  listByInstance(
    instanceId: ResourceInstanceId,
  ): Promise<readonly ResourceBinding[]> {
    return Promise.resolve(
      [...this.bindings.values()].filter((binding) =>
        binding.instanceId === instanceId
      ),
    );
  }
}

export class MemoryBindingSetRevisionStore implements BindingSetRevisionStore {
  constructor(
    private readonly revisions: Map<BindingSetRevisionId, BindingSetRevision>,
  ) {}

  create(revision: BindingSetRevision): Promise<BindingSetRevision> {
    const existing = this.revisions.get(revision.id);
    if (existing) return Promise.resolve(existing);
    const value = immutable(revision);
    this.revisions.set(revision.id, value);
    return Promise.resolve(value);
  }

  get(id: BindingSetRevisionId): Promise<BindingSetRevision | undefined> {
    return Promise.resolve(this.revisions.get(id));
  }

  listByGroup(groupId: GroupId): Promise<readonly BindingSetRevision[]> {
    return Promise.resolve(
      [...this.revisions.values()].filter((revision) =>
        revision.groupId === groupId
      ),
    );
  }
}

export class MemoryMigrationLedgerStore implements MigrationLedgerStore {
  constructor(
    private readonly entries: Map<MigrationLedgerId, MigrationLedgerEntry>,
  ) {}

  append(entry: MigrationLedgerEntry): Promise<MigrationLedgerEntry> {
    const existing = this.entries.get(entry.id);
    if (existing) return Promise.resolve(existing);
    const value = immutable(entry);
    this.entries.set(entry.id, value);
    return Promise.resolve(value);
  }

  get(id: MigrationLedgerId): Promise<MigrationLedgerEntry | undefined> {
    return Promise.resolve(this.entries.get(id));
  }

  listByResource(
    instanceId: ResourceInstanceId,
  ): Promise<readonly MigrationLedgerEntry[]> {
    return Promise.resolve(
      [...this.entries.values()].filter((entry) =>
        entry.resourceInstanceId === instanceId
      ),
    );
  }
}
