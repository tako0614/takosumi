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
import { createIfAbsent, filterValues, getFrom, putValue } from "./helpers.ts";

export class MemoryResourceInstanceStore implements ResourceInstanceStore {
  constructor(
    private readonly instances: Map<ResourceInstanceId, ResourceInstance>,
  ) {}

  create(instance: ResourceInstance): Promise<ResourceInstance> {
    return createIfAbsent(this.instances, instance.id, instance);
  }

  get(id: ResourceInstanceId): Promise<ResourceInstance | undefined> {
    return getFrom(this.instances, id);
  }

  listBySpace(spaceId: string): Promise<readonly ResourceInstance[]> {
    return filterValues(
      this.instances,
      (instance) => instance.spaceId === spaceId,
    );
  }

  listByGroup(groupId: GroupId): Promise<readonly ResourceInstance[]> {
    return filterValues(
      this.instances,
      (instance) => instance.groupId === groupId,
    );
  }

  update(instance: ResourceInstance): Promise<ResourceInstance> {
    return putValue(this.instances, instance.id, instance);
  }
}

export class MemoryResourceBindingStore implements ResourceBindingStore {
  constructor(
    private readonly bindings: Map<ResourceBindingId, ResourceBinding>,
  ) {}

  create(binding: ResourceBinding): Promise<ResourceBinding> {
    return createIfAbsent(this.bindings, binding.id, binding);
  }

  get(id: ResourceBindingId): Promise<ResourceBinding | undefined> {
    return getFrom(this.bindings, id);
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
    return filterValues(this.bindings, (binding) => binding.groupId === groupId);
  }

  listByInstance(
    instanceId: ResourceInstanceId,
  ): Promise<readonly ResourceBinding[]> {
    return filterValues(
      this.bindings,
      (binding) => binding.instanceId === instanceId,
    );
  }
}

export class MemoryBindingSetRevisionStore implements BindingSetRevisionStore {
  constructor(
    private readonly revisions: Map<BindingSetRevisionId, BindingSetRevision>,
  ) {}

  create(revision: BindingSetRevision): Promise<BindingSetRevision> {
    return createIfAbsent(this.revisions, revision.id, revision);
  }

  get(id: BindingSetRevisionId): Promise<BindingSetRevision | undefined> {
    return getFrom(this.revisions, id);
  }

  listByGroup(groupId: GroupId): Promise<readonly BindingSetRevision[]> {
    return filterValues(
      this.revisions,
      (revision) => revision.groupId === groupId,
    );
  }
}

export class MemoryMigrationLedgerStore implements MigrationLedgerStore {
  constructor(
    private readonly entries: Map<MigrationLedgerId, MigrationLedgerEntry>,
  ) {}

  append(entry: MigrationLedgerEntry): Promise<MigrationLedgerEntry> {
    return createIfAbsent(this.entries, entry.id, entry);
  }

  get(id: MigrationLedgerId): Promise<MigrationLedgerEntry | undefined> {
    return getFrom(this.entries, id);
  }

  listByResource(
    instanceId: ResourceInstanceId,
  ): Promise<readonly MigrationLedgerEntry[]> {
    return filterValues(
      this.entries,
      (entry) => entry.resourceInstanceId === instanceId,
    );
  }
}
