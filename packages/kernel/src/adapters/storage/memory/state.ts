// In-memory mirror of every persisted entity collection backing the
// `MemoryStorageDriver`. The transaction layer clones the state, mutates
// the clone through the store classes, and either swaps the clone in
// (commit) or discards it (rollback).

import type { Deployment, GroupHead } from "takosumi-contract";
import type { ProviderObservation as CoreProviderObservation } from "takosumi-contract";
import type { AuditEvent, AuditEventId } from "../../../domains/audit/types.ts";
import type {
  Group,
  Space,
  SpaceId,
  SpaceMembership,
} from "../../../domains/core/types.ts";
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
import type { UsageAggregate } from "../../../services/usage/types.ts";
import type {
  RuntimeAgentId,
  RuntimeAgentRecord,
  RuntimeAgentWorkId,
  RuntimeAgentWorkItem,
} from "../../../agents/mod.ts";
import { immutable } from "./helpers.ts";

export interface MemoryStorageSnapshot {
  readonly spaces: readonly Space[];
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
  readonly usageAggregates: readonly UsageAggregate[];
  readonly serviceEndpoints: readonly ServiceEndpoint[];
  readonly serviceTrustRecords: readonly ServiceTrustRecord[];
  readonly serviceGrants: readonly ServiceGrant[];
  readonly runtimeAgents: readonly RuntimeAgentRecord[];
  readonly runtimeAgentWorkItems: readonly RuntimeAgentWorkItem[];
}

export interface MemoryStorageState {
  readonly core: {
    readonly spaces: Map<SpaceId, Space>;
    readonly groups: Map<string, Group>;
    readonly spaceMemberships: Map<string, SpaceMembership>;
  };
  readonly deploy: MemoryDeployState;
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
  readonly usage: {
    readonly aggregates: Map<string, UsageAggregate>;
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

export interface MemoryDeployState {
  readonly deployments: Map<string, Deployment>;
  readonly groupHeads: Map<string, GroupHead>;
  readonly providerObservations: Map<string, CoreProviderObservation>;
}

export function createEmptyState(
  providerSupportReports: readonly ProviderSupportReport[],
): MemoryStorageState {
  return {
    core: {
      spaces: new Map(),
      groups: new Map(),
      spaceMemberships: new Map(),
    },
    deploy: {
      deployments: new Map(),
      groupHeads: new Map(),
      providerObservations: new Map(),
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
    usage: {
      aggregates: new Map(),
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

export function cloneState(state: MemoryStorageState): MemoryStorageState {
  return {
    core: {
      spaces: cloneMap(state.core.spaces),
      groups: cloneMap(state.core.groups),
      spaceMemberships: cloneMap(state.core.spaceMemberships),
    },
    deploy: {
      deployments: cloneMap(state.deploy.deployments),
      groupHeads: cloneMap(state.deploy.groupHeads),
      providerObservations: cloneMap(state.deploy.providerObservations),
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
    usage: {
      aggregates: cloneMap(state.usage.aggregates),
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

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
  const next = new Map<K, V>();
  for (const [key, value] of source) next.set(key, immutable(value));
  return next;
}

export function snapshotState(
  state: MemoryStorageState,
): MemoryStorageSnapshot {
  return immutable({
    spaces: [...state.core.spaces.values()],
    groups: [...state.core.groups.values()],
    spaceMemberships: [...state.core.spaceMemberships.values()],
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
    usageAggregates: [...state.usage.aggregates.values()],
    serviceEndpoints: [...state.serviceEndpoints.endpoints.values()],
    serviceTrustRecords: [...state.serviceEndpoints.trustRecords.values()],
    serviceGrants: [...state.serviceEndpoints.grants.values()],
    runtimeAgents: [...state.runtimeAgent.agents.values()],
    runtimeAgentWorkItems: [...state.runtimeAgent.works.values()],
  });
}
