export type StorageDomain =
  | "space"
  | "deploy"
  | "runtime"
  | "resources"
  | "registry"
  | "audit"
  | "usage"
  | "service-endpoints"
  | "custom-domain"
  | "internal-auth";

export type StorageStatementOperation =
  | "insert"
  | "select"
  | "list"
  | "upsert"
  | "update"
  | "append";

export interface StorageStatementDescription {
  readonly id: string;
  readonly domain: StorageDomain;
  readonly object: string;
  readonly operation: StorageStatementOperation;
  readonly sql: string;
  readonly parameters: readonly string[];
  readonly returns: string;
  readonly notes?: string;
}

export interface StorageStatementCatalog {
  readonly space: readonly StorageStatementDescription[];
  readonly deploy: readonly StorageStatementDescription[];
  readonly runtime: readonly StorageStatementDescription[];
  readonly resources: readonly StorageStatementDescription[];
  readonly registry: readonly StorageStatementDescription[];
  readonly audit: readonly StorageStatementDescription[];
  readonly usage: readonly StorageStatementDescription[];
  readonly serviceEndpoints: readonly StorageStatementDescription[];
  readonly all: readonly StorageStatementDescription[];
}

const space: readonly StorageStatementDescription[] = [
  {
    id: "space.spaces.insert",
    domain: "space",
    object: "space",
    operation: "insert",
    sql:
      "insert into spaces (id, name, metadata_json, created_by_account_id, created_at, updated_at) values (:id, :name, :metadataJson, :createdByAccountId, :createdAt, :updatedAt)",
    parameters: [
      "id",
      "name",
      "metadataJson",
      "createdByAccountId",
      "createdAt",
      "updatedAt",
    ],
    returns: "Space",
    notes: "Primary key conflict maps to DomainError conflict.",
  },
  {
    id: "space.spaces.get",
    domain: "space",
    object: "space",
    operation: "select",
    sql:
      "select id, name, metadata_json, created_by_account_id, created_at, updated_at from spaces where id = :spaceId",
    parameters: ["spaceId"],
    returns: "Space | undefined",
  },
  {
    id: "space.spaces.list",
    domain: "space",
    object: "space",
    operation: "list",
    sql:
      "select id, name, metadata_json, created_by_account_id, created_at, updated_at from spaces order by created_at asc, id asc",
    parameters: [],
    returns: "readonly Space[]",
  },
  {
    id: "space.groups.insert",
    domain: "space",
    object: "group",
    operation: "insert",
    sql:
      "insert into space_groups (id, space_id, slug, display_name, metadata_json, created_by_account_id, created_at, updated_at) values (:id, :spaceId, :slug, :displayName, :metadataJson, :createdByAccountId, :createdAt, :updatedAt)",
    parameters: [
      "id",
      "spaceId",
      "slug",
      "displayName",
      "metadataJson",
      "createdByAccountId",
      "createdAt",
      "updatedAt",
    ],
    returns: "Group",
    notes: "Unique constraints: id, and (space_id, slug).",
  },
  {
    id: "space.groups.get",
    domain: "space",
    object: "group",
    operation: "select",
    sql:
      "select id, space_id, slug, display_name, metadata_json, created_by_account_id, created_at, updated_at from space_groups where id = :groupId",
    parameters: ["groupId"],
    returns: "Group | undefined",
  },
  {
    id: "space.groups.find_by_slug",
    domain: "space",
    object: "group",
    operation: "select",
    sql:
      "select id, space_id, slug, display_name, metadata_json, created_by_account_id, created_at, updated_at from space_groups where space_id = :spaceId and slug = :slug",
    parameters: ["spaceId", "slug"],
    returns: "Group | undefined",
  },
  {
    id: "space.groups.list_by_space",
    domain: "space",
    object: "group",
    operation: "list",
    sql:
      "select id, space_id, slug, display_name, metadata_json, created_by_account_id, created_at, updated_at from space_groups where space_id = :spaceId order by created_at asc, id asc",
    parameters: ["spaceId"],
    returns: "readonly Group[]",
  },
  {
    id: "space.space_memberships.upsert",
    domain: "space",
    object: "space_membership",
    operation: "upsert",
    sql:
      "insert into space_memberships (id, space_id, account_id, roles_json, status, created_at, updated_at) values (:id, :spaceId, :accountId, :rolesJson, :status, :createdAt, :updatedAt) on conflict (space_id, account_id) do update set roles_json = excluded.roles_json, status = excluded.status, updated_at = excluded.updated_at",
    parameters: [
      "id",
      "spaceId",
      "accountId",
      "rolesJson",
      "status",
      "createdAt",
      "updatedAt",
    ],
    returns: "SpaceMembership",
  },
  {
    id: "space.space_memberships.get",
    domain: "space",
    object: "space_membership",
    operation: "select",
    sql:
      "select id, space_id, account_id, roles_json, status, created_at, updated_at from space_memberships where space_id = :spaceId and account_id = :accountId",
    parameters: ["spaceId", "accountId"],
    returns: "SpaceMembership | undefined",
  },
  {
    id: "space.space_memberships.list_by_space",
    domain: "space",
    object: "space_membership",
    operation: "list",
    sql:
      "select id, space_id, account_id, roles_json, status, created_at, updated_at from space_memberships where space_id = :spaceId order by created_at asc, id asc",
    parameters: ["spaceId"],
    returns: "readonly SpaceMembership[]",
  },
];

const deploy: readonly StorageStatementDescription[] = [];

const runtime: readonly StorageStatementDescription[] = [
  {
    id: "runtime.desired_states.put",
    domain: "runtime",
    object: "desired_state",
    operation: "upsert",
    sql:
      "insert into runtime_desired_states (id, space_id, group_id, activation_id, state_json, materialized_at) values (:id, :spaceId, :groupId, :activationId, :stateJson, :materializedAt) on conflict (id) do update set state_json = excluded.state_json",
    parameters: [
      "id",
      "spaceId",
      "groupId",
      "activationId",
      "stateJson",
      "materializedAt",
    ],
    returns: "RuntimeDesiredState",
  },
  {
    id: "runtime.desired_states.get",
    domain: "runtime",
    object: "desired_state",
    operation: "select",
    sql: "select * from runtime_desired_states where id = :id",
    parameters: ["id"],
    returns: "RuntimeDesiredState | undefined",
  },
  {
    id: "runtime.observed_states.record",
    domain: "runtime",
    object: "observed_state",
    operation: "append",
    sql:
      "insert into runtime_observed_states (id, space_id, group_id, snapshot_json, observed_at) values (:id, :spaceId, :groupId, :snapshotJson, :observedAt)",
    parameters: ["id", "spaceId", "groupId", "snapshotJson", "observedAt"],
    returns: "RuntimeObservedStateSnapshot",
  },
  {
    id: "runtime.provider_observations.record",
    domain: "runtime",
    object: "provider_observation",
    operation: "append",
    sql:
      "insert into runtime_provider_observations (materialization_id, observation_json, observed_at) values (:materializationId, :observationJson, :observedAt)",
    parameters: ["materializationId", "observationJson", "observedAt"],
    returns: "ProviderObservation",
  },
];

const resources: readonly StorageStatementDescription[] = [
  {
    id: "resources.instances.insert",
    domain: "resources",
    object: "resource_instance",
    operation: "insert",
    sql:
      "insert into resource_instances (id, space_id, group_id, contract, origin, sharing_mode, provider, provider_resource_id, provider_materialization_id, lifecycle_json, schema_owner_json, properties_json, created_at, updated_at) values (:id, :spaceId, :groupId, :contract, :origin, :sharingMode, :provider, :providerResourceId, :providerMaterializationId, :lifecycleJson, :schemaOwnerJson, :propertiesJson, :createdAt, :updatedAt)",
    parameters: [
      "id",
      "spaceId",
      "groupId",
      "contract",
      "origin",
      "sharingMode",
      "provider",
      "providerResourceId",
      "providerMaterializationId",
      "lifecycleJson",
      "schemaOwnerJson",
      "propertiesJson",
      "createdAt",
      "updatedAt",
    ],
    returns: "ResourceInstance",
    notes: "Idempotent create returns existing row when id already exists.",
  },
  {
    id: "resources.instances.get",
    domain: "resources",
    object: "resource_instance",
    operation: "select",
    sql: "select * from resource_instances where id = :id",
    parameters: ["id"],
    returns: "ResourceInstance | undefined",
  },
  {
    id: "resources.instances.list_by_space",
    domain: "resources",
    object: "resource_instance",
    operation: "list",
    sql:
      "select * from resource_instances where space_id = :spaceId order by created_at asc, id asc",
    parameters: ["spaceId"],
    returns: "readonly ResourceInstance[]",
  },
  {
    id: "resources.instances.list_by_group",
    domain: "resources",
    object: "resource_instance",
    operation: "list",
    sql:
      "select * from resource_instances where group_id = :groupId order by created_at asc, id asc",
    parameters: ["groupId"],
    returns: "readonly ResourceInstance[]",
  },
  {
    id: "resources.instances.update",
    domain: "resources",
    object: "resource_instance",
    operation: "update",
    sql:
      "update resource_instances set space_id = :spaceId, group_id = :groupId, contract = :contract, origin = :origin, sharing_mode = :sharingMode, provider = :provider, provider_resource_id = :providerResourceId, provider_materialization_id = :providerMaterializationId, lifecycle_json = :lifecycleJson, schema_owner_json = :schemaOwnerJson, properties_json = :propertiesJson, updated_at = :updatedAt where id = :id",
    parameters: [
      "id",
      "spaceId",
      "groupId",
      "contract",
      "origin",
      "sharingMode",
      "provider",
      "providerResourceId",
      "providerMaterializationId",
      "lifecycleJson",
      "schemaOwnerJson",
      "propertiesJson",
      "updatedAt",
    ],
    returns: "ResourceInstance",
  },
  {
    id: "resources.bindings.insert",
    domain: "resources",
    object: "resource_binding",
    operation: "insert",
    sql:
      "insert into resource_bindings (id, space_id, group_id, claim_address, instance_id, role, created_at, updated_at) values (:id, :spaceId, :groupId, :claimAddress, :instanceId, :role, :createdAt, :updatedAt)",
    parameters: [
      "id",
      "spaceId",
      "groupId",
      "claimAddress",
      "instanceId",
      "role",
      "createdAt",
      "updatedAt",
    ],
    returns: "ResourceBinding",
    notes: "Idempotent create returns existing row when id already exists.",
  },
  {
    id: "resources.bindings.get",
    domain: "resources",
    object: "resource_binding",
    operation: "select",
    sql: "select * from resource_bindings where id = :id",
    parameters: ["id"],
    returns: "ResourceBinding | undefined",
  },
  {
    id: "resources.bindings.find_by_claim",
    domain: "resources",
    object: "resource_binding",
    operation: "select",
    sql:
      "select * from resource_bindings where group_id = :groupId and claim_address = :claimAddress",
    parameters: ["groupId", "claimAddress"],
    returns: "ResourceBinding | undefined",
  },
  {
    id: "resources.bindings.list_by_group",
    domain: "resources",
    object: "resource_binding",
    operation: "list",
    sql:
      "select * from resource_bindings where group_id = :groupId order by created_at asc, id asc",
    parameters: ["groupId"],
    returns: "readonly ResourceBinding[]",
  },
  {
    id: "resources.bindings.list_by_instance",
    domain: "resources",
    object: "resource_binding",
    operation: "list",
    sql:
      "select * from resource_bindings where instance_id = :instanceId order by created_at asc, id asc",
    parameters: ["instanceId"],
    returns: "readonly ResourceBinding[]",
  },
  {
    id: "resources.binding_set_revisions.insert",
    domain: "resources",
    object: "binding_set_revision",
    operation: "insert",
    sql:
      "insert into resource_binding_set_revisions (id, space_id, group_id, binding_value_resolutions_json, created_at) values (:id, :spaceId, :groupId, :bindingValueResolutionsJson, :createdAt)",
    parameters: [
      "id",
      "spaceId",
      "groupId",
      "bindingValueResolutionsJson",
      "createdAt",
    ],
    returns: "BindingSetRevision",
  },
  {
    id: "resources.binding_set_revisions.get",
    domain: "resources",
    object: "binding_set_revision",
    operation: "select",
    sql: "select * from resource_binding_set_revisions where id = :id",
    parameters: ["id"],
    returns: "BindingSetRevision | undefined",
  },
  {
    id: "resources.binding_set_revisions.list_by_group",
    domain: "resources",
    object: "binding_set_revision",
    operation: "list",
    sql:
      "select * from resource_binding_set_revisions where group_id = :groupId order by created_at asc, id asc",
    parameters: ["groupId"],
    returns: "readonly BindingSetRevision[]",
  },
  {
    id: "resources.migration_ledger.append",
    domain: "resources",
    object: "migration_ledger_entry",
    operation: "append",
    sql:
      "insert into resource_migration_ledger (id, space_id, resource_instance_id, migration_ref, from_version, to_version, status, checkpoints_json, started_at, completed_at, metadata_json) values (:id, :spaceId, :resourceInstanceId, :migrationRef, :fromVersion, :toVersion, :status, :checkpointsJson, :startedAt, :completedAt, :metadataJson)",
    parameters: [
      "id",
      "spaceId",
      "resourceInstanceId",
      "migrationRef",
      "fromVersion",
      "toVersion",
      "status",
      "checkpointsJson",
      "startedAt",
      "completedAt",
      "metadataJson",
    ],
    returns: "MigrationLedgerEntry",
    notes: "Append is idempotent by id.",
  },
  {
    id: "resources.migration_ledger.get",
    domain: "resources",
    object: "migration_ledger_entry",
    operation: "select",
    sql: "select * from resource_migration_ledger where id = :id",
    parameters: ["id"],
    returns: "MigrationLedgerEntry | undefined",
  },
  {
    id: "resources.migration_ledger.list_by_resource",
    domain: "resources",
    object: "migration_ledger_entry",
    operation: "list",
    sql:
      "select * from resource_migration_ledger where resource_instance_id = :instanceId order by started_at asc, id asc",
    parameters: ["instanceId"],
    returns: "readonly MigrationLedgerEntry[]",
  },
];

const registry: readonly StorageStatementDescription[] = [
  {
    id: "registry.package_descriptors.upsert",
    domain: "registry",
    object: "package_descriptor",
    operation: "upsert",
    sql:
      "insert into registry_package_descriptors (kind, ref, digest, publisher, version, body_json, published_at) values (:kind, :ref, :digest, :publisher, :version, :bodyJson, :publishedAt) on conflict (kind, ref, digest) do update set publisher = excluded.publisher, version = excluded.version, body_json = excluded.body_json, published_at = excluded.published_at",
    parameters: [
      "kind",
      "ref",
      "digest",
      "publisher",
      "version",
      "bodyJson",
      "publishedAt",
    ],
    returns: "PackageDescriptor",
  },
  {
    id: "registry.package_descriptors.get",
    domain: "registry",
    object: "package_descriptor",
    operation: "select",
    sql:
      "select * from registry_package_descriptors where kind = :kind and ref = :ref and digest = :digest",
    parameters: ["kind", "ref", "digest"],
    returns: "PackageDescriptor | undefined",
  },
  {
    id: "registry.package_descriptors.list_by_ref",
    domain: "registry",
    object: "package_descriptor",
    operation: "list",
    sql:
      "select * from registry_package_descriptors where kind = :kind and ref = :ref order by published_at asc, digest asc",
    parameters: ["kind", "ref"],
    returns: "readonly PackageDescriptor[]",
  },
  {
    id: "registry.package_resolutions.upsert",
    domain: "registry",
    object: "package_resolution",
    operation: "upsert",
    sql:
      "insert into registry_package_resolutions (kind, ref, digest, registry, trust_record_id, resolved_at) values (:kind, :ref, :digest, :registry, :trustRecordId, :resolvedAt) on conflict (kind, ref, digest) do update set registry = excluded.registry, trust_record_id = excluded.trust_record_id, resolved_at = excluded.resolved_at",
    parameters: [
      "kind",
      "ref",
      "digest",
      "registry",
      "trustRecordId",
      "resolvedAt",
    ],
    returns: "PackageResolution",
  },
  {
    id: "registry.package_resolutions.get",
    domain: "registry",
    object: "package_resolution",
    operation: "select",
    sql:
      "select * from registry_package_resolutions where kind = :kind and ref = :ref and digest = :digest",
    parameters: ["kind", "ref", "digest"],
    returns: "PackageResolution | undefined",
  },
  {
    id: "registry.package_resolutions.list_by_ref",
    domain: "registry",
    object: "package_resolution",
    operation: "list",
    sql:
      "select * from registry_package_resolutions where kind = :kind and ref = :ref order by resolved_at asc, digest asc",
    parameters: ["kind", "ref"],
    returns: "readonly PackageResolution[]",
  },
  {
    id: "registry.trust_records.upsert",
    domain: "registry",
    object: "trust_record",
    operation: "upsert",
    sql:
      "insert into registry_trust_records (id, package_ref, package_digest, package_kind, trust_level, status, conformance_tier, verified_by, verified_at, revoked_at, reason) values (:id, :packageRef, :packageDigest, :packageKind, :trustLevel, :status, :conformanceTier, :verifiedBy, :verifiedAt, :revokedAt, :reason) on conflict (id) do update set trust_level = excluded.trust_level, status = excluded.status, conformance_tier = excluded.conformance_tier, revoked_at = excluded.revoked_at, reason = excluded.reason",
    parameters: [
      "id",
      "packageRef",
      "packageDigest",
      "packageKind",
      "trustLevel",
      "status",
      "conformanceTier",
      "verifiedBy",
      "verifiedAt",
      "revokedAt",
      "reason",
    ],
    returns: "TrustRecord",
  },
  {
    id: "registry.trust_records.get",
    domain: "registry",
    object: "trust_record",
    operation: "select",
    sql: "select * from registry_trust_records where id = :id",
    parameters: ["id"],
    returns: "TrustRecord | undefined",
  },
  {
    id: "registry.trust_records.find_for_package",
    domain: "registry",
    object: "trust_record",
    operation: "select",
    sql:
      "select * from registry_trust_records where package_kind = :kind and package_ref = :ref and package_digest = :digest order by verified_at desc, id desc limit 1",
    parameters: ["kind", "ref", "digest"],
    returns: "TrustRecord | undefined",
  },
];

const audit: readonly StorageStatementDescription[] = [
  {
    id: "audit.events.append",
    domain: "audit",
    object: "audit_event",
    operation: "append",
    sql:
      "insert into audit_events (id, event_class, type, severity, actor_json, space_id, group_id, target_type, target_id, payload_json, occurred_at, request_id, correlation_id) values (:id, :eventClass, :type, :severity, :actorJson, :spaceId, :groupId, :targetType, :targetId, :payloadJson, :occurredAt, :requestId, :correlationId)",
    parameters: [
      "id",
      "eventClass",
      "type",
      "severity",
      "actorJson",
      "spaceId",
      "groupId",
      "targetType",
      "targetId",
      "payloadJson",
      "occurredAt",
      "requestId",
      "correlationId",
    ],
    returns: "AuditEvent",
    notes: "Append is idempotent by id and preserves insertion order for list.",
  },
  {
    id: "audit.events.get",
    domain: "audit",
    object: "audit_event",
    operation: "select",
    sql: "select * from audit_events where id = :id",
    parameters: ["id"],
    returns: "AuditEvent | undefined",
  },
  {
    id: "audit.events.list",
    domain: "audit",
    object: "audit_event",
    operation: "list",
    sql:
      "select * from audit_events where (:spaceId is null or space_id = :spaceId) and (:groupId is null or group_id = :groupId) and (:targetType is null or target_type = :targetType) and (:targetId is null or target_id = :targetId) and (:type is null or type = :type) and (:since is null or occurred_at >= :since) and (:until is null or occurred_at <= :until) order by occurred_at asc, id asc",
    parameters: [
      "spaceId",
      "groupId",
      "targetType",
      "targetId",
      "type",
      "since",
      "until",
    ],
    returns: "readonly AuditEvent[]",
  },
];

const usage: readonly StorageStatementDescription[] = [
  {
    id: "usage.aggregates.record_event",
    domain: "usage",
    object: "usage_aggregate",
    operation: "upsert",
    sql:
      "insert into usage_aggregates (id, space_id, group_id, owner_kind, metric, unit, quantity, event_count, first_occurred_at, last_occurred_at, updated_at) values (:id, :spaceId, :groupId, :ownerKind, :metric, :unit, :quantity, :eventCount, :firstOccurredAt, :lastOccurredAt, :updatedAt) on conflict (id) do update set quantity = excluded.quantity, event_count = excluded.event_count, first_occurred_at = excluded.first_occurred_at, last_occurred_at = excluded.last_occurred_at, updated_at = excluded.updated_at",
    parameters: [
      "id",
      "spaceId",
      "groupId",
      "ownerKind",
      "metric",
      "unit",
      "quantity",
      "eventCount",
      "firstOccurredAt",
      "lastOccurredAt",
      "updatedAt",
    ],
    returns: "UsageAggregate",
  },
  {
    id: "usage.aggregates.get",
    domain: "usage",
    object: "usage_aggregate",
    operation: "select",
    sql: "select * from usage_aggregates where id = :id",
    parameters: ["id"],
    returns: "UsageAggregate | undefined",
  },
];

const serviceEndpoints: readonly StorageStatementDescription[] = [
  {
    id: "service_endpoints.endpoints.put",
    domain: "service-endpoints",
    object: "service_endpoint",
    operation: "upsert",
    sql:
      "insert into service_endpoints (id, service_id, space_id, group_id, endpoint_json, updated_at) values (:id, :serviceId, :spaceId, :groupId, :endpointJson, :updatedAt) on conflict (id) do update set endpoint_json = excluded.endpoint_json, updated_at = excluded.updated_at",
    parameters: [
      "id",
      "serviceId",
      "spaceId",
      "groupId",
      "endpointJson",
      "updatedAt",
    ],
    returns: "ServiceEndpoint",
  },
  {
    id: "service_endpoints.trust_records.put",
    domain: "service-endpoints",
    object: "service_trust_record",
    operation: "upsert",
    sql:
      "insert into service_trust_records (id, endpoint_id, trust_record_json, updated_at) values (:id, :endpointId, :trustRecordJson, :updatedAt) on conflict (id) do update set trust_record_json = excluded.trust_record_json, updated_at = excluded.updated_at",
    parameters: ["id", "endpointId", "trustRecordJson", "updatedAt"],
    returns: "ServiceTrustRecord",
  },
  {
    id: "service_endpoints.grants.put",
    domain: "service-endpoints",
    object: "service_grant",
    operation: "upsert",
    sql:
      "insert into service_grants (id, trust_record_id, subject, grant_json) values (:id, :trustRecordId, :subject, :grantJson) on conflict (id) do update set grant_json = excluded.grant_json",
    parameters: ["id", "trustRecordId", "subject", "grantJson"],
    returns: "ServiceGrant",
  },
];

export const storageStatementCatalog: StorageStatementCatalog = Object.freeze({
  space,
  deploy,
  runtime,
  resources,
  registry,
  audit,
  usage,
  serviceEndpoints,
  all: Object.freeze([
    ...space,
    ...deploy,
    ...runtime,
    ...resources,
    ...registry,
    ...audit,
    ...usage,
    ...serviceEndpoints,
  ]),
});
