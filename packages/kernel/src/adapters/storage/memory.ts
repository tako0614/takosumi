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
import {
  MemoryProviderObservationStore,
  MemoryRuntimeDesiredStateStore,
  MemoryRuntimeObservedStateStore,
} from "./memory/runtime_stores.ts";
import {
  MemoryBindingSetRevisionStore,
  MemoryMigrationLedgerStore,
  MemoryResourceBindingStore,
  MemoryResourceInstanceStore,
} from "./memory/resource_stores.ts";
import {
  MemoryBundledRegistry,
  MemoryPackageDescriptorStore,
  MemoryPackageResolutionStore,
  MemoryTrustRecordStore,
} from "./memory/registry_stores.ts";
import { MemoryAuditStore } from "./memory/audit_store.ts";
import { MemoryUsageAggregateStore } from "./memory/usage_store.ts";
import { MemoryRuntimeAgentLedgerStore } from "./memory/runtime_agent_store.ts";

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
