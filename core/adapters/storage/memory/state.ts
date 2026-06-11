// In-memory mirror of every persisted entity collection backing the
// `MemoryStorageDriver`. The transaction layer clones the state, mutates
// the clone through the store classes, and either swaps the clone in
// (commit) or discards it (rollback).

import type { AuditEvent, AuditEventId } from "../../../domains/audit/types.ts";
import type {
  Group,
  MembershipSpace,
  SpaceId,
  SpaceMembership,
} from "../../../domains/membership/types.ts";
import type {
  BindingSetRevision,
  BindingSetRevisionId,
  MigrationLedgerEntry,
  MigrationLedgerId,
  ResourceBinding,
  ResourceBindingId,
  ResourceInstance,
  ResourceInstanceId,
} from "../../../domains/resources/types.ts";
import type {
  ProviderObservation,
  RuntimeDesiredState,
  RuntimeDesiredStateId,
  RuntimeObservedStateId,
  RuntimeObservedStateSnapshot,
} from "../../../domains/runtime/types.ts";
import type {
  PackageDescriptor,
  PackageResolution,
  ProviderSupportReport,
  TrustRecord,
} from "../../../domains/registry/types.ts";
import type {
  ServiceEndpoint,
  ServiceEndpointId,
  ServiceGrant,
  ServiceGrantId,
  ServiceTrustRecord,
  ServiceTrustRecordId,
} from "../../../domains/service-endpoints/types.ts";
import type {
  RuntimeAgentId,
  RuntimeAgentRecord,
  RuntimeAgentWorkId,
  RuntimeAgentWorkItem,
} from "../../../agents/mod.ts";
import { immutable } from "./helpers.ts";

export interface MemoryStorageSnapshot {
  readonly spaces: readonly MembershipSpace[];
  readonly groups: readonly Group[];
  readonly spaceMemberships: readonly SpaceMembership[];
  readonly runtimeDesiredStates: readonly RuntimeDesiredState[];
  readonly runtimeObservedStates: readonly RuntimeObservedStateSnapshot[];
  readonly providerObservations: readonly ProviderObservation[];
  readonly resourceInstances: readonly ResourceInstance[];
  readonly resourceBindings: readonly ResourceBinding[];
  readonly bindingSetRevisions: readonly BindingSetRevision[];
  readonly migrationLedgerEntries: readonly MigrationLedgerEntry[];
  readonly packageDescriptors: readonly PackageDescriptor[];
  readonly packageResolutions: readonly PackageResolution[];
  readonly trustRecords: readonly TrustRecord[];
  readonly auditEvents: readonly AuditEvent[];
  readonly serviceEndpoints: readonly ServiceEndpoint[];
  readonly serviceTrustRecords: readonly ServiceTrustRecord[];
  readonly serviceGrants: readonly ServiceGrant[];
  readonly runtimeAgents: readonly RuntimeAgentRecord[];
  readonly runtimeAgentWorkItems: readonly RuntimeAgentWorkItem[];
}

export interface MemoryStorageState {
  readonly space: {
    readonly spaces: Map<SpaceId, MembershipSpace>;
    readonly groups: Map<string, Group>;
    readonly spaceMemberships: Map<string, SpaceMembership>;
  };
  readonly runtime: {
    readonly desiredStates: Map<RuntimeDesiredStateId, RuntimeDesiredState>;
    readonly observedStates: Map<
      RuntimeObservedStateId,
      RuntimeObservedStateSnapshot
    >;
    readonly providerObservations: ProviderObservation[];
  };
  readonly resources: {
    readonly instances: Map<ResourceInstanceId, ResourceInstance>;
    readonly bindings: Map<ResourceBindingId, ResourceBinding>;
    readonly bindingSetRevisions: Map<BindingSetRevisionId, BindingSetRevision>;
    readonly migrationLedger: Map<MigrationLedgerId, MigrationLedgerEntry>;
  };
  readonly registry: {
    readonly descriptors: Map<string, PackageDescriptor>;
    readonly resolutions: Map<string, PackageResolution>;
    readonly trustRecords: Map<string, TrustRecord>;
    readonly providerSupportReports: readonly ProviderSupportReport[];
  };
  readonly audit: {
    readonly events: Map<AuditEventId, AuditEvent>;
    readonly order: AuditEventId[];
  };
  readonly serviceEndpoints: {
    readonly endpoints: Map<ServiceEndpointId, ServiceEndpoint>;
    readonly trustRecords: Map<ServiceTrustRecordId, ServiceTrustRecord>;
    readonly grants: Map<ServiceGrantId, ServiceGrant>;
  };
  readonly runtimeAgent: {
    readonly agents: Map<RuntimeAgentId, RuntimeAgentRecord>;
    readonly works: Map<RuntimeAgentWorkId, RuntimeAgentWorkItem>;
  };
}

export function createEmptyState(
  providerSupportReports: readonly ProviderSupportReport[],
): MemoryStorageState {
  return {
    space: {
      spaces: new Map(),
      groups: new Map(),
      spaceMemberships: new Map(),
    },
    runtime: {
      desiredStates: new Map(),
      observedStates: new Map(),
      providerObservations: [],
    },
    resources: {
      instances: new Map(),
      bindings: new Map(),
      bindingSetRevisions: new Map(),
      migrationLedger: new Map(),
    },
    registry: {
      descriptors: new Map(),
      resolutions: new Map(),
      trustRecords: new Map(),
      providerSupportReports: immutable(providerSupportReports),
    },
    audit: {
      events: new Map(),
      order: [],
    },
    serviceEndpoints: {
      endpoints: new Map(),
      trustRecords: new Map(),
      grants: new Map(),
    },
    runtimeAgent: {
      agents: new Map(),
      works: new Map(),
    },
  };
}

export function stateFromSnapshot(
  snapshot: MemoryStorageSnapshot,
  providerSupportReports: readonly ProviderSupportReport[] = [],
): MemoryStorageState {
  return {
    space: {
      spaces: mapBy(snapshot.spaces, (space) => space.id),
      groups: mapBy(snapshot.groups, (group) => group.id),
      spaceMemberships: mapBy(
        snapshot.spaceMemberships,
        (membership) => `${membership.spaceId}:${membership.accountId}`,
      ),
    },
    runtime: {
      desiredStates: mapBy(
        snapshot.runtimeDesiredStates,
        (state) => state.id,
      ),
      observedStates: mapBy(
        snapshot.runtimeObservedStates,
        (state) => state.id,
      ),
      providerObservations: snapshot.providerObservations.map(immutable),
    },
    resources: {
      instances: mapBy(snapshot.resourceInstances, (instance) => instance.id),
      bindings: mapBy(snapshot.resourceBindings, (binding) => binding.id),
      bindingSetRevisions: mapBy(
        snapshot.bindingSetRevisions,
        (revision) => revision.id,
      ),
      migrationLedger: mapBy(
        snapshot.migrationLedgerEntries,
        (entry) => entry.id,
      ),
    },
    registry: {
      descriptors: mapBy(
        snapshot.packageDescriptors,
        (descriptor) =>
          `${descriptor.kind}:${descriptor.ref}:${descriptor.digest}`,
      ),
      resolutions: mapBy(
        snapshot.packageResolutions,
        (resolution) =>
          `${resolution.kind}:${resolution.ref}:${resolution.digest}`,
      ),
      trustRecords: mapBy(snapshot.trustRecords, (record) => record.id),
      providerSupportReports,
    },
    audit: {
      events: mapBy(snapshot.auditEvents, (event) => event.id),
      order: snapshot.auditEvents.map((event) => event.id),
    },
    serviceEndpoints: {
      endpoints: mapBy(snapshot.serviceEndpoints, (endpoint) => endpoint.id),
      trustRecords: mapBy(
        snapshot.serviceTrustRecords,
        (record) => record.id,
      ),
      grants: mapBy(snapshot.serviceGrants, (grant) => grant.id),
    },
    runtimeAgent: {
      agents: mapBy(snapshot.runtimeAgents, (agent) => agent.id),
      works: mapBy(snapshot.runtimeAgentWorkItems, (work) => work.id),
    },
  };
}

export function cloneState(state: MemoryStorageState): MemoryStorageState {
  return {
    space: {
      spaces: cloneMap(state.space.spaces),
      groups: cloneMap(state.space.groups),
      spaceMemberships: cloneMap(state.space.spaceMemberships),
    },
    runtime: {
      desiredStates: cloneMap(state.runtime.desiredStates),
      observedStates: cloneMap(state.runtime.observedStates),
      providerObservations: state.runtime.providerObservations.map(immutable),
    },
    resources: {
      instances: cloneMap(state.resources.instances),
      bindings: cloneMap(state.resources.bindings),
      bindingSetRevisions: cloneMap(state.resources.bindingSetRevisions),
      migrationLedger: cloneMap(state.resources.migrationLedger),
    },
    registry: {
      descriptors: cloneMap(state.registry.descriptors),
      resolutions: cloneMap(state.registry.resolutions),
      trustRecords: cloneMap(state.registry.trustRecords),
      providerSupportReports: state.registry.providerSupportReports,
    },
    audit: {
      events: cloneMap(state.audit.events),
      order: [...state.audit.order],
    },
    serviceEndpoints: {
      endpoints: cloneMap(state.serviceEndpoints.endpoints),
      trustRecords: cloneMap(state.serviceEndpoints.trustRecords),
      grants: cloneMap(state.serviceEndpoints.grants),
    },
    runtimeAgent: {
      agents: cloneMap(state.runtimeAgent.agents),
      works: cloneMap(state.runtimeAgent.works),
    },
  };
}

function mapBy<T, K>(
  values: readonly T[],
  key: (value: T) => K,
): Map<K, T> {
  const map = new Map<K, T>();
  for (const value of values) map.set(key(value), immutable(value));
  return map;
}

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
  const next = new Map<K, V>();
  for (const [key, value] of source) next.set(key, immutable(value));
  return next;
}

export function snapshotState(
  state: MemoryStorageState,
): MemoryStorageSnapshot {
  return immutable({
    spaces: [...state.space.spaces.values()],
    groups: [...state.space.groups.values()],
    spaceMemberships: [...state.space.spaceMemberships.values()],
    runtimeDesiredStates: [...state.runtime.desiredStates.values()],
    runtimeObservedStates: [...state.runtime.observedStates.values()],
    providerObservations: [...state.runtime.providerObservations],
    resourceInstances: [...state.resources.instances.values()],
    resourceBindings: [...state.resources.bindings.values()],
    bindingSetRevisions: [...state.resources.bindingSetRevisions.values()],
    migrationLedgerEntries: [...state.resources.migrationLedger.values()],
    packageDescriptors: [...state.registry.descriptors.values()],
    packageResolutions: [...state.registry.resolutions.values()],
    trustRecords: [...state.registry.trustRecords.values()],
    auditEvents: state.audit.order
      .map((id) => state.audit.events.get(id))
      .filter((event): event is AuditEvent => event !== undefined),
    serviceEndpoints: [...state.serviceEndpoints.endpoints.values()],
    serviceTrustRecords: [...state.serviceEndpoints.trustRecords.values()],
    serviceGrants: [...state.serviceEndpoints.grants.values()],
    runtimeAgents: [...state.runtimeAgent.agents.values()],
    runtimeAgentWorkItems: [...state.runtimeAgent.works.values()],
  });
}
