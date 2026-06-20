/**
 * App store factories for `createInMemoryAppContext`.
 *
 * Split from `app_context.ts` so the in-memory and storage-backed wiring of
 * domain stores can be inspected without scrolling through the adapter and
 * service container builders. Bootstrap order is preserved: the service still
 * builds adapters first (so the storage driver is decided), then calls
 * `createAppStores` with that driver, then builds services.
 */

import { createInMemoryMembershipDomainDependencies } from "./domains/membership/mod.ts";
import {
  InMemoryProviderObservationStore,
  InMemoryRuntimeDesiredStateStore,
  InMemoryRuntimeObservedStateStore,
} from "./domains/runtime/mod.ts";
import {
  InMemoryBindingSetRevisionStore,
  InMemoryMigrationLedgerStore,
  InMemoryResourceBindingStore,
  InMemoryResourceInstanceStore,
} from "./domains/resources/mod.ts";
import {
  InMemoryBundledRegistry,
  InMemoryPackageDescriptorStore,
  InMemoryPackageResolutionStore,
  InMemoryTrustRecordStore,
} from "./domains/registry/mod.ts";
import { InMemoryAuditStore } from "./domains/audit/mod.ts";
import {
  InMemoryServiceEndpointStore,
  InMemoryEndpointServiceGrantStore,
  InMemoryServiceTrustRecordStore,
} from "./domains/service-endpoints/mod.ts";
import {
  InMemoryServiceBindingStore,
  InMemoryServiceExportStore,
  InMemoryServiceGraphGrantStore,
} from "./domains/service-graph/mod.ts";
import type {
  StorageDriver,
  StorageTransaction,
} from "./adapters/storage/mod.ts";
import type {
  AppContextOptions,
  AppStores,
  RegistryStores,
} from "./app_context.ts";

export function createAppStores(
  options: AppContextOptions = {},
  storageDriver?: StorageDriver,
): AppStores {
  if (storageDriver) {
    return createStorageBackedAppStores(options, storageDriver);
  }
  const registryStores = createRegistryStores(options.stores?.registry);
  return {
    space: createInMemoryMembershipDomainDependencies({
      ...options.space,
      clock: options.space?.clock ?? options.clock,
      idGenerator: options.space?.idGenerator ?? options.idGenerator,
      ...options.stores?.space,
    }),
    runtime: {
      desiredStates:
        options.stores?.runtime?.desiredStates ??
        new InMemoryRuntimeDesiredStateStore(),
      observedStates:
        options.stores?.runtime?.observedStates ??
        new InMemoryRuntimeObservedStateStore(),
      providerObservations:
        options.stores?.runtime?.providerObservations ??
        new InMemoryProviderObservationStore(),
    },
    resources: {
      instances:
        options.stores?.resources?.instances ??
        new InMemoryResourceInstanceStore(),
      bindings:
        options.stores?.resources?.bindings ??
        new InMemoryResourceBindingStore(),
      bindingSetRevisions:
        options.stores?.resources?.bindingSetRevisions ??
        new InMemoryBindingSetRevisionStore(),
      migrationLedger:
        options.stores?.resources?.migrationLedger ??
        new InMemoryMigrationLedgerStore(),
    },
    registry: registryStores,
    audit: {
      events: options.stores?.audit?.events ?? new InMemoryAuditStore(),
    },
    serviceEndpoints: {
      endpoints:
        options.stores?.serviceEndpoints?.endpoints ??
        new InMemoryServiceEndpointStore(),
      trustRecords:
        options.stores?.serviceEndpoints?.trustRecords ??
        new InMemoryServiceTrustRecordStore(),
      grants:
        options.stores?.serviceEndpoints?.grants ??
        new InMemoryEndpointServiceGrantStore(),
    },
    serviceGraph: {
      exports:
        options.stores?.serviceGraph?.exports ??
        new InMemoryServiceExportStore(),
      bindings:
        options.stores?.serviceGraph?.bindings ??
        new InMemoryServiceBindingStore(),
      grants:
        options.stores?.serviceGraph?.grants ??
        new InMemoryServiceGraphGrantStore(),
    },
  };
}

export function shouldUseStorageBackedStores(
  options: AppContextOptions,
): boolean {
  return Boolean(options.adapters?.storage);
}

function createStorageBackedAppStores(
  options: AppContextOptions,
  driver: StorageDriver,
): AppStores {
  const registryStores = {
    descriptors:
      options.stores?.registry?.descriptors ??
      storageBackedStore(driver, (tx) => tx.registry.descriptors),
    resolutions:
      options.stores?.registry?.resolutions ??
      storageBackedStore(driver, (tx) => tx.registry.resolutions),
    trustRecords:
      options.stores?.registry?.trustRecords ??
      storageBackedStore(driver, (tx) => tx.registry.trustRecords),
    bundledRegistry:
      options.stores?.registry?.bundledRegistry ??
      storageBackedStore(driver, (tx) => tx.registry.bundledRegistry),
  };
  return {
    space: createInMemoryMembershipDomainDependencies({
      ...options.space,
      clock: options.space?.clock ?? options.clock,
      idGenerator: options.space?.idGenerator ?? options.idGenerator,
      spaces:
        options.stores?.space?.spaces ??
        storageBackedStore(driver, (tx) => tx.space.spaces),
      groups:
        options.stores?.space?.groups ??
        storageBackedStore(driver, (tx) => tx.space.groups),
      memberships:
        options.stores?.space?.memberships ??
        storageBackedStore(driver, (tx) => tx.space.spaceMemberships),
    }),
    runtime: {
      desiredStates:
        options.stores?.runtime?.desiredStates ??
        storageBackedStore(driver, (tx) => tx.runtime.desiredStates),
      observedStates:
        options.stores?.runtime?.observedStates ??
        storageBackedStore(driver, (tx) => tx.runtime.observedStates),
      providerObservations:
        options.stores?.runtime?.providerObservations ??
        storageBackedStore(driver, (tx) => tx.runtime.providerObservations),
    },
    resources: {
      instances:
        options.stores?.resources?.instances ??
        storageBackedStore(driver, (tx) => tx.resources.instances),
      bindings:
        options.stores?.resources?.bindings ??
        storageBackedStore(driver, (tx) => tx.resources.bindings),
      bindingSetRevisions:
        options.stores?.resources?.bindingSetRevisions ??
        storageBackedStore(driver, (tx) => tx.resources.bindingSetRevisions),
      migrationLedger:
        options.stores?.resources?.migrationLedger ??
        storageBackedStore(driver, (tx) => tx.resources.migrationLedger),
    },
    registry: registryStores,
    audit: {
      events:
        options.stores?.audit?.events ??
        storageBackedStore(driver, (tx) => tx.audit.events),
    },
    serviceEndpoints: {
      endpoints:
        options.stores?.serviceEndpoints?.endpoints ??
        storageBackedStore(driver, (tx) => tx.serviceEndpoints.endpoints),
      trustRecords:
        options.stores?.serviceEndpoints?.trustRecords ??
        storageBackedStore(driver, (tx) => tx.serviceEndpoints.trustRecords),
      grants:
        options.stores?.serviceEndpoints?.grants ??
        storageBackedStore(driver, (tx) => tx.serviceEndpoints.grants),
    },
    serviceGraph: {
      exports:
        options.stores?.serviceGraph?.exports ??
        storageBackedStore(driver, (tx) => tx.serviceGraph.exports),
      bindings:
        options.stores?.serviceGraph?.bindings ??
        storageBackedStore(driver, (tx) => tx.serviceGraph.bindings),
      grants:
        options.stores?.serviceGraph?.grants ??
        storageBackedStore(driver, (tx) => tx.serviceGraph.grants),
    },
  };
}

function storageBackedStore<TStore extends object>(
  driver: StorageDriver,
  select: (transaction: StorageTransaction) => TStore,
  options: {
    readonly missingOptionalMethods?: readonly string[];
  } = {},
): TStore {
  const missingOptionalMethods = new Set(options.missingOptionalMethods ?? []);
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (missingOptionalMethods.has(property)) return undefined;
        return (...args: readonly unknown[]) =>
          driver.transaction((transaction) => {
            const store = select(transaction) as Record<string, unknown>;
            const method = store[property];
            if (typeof method !== "function") {
              throw new Error(`storage store method not found: ${property}`);
            }
            return method.apply(store, args);
          });
      },
    },
  ) as TStore;
}

function createRegistryStores(
  overrides?: Partial<RegistryStores>,
): RegistryStores {
  const descriptors =
    overrides?.descriptors ?? new InMemoryPackageDescriptorStore();
  const resolutions =
    overrides?.resolutions ?? new InMemoryPackageResolutionStore();
  const trustRecords =
    overrides?.trustRecords ?? new InMemoryTrustRecordStore();
  return {
    descriptors,
    resolutions,
    trustRecords,
    bundledRegistry:
      overrides?.bundledRegistry ??
      new InMemoryBundledRegistry(descriptors, resolutions, trustRecords),
  };
}
