import type { AuditStore } from "../../domains/audit/store.ts";
import type {
  GroupStore,
  SpaceMembershipStore,
  SpaceStore,
} from "../../domains/core/stores.ts";
import type { DeploymentStore } from "../../domains/deploy/store.ts";
import type {
  BindingSetRevisionStore,
  MigrationLedgerStore,
  ResourceBindingStore,
  ResourceInstanceStore,
} from "../../domains/resources/stores.ts";
import type {
  ProviderObservationStore,
  RuntimeDesiredStateStore,
  RuntimeObservedStateStore,
} from "../../domains/runtime/stores.ts";
import type {
  BundledRegistry,
  PackageDescriptorStore,
  PackageResolutionStore,
  TrustRecordStore,
} from "../../domains/registry/stores.ts";
import type {
  ServiceEndpointStore,
  ServiceGrantStore,
  ServiceTrustRecordStore,
} from "../../domains/service-endpoints/stores.ts";
import type { UsageAggregateStore } from "../../services/usage/store.ts";
import type { WorkLedger } from "../../agents/work_ledger.ts";
import type { StorageStatementCatalog } from "./statements.ts";

export interface StorageDriver {
  readonly statements: StorageStatementCatalog;
  transaction<T>(
    fn: (transaction: StorageTransaction) => T | Promise<T>,
  ): Promise<T>;
}

export interface StorageTransaction {
  readonly core: CoreStorageStores;
  readonly deploy: DeployStorageStores;
  readonly runtime: RuntimeStorageStores;
  readonly resources: ResourceStorageStores;
  readonly registry: RegistryStorageStores;
  readonly audit: AuditStorageStores;
  readonly usage: UsageStorageStores;
  readonly serviceEndpoints: ServiceEndpointStorageStores;
  readonly runtimeAgent: WorkLedger;
}

export interface CoreStorageStores {
  readonly spaces: SpaceStore;
  readonly groups: GroupStore;
  readonly spaceMemberships: SpaceMembershipStore;
}

export interface DeployStorageStores {
  readonly deploys: DeploymentStore;
}

export interface RuntimeStorageStores {
  readonly desiredStates: RuntimeDesiredStateStore;
  readonly observedStates: RuntimeObservedStateStore;
  readonly providerObservations: ProviderObservationStore;
}

export interface ResourceStorageStores {
  readonly instances: ResourceInstanceStore;
  readonly bindings: ResourceBindingStore;
  readonly bindingSetRevisions: BindingSetRevisionStore;
  readonly migrationLedger: MigrationLedgerStore;
}

export interface RegistryStorageStores {
  readonly descriptors: PackageDescriptorStore;
  readonly resolutions: PackageResolutionStore;
  readonly trustRecords: TrustRecordStore;
  readonly bundledRegistry: BundledRegistry;
}

export interface AuditStorageStores {
  readonly events: AuditStore;
}

export interface UsageStorageStores {
  readonly aggregates: UsageAggregateStore;
}

export interface ServiceEndpointStorageStores {
  readonly endpoints: ServiceEndpointStore;
  readonly trustRecords: ServiceTrustRecordStore;
  readonly grants: ServiceGrantStore;
}
