import type { AuditStore } from "../../domains/audit/store.ts";
import type {
  Deployment,
  GroupHead,
  ProviderObservation as CoreProviderObservation,
} from "takosumi-contract";
import type {
  AuditEvent,
  AuditEventId,
  AuditEventQuery,
} from "../../domains/audit/types.ts";
import type {
  AdvanceGroupHeadInput,
  CommitAppliedDeploymentInput,
  CommitAppliedDeploymentResult,
  DeploymentFilter,
  DeploymentStore,
  GroupHeadRef,
} from "../../domains/deploy/store.ts";
import type {
  BindingSetRevisionStore,
  MigrationLedgerStore,
  ResourceBindingStore,
  ResourceInstanceStore,
} from "../../domains/resources/stores.ts";
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
} from "../../domains/resources/types.ts";
import type {
  ProviderObservationStore,
  RuntimeDesiredStateStore,
  RuntimeObservedStateStore,
} from "../../domains/runtime/stores.ts";
import type {
  ProviderObservation,
  RuntimeDesiredState,
  RuntimeDesiredStateId,
  RuntimeObservedStateId,
  RuntimeObservedStateSnapshot,
} from "../../domains/runtime/types.ts";
import type {
  BundledRegistry,
  PackageDescriptorStore,
  PackageResolutionStore,
  TrustRecordStore,
} from "../../domains/registry/stores.ts";
import type {
  PackageDescriptor,
  PackageKind,
  PackageResolution,
  ProviderSupportReport,
  TrustRecord,
} from "../../domains/registry/types.ts";
import type {
  ServiceEndpointHealthUpdate,
  ServiceEndpointStore,
  ServiceGrantStore,
  ServiceTrustRecordStore,
  ServiceTrustRevokeInput,
} from "../../domains/service-endpoints/stores.ts";
import type {
  ServiceEndpoint,
  ServiceEndpointHealth,
  ServiceEndpointId,
  ServiceGrant,
  ServiceGrantId,
  ServiceId,
  ServiceTrustRecord,
  ServiceTrustRecordId,
} from "../../domains/service-endpoints/types.ts";
import {
  aggregateKeyForEvent,
  encodeAggregateId,
  type UsageAggregateStore,
} from "../../services/usage/store.ts";
import type {
  UsageAggregate,
  UsageAggregateKey,
  UsageEventDto,
} from "../../services/usage/types.ts";
import type {
  RuntimeAgentId,
  RuntimeAgentRecord,
  RuntimeAgentWorkId,
  RuntimeAgentWorkItem,
  WorkLedger,
  WorkLedgerMutation,
  WorkLedgerSnapshot,
} from "../../agents/mod.ts";
import type {
  CoreStorageStores,
  ResourceStorageStores,
  RuntimeStorageStores,
  ServiceEndpointStorageStores,
  StorageDriver,
  StorageTransaction,
  UsageStorageStores,
} from "./driver.ts";
import { storageStatementCatalog } from "./statements.ts";
import {
  assertDeploymentHeadScope,
  groupHeadKey,
  immutable,
  matchesAuditQuery,
  maxIso,
  minIso,
  normalizeDeploymentStatusFilter,
  packageKey,
} from "./memory/helpers.ts";
import {
  cloneState,
  createEmptyState,
  type MemoryDeployState,
  type MemoryStorageSnapshot,
  type MemoryStorageState,
  snapshotState,
} from "./memory/state.ts";
import {
  MemoryGroupStore,
  MemorySpaceMembershipStore,
  MemorySpaceStore,
} from "./memory/core_stores.ts";
import { MemoryDeploymentStore } from "./memory/deploy_store.ts";

export type { MemoryStorageSnapshot };

export interface MemoryStorageDriverOptions {
  readonly providerSupportReports?: readonly ProviderSupportReport[];
}

export class MemoryStorageDriver implements StorageDriver {
  readonly statements = storageStatementCatalog;
  #state: MemoryStorageState;
  #transactionTail: Promise<void> = Promise.resolve();

  constructor(options: MemoryStorageDriverOptions = {}) {
    this.#state = createEmptyState(options.providerSupportReports ?? []);
  }

  async transaction<T>(
    fn: (transaction: StorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    const previous = this.#transactionTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#transactionTail = previous.then(() => gate, () => gate);
    await previous;

    const working = cloneState(this.#state);
    const transaction = new MemoryStorageTransaction(working);
    try {
      const result = await fn(transaction);
      this.#state = working;
      return result;
    } catch (error) {
      throw error;
    } finally {
      release();
    }
  }

  snapshot(): MemoryStorageSnapshot {
    return snapshotState(this.#state);
  }
}

class MemoryStorageTransaction implements StorageTransaction {
  readonly core: CoreStorageStores;
  readonly deploy: { readonly deploys: DeploymentStore };
  readonly runtime: RuntimeStorageStores;
  readonly resources: ResourceStorageStores;
  readonly registry: {
    readonly descriptors: PackageDescriptorStore;
    readonly resolutions: PackageResolutionStore;
    readonly trustRecords: TrustRecordStore;
    readonly bundledRegistry: BundledRegistry;
  };
  readonly audit: { readonly events: AuditStore };
  readonly usage: UsageStorageStores;
  readonly serviceEndpoints: ServiceEndpointStorageStores;
  readonly runtimeAgent: WorkLedger;

  constructor(state: MemoryStorageState) {
    const descriptors = new MemoryPackageDescriptorStore(
      state.registry.descriptors,
    );
    const resolutions = new MemoryPackageResolutionStore(
      state.registry.resolutions,
    );
    const trustRecords = new MemoryTrustRecordStore(
      state.registry.trustRecords,
    );

    this.core = {
      spaces: new MemorySpaceStore(state.core.spaces),
      groups: new MemoryGroupStore(state.core.groups),
      spaceMemberships: new MemorySpaceMembershipStore(
        state.core.spaceMemberships,
      ),
    };
    this.deploy = {
      deploys: new MemoryDeploymentStore(state.deploy),
    };
    this.runtime = {
      desiredStates: new MemoryRuntimeDesiredStateStore(
        state.runtime.desiredStates,
      ),
      observedStates: new MemoryRuntimeObservedStateStore(
        state.runtime.observedStates,
      ),
      providerObservations: new MemoryProviderObservationStore(
        state.runtime.providerObservations,
      ),
    };
    this.resources = {
      instances: new MemoryResourceInstanceStore(state.resources.instances),
      bindings: new MemoryResourceBindingStore(state.resources.bindings),
      bindingSetRevisions: new MemoryBindingSetRevisionStore(
        state.resources.bindingSetRevisions,
      ),
      migrationLedger: new MemoryMigrationLedgerStore(
        state.resources.migrationLedger,
      ),
    };
    this.registry = {
      descriptors,
      resolutions,
      trustRecords,
      bundledRegistry: new MemoryBundledRegistry(
        descriptors,
        resolutions,
        trustRecords,
        state.registry.providerSupportReports,
      ),
    };
    this.audit = {
      events: new MemoryAuditStore(state.audit.events, state.audit.order),
    };
    this.usage = {
      aggregates: new MemoryUsageAggregateStore(state.usage.aggregates),
    };
    this.serviceEndpoints = {
      endpoints: new MemoryServiceEndpointStore(
        state.serviceEndpoints.endpoints,
      ),
      trustRecords: new MemoryServiceTrustRecordStore(
        state.serviceEndpoints.trustRecords,
      ),
      grants: new MemoryServiceGrantStore(state.serviceEndpoints.grants),
    };
    this.runtimeAgent = new MemoryRuntimeAgentLedgerStore(
      state.runtimeAgent.agents,
      state.runtimeAgent.works,
    );
  }
}

class MemoryRuntimeAgentLedgerStore implements WorkLedger {
  constructor(
    private readonly agents: Map<RuntimeAgentId, RuntimeAgentRecord>,
    private readonly works: Map<RuntimeAgentWorkId, RuntimeAgentWorkItem>,
  ) {}

  snapshot(): Promise<WorkLedgerSnapshot> {
    return Promise.resolve(immutable({
      agents: [...this.agents.values()],
      works: [...this.works.values()],
    }));
  }

  apply(mutation: WorkLedgerMutation): Promise<void> {
    if (mutation.agent) {
      this.agents.set(mutation.agent.id, immutable(mutation.agent));
    }
    for (const work of mutation.works) {
      this.works.set(work.id, immutable(work));
    }
    for (const removed of mutation.removedWorkIds ?? []) {
      this.works.delete(removed);
    }
    for (const removed of mutation.removedAgentIds ?? []) {
      this.agents.delete(removed);
    }
    return Promise.resolve();
  }
}

class MemoryRuntimeDesiredStateStore implements RuntimeDesiredStateStore {
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

class MemoryRuntimeObservedStateStore implements RuntimeObservedStateStore {
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

class MemoryProviderObservationStore implements ProviderObservationStore {
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

class MemoryResourceInstanceStore implements ResourceInstanceStore {
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

class MemoryResourceBindingStore implements ResourceBindingStore {
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

class MemoryBindingSetRevisionStore implements BindingSetRevisionStore {
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

class MemoryMigrationLedgerStore implements MigrationLedgerStore {
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

class MemoryPackageDescriptorStore implements PackageDescriptorStore {
  constructor(private readonly descriptors: Map<string, PackageDescriptor>) {}

  put(descriptor: PackageDescriptor): Promise<PackageDescriptor> {
    const value = immutable(descriptor);
    this.descriptors.set(
      packageKey(descriptor.kind, descriptor.ref, descriptor.digest),
      value,
    );
    return Promise.resolve(value);
  }

  get(
    kind: PackageKind,
    ref: string,
    digest: string,
  ): Promise<PackageDescriptor | undefined> {
    return Promise.resolve(this.descriptors.get(packageKey(kind, ref, digest)));
  }

  listByRef(
    kind: PackageKind,
    ref: string,
  ): Promise<readonly PackageDescriptor[]> {
    return Promise.resolve(
      [...this.descriptors.values()].filter((descriptor) =>
        descriptor.kind === kind && descriptor.ref === ref
      ),
    );
  }
}

class MemoryPackageResolutionStore implements PackageResolutionStore {
  constructor(private readonly resolutions: Map<string, PackageResolution>) {}

  record(resolution: PackageResolution): Promise<PackageResolution> {
    const value = immutable(resolution);
    this.resolutions.set(
      packageKey(resolution.kind, resolution.ref, resolution.digest),
      value,
    );
    return Promise.resolve(value);
  }

  get(
    kind: PackageKind,
    ref: string,
    digest: string,
  ): Promise<PackageResolution | undefined> {
    return Promise.resolve(this.resolutions.get(packageKey(kind, ref, digest)));
  }

  listByRef(
    kind: PackageKind,
    ref: string,
  ): Promise<readonly PackageResolution[]> {
    return Promise.resolve(
      [...this.resolutions.values()].filter((resolution) =>
        resolution.kind === kind && resolution.ref === ref
      ),
    );
  }
}

class MemoryTrustRecordStore implements TrustRecordStore {
  constructor(private readonly records: Map<string, TrustRecord>) {}

  put(record: TrustRecord): Promise<TrustRecord> {
    const value = immutable(record);
    this.records.set(record.id, value);
    return Promise.resolve(value);
  }

  get(id: string): Promise<TrustRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  findForPackage(
    kind: PackageKind,
    ref: string,
    digest: string,
  ): Promise<TrustRecord | undefined> {
    for (const record of this.records.values()) {
      if (
        record.packageKind === kind && record.packageRef === ref &&
        record.packageDigest === digest
      ) return Promise.resolve(record);
    }
    return Promise.resolve(undefined);
  }
}

class MemoryBundledRegistry implements BundledRegistry {
  constructor(
    private readonly descriptors: PackageDescriptorStore,
    private readonly resolutions: PackageResolutionStore,
    private readonly trustRecords: TrustRecordStore,
    private readonly providerSupportReports: readonly ProviderSupportReport[],
  ) {}

  async resolve(
    kind: PackageKind,
    ref: string,
  ): Promise<PackageResolution | undefined> {
    const descriptors = await this.descriptors.listByRef(kind, ref);
    const descriptor = descriptors[descriptors.length - 1];
    if (!descriptor) return undefined;
    return await this.resolutions.get(kind, ref, descriptor.digest);
  }

  getDescriptor(
    kind: PackageKind,
    ref: string,
    digest: string,
  ): Promise<PackageDescriptor | undefined> {
    return this.descriptors.get(kind, ref, digest);
  }

  getTrustRecord(id: string): Promise<TrustRecord | undefined> {
    return this.trustRecords.get(id);
  }

  listProviderSupport(): Promise<readonly ProviderSupportReport[]> {
    return Promise.resolve(this.providerSupportReports);
  }
}

class MemoryAuditStore implements AuditStore {
  constructor(
    private readonly events: Map<AuditEventId, AuditEvent>,
    private readonly order: AuditEventId[],
  ) {}

  append(event: AuditEvent): Promise<AuditEvent> {
    const existing = this.events.get(event.id);
    if (existing) return Promise.resolve(existing);
    const value = immutable(event);
    this.events.set(event.id, value);
    this.order.push(event.id);
    return Promise.resolve(value);
  }

  get(id: AuditEventId): Promise<AuditEvent | undefined> {
    return Promise.resolve(this.events.get(id));
  }

  list(query: AuditEventQuery = {}): Promise<readonly AuditEvent[]> {
    return Promise.resolve(
      this.order
        .map((id) => this.events.get(id))
        .filter((event): event is AuditEvent => event !== undefined)
        .filter((event) => matchesAuditQuery(event, query)),
    );
  }
}

class MemoryUsageAggregateStore implements UsageAggregateStore {
  constructor(private readonly aggregates: Map<string, UsageAggregate>) {}

  recordEvent(
    event: UsageEventDto,
    projectedAt: string,
  ): Promise<UsageAggregate> {
    const key = aggregateKeyForEvent(event);
    const id = encodeAggregateId(key);
    const current = this.aggregates.get(id);
    const aggregate: UsageAggregate = current
      ? immutable({
        ...current,
        quantity: current.quantity + event.quantity,
        eventCount: current.eventCount + 1,
        firstOccurredAt: minIso(current.firstOccurredAt, event.occurredAt),
        lastOccurredAt: maxIso(current.lastOccurredAt, event.occurredAt),
        updatedAt: projectedAt,
      })
      : immutable({
        ...key,
        id,
        quantity: event.quantity,
        eventCount: 1,
        firstOccurredAt: event.occurredAt,
        lastOccurredAt: event.occurredAt,
        updatedAt: projectedAt,
      });
    this.aggregates.set(id, aggregate);
    return Promise.resolve(aggregate);
  }

  get(key: UsageAggregateKey): Promise<UsageAggregate | undefined> {
    return Promise.resolve(this.aggregates.get(encodeAggregateId(key)));
  }

  listBySpace(spaceId: string): Promise<readonly UsageAggregate[]> {
    return Promise.resolve(
      [...this.aggregates.values()].filter((aggregate) =>
        aggregate.spaceId === spaceId
      ),
    );
  }
}

class MemoryServiceEndpointStore implements ServiceEndpointStore {
  constructor(
    private readonly endpoints: Map<ServiceEndpointId, ServiceEndpoint>,
  ) {}

  put(endpoint: ServiceEndpoint): Promise<ServiceEndpoint> {
    const value = immutable(endpoint);
    this.endpoints.set(value.id, value);
    return Promise.resolve(value);
  }

  get(id: ServiceEndpointId): Promise<ServiceEndpoint | undefined> {
    return Promise.resolve(this.endpoints.get(id));
  }

  listByService(serviceId: ServiceId): Promise<readonly ServiceEndpoint[]> {
    return Promise.resolve(
      [...this.endpoints.values()].filter((endpoint) =>
        endpoint.serviceId === serviceId
      ),
    );
  }

  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly ServiceEndpoint[]> {
    return Promise.resolve(
      [...this.endpoints.values()].filter((endpoint) =>
        endpoint.spaceId === spaceId && endpoint.groupId === groupId
      ),
    );
  }

  updateHealth(
    id: ServiceEndpointId,
    update: ServiceEndpointHealthUpdate,
  ): Promise<ServiceEndpoint | undefined> {
    const existing = this.endpoints.get(id);
    if (!existing) return Promise.resolve(undefined);
    const health: ServiceEndpointHealth = {
      status: update.status,
      checkedAt: update.checkedAt,
      ...(update.message === undefined ? {} : { message: update.message }),
    };
    const updated = immutable({
      ...existing,
      health,
      updatedAt: update.updatedAt ?? update.checkedAt,
    });
    this.endpoints.set(id, updated);
    return Promise.resolve(updated);
  }
}

class MemoryServiceTrustRecordStore implements ServiceTrustRecordStore {
  constructor(
    private readonly records: Map<ServiceTrustRecordId, ServiceTrustRecord>,
  ) {}

  put(record: ServiceTrustRecord): Promise<ServiceTrustRecord> {
    const value = immutable(record);
    this.records.set(value.id, value);
    return Promise.resolve(value);
  }

  get(id: ServiceTrustRecordId): Promise<ServiceTrustRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  listByEndpoint(
    endpointId: ServiceEndpointId,
  ): Promise<readonly ServiceTrustRecord[]> {
    return Promise.resolve(
      [...this.records.values()].filter((record) =>
        record.endpointId === endpointId
      ),
    );
  }

  listActiveByEndpoint(
    endpointId: ServiceEndpointId,
    now?: string,
  ): Promise<readonly ServiceTrustRecord[]> {
    return Promise.resolve(
      [...this.records.values()].filter((record) =>
        record.endpointId === endpointId && record.status === "active" &&
        (now === undefined || record.expiresAt === undefined ||
          record.expiresAt > now)
      ),
    );
  }

  revoke(
    id: ServiceTrustRecordId,
    input: ServiceTrustRevokeInput,
  ): Promise<ServiceTrustRecord | undefined> {
    const existing = this.records.get(id);
    if (!existing) return Promise.resolve(undefined);
    if (existing.status === "revoked") return Promise.resolve(existing);

    const revoked = immutable({
      ...existing,
      status: "revoked" as const,
      updatedAt: input.revokedAt,
      revokedAt: input.revokedAt,
      ...(input.revokedBy === undefined ? {} : { revokedBy: input.revokedBy }),
      ...(input.reason === undefined ? {} : { revokeReason: input.reason }),
    });
    this.records.set(id, revoked);
    return Promise.resolve(revoked);
  }
}

class MemoryServiceGrantStore implements ServiceGrantStore {
  constructor(private readonly grants: Map<ServiceGrantId, ServiceGrant>) {}

  put(grant: ServiceGrant): Promise<ServiceGrant> {
    const value = immutable(grant);
    this.grants.set(value.id, value);
    return Promise.resolve(value);
  }

  get(id: ServiceGrantId): Promise<ServiceGrant | undefined> {
    return Promise.resolve(this.grants.get(id));
  }

  listByTrustRecord(
    trustRecordId: ServiceTrustRecordId,
  ): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.grants.values()].filter((grant) =>
        grant.trustRecordId === trustRecordId
      ),
    );
  }

  listBySubject(subject: string): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.grants.values()].filter((grant) => grant.subject === subject),
    );
  }
}
