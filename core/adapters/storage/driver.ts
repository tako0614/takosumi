import type { AuditStore } from "../../domains/audit/store.ts";
import type {
  GroupStore,
  MembershipSpaceStore,
  SpaceMembershipStore,
} from "../../domains/membership/stores.ts";
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
  EndpointServiceGrantStore,
  ServiceTrustRecordStore,
} from "../../domains/service-endpoints/stores.ts";
import type {
  ServiceBindingStore,
  ServiceExportStore,
  ServiceGraphGrantStore,
} from "../../domains/service-graph/stores.ts";
import type { WorkLedger } from "../../agents/work_ledger.ts";

export interface StorageDriver {
  transaction<T>(
    fn: (transaction: StorageTransaction) => T | Promise<T>,
  ): Promise<T>;
}

export interface StorageTransaction {
  readonly space: SpaceStorageStores;
  readonly runtime: RuntimeStorageStores;
  readonly resources: ResourceStorageStores;
  readonly registry: RegistryStorageStores;
  readonly audit: AuditStorageStores;
  readonly serviceEndpoints: ServiceEndpointStorageStores;
  readonly serviceGraph: ServiceGraphStorageStores;
  readonly runtimeAgent: WorkLedger;
}

export interface SpaceStorageStores {
  readonly spaces: MembershipSpaceStore;
  readonly groups: GroupStore;
  readonly spaceMemberships: SpaceMembershipStore;
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

export interface ServiceEndpointStorageStores {
  readonly endpoints: ServiceEndpointStore;
  readonly trustRecords: ServiceTrustRecordStore;
  readonly grants: EndpointServiceGrantStore;
}

export interface ServiceGraphStorageStores {
  readonly exports: ServiceExportStore;
  readonly bindings: ServiceBindingStore;
  readonly grants: ServiceGraphGrantStore;
}
