import type { AuditStore } from "../../domains/audit/store.ts";
import type { DeploymentStore } from "../../domains/deploy/store.ts";
import type {
  BundledRegistry,
  PackageDescriptorStore,
  PackageResolutionStore,
  TrustRecordStore,
} from "../../domains/registry/stores.ts";
import type { ProviderSupportReport } from "../../domains/registry/types.ts";
import type { WorkLedger } from "../../agents/mod.ts";
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
  cloneState,
  createEmptyState,
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
import {
  MemoryServiceEndpointStore,
  MemoryServiceGrantStore,
  MemoryServiceTrustRecordStore,
} from "./memory/service_endpoint_stores.ts";

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
