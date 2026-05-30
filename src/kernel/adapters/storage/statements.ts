export type StorageDomain =
  | "core"
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
  readonly core: readonly StorageStatementDescription[];
  readonly deploy: readonly StorageStatementDescription[];
  readonly runtime: readonly StorageStatementDescription[];
  readonly resources: readonly StorageStatementDescription[];
  readonly registry: readonly StorageStatementDescription[];
  readonly audit: readonly StorageStatementDescription[];
  readonly usage: readonly StorageStatementDescription[];
  readonly serviceEndpoints: readonly StorageStatementDescription[];
  readonly all: readonly StorageStatementDescription[];
}

const core: readonly StorageStatementDescription[] = [
  {
    id: "core.spaces.insert",
    domain: "core",
    object: "space",
    operation: "insert",
    sql:
      "insert into core_spaces (id, name, metadata_json, created_by_account_id, created_at, updated_at) values (:id, :name, :metadataJson, :createdByAccountId, :createdAt, :updatedAt)",
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
    id: "core.spaces.get",
    domain: "core",
    object: "space",
    operation: "select",
    sql:
      "select id, name, metadata_json, created_by_account_id, created_at, updated_at from core_spaces where id = :spaceId",
    parameters: ["spaceId"],
    returns: "Space | undefined",
  },
  {
    id: "core.spaces.list",
    domain: "core",
    object: "space",
    operation: "list",
    sql:
      "select id, name, metadata_json, created_by_account_id, created_at, updated_at from core_spaces order by created_at asc, id asc",
    parameters: [],
    returns: "readonly Space[]",
  },
  {
    id: "core.groups.insert",
    domain: "core",
    object: "group",
    operation: "insert",
    sql:
      "insert into core_groups (id, space_id, slug, display_name, metadata_json, created_by_account_id, created_at, updated_at) values (:id, :spaceId, :slug, :displayName, :metadataJson, :createdByAccountId, :createdAt, :updatedAt)",
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
    id: "core.groups.get",
    domain: "core",
    object: "group",
    operation: "select",
    sql:
      "select id, space_id, slug, display_name, metadata_json, created_by_account_id, created_at, updated_at from core_groups where id = :groupId",
    parameters: ["groupId"],
    returns: "Group | undefined",
  },
  {
    id: "core.groups.find_by_slug",
    domain: "core",
    object: "group",
    operation: "select",
    sql:
      "select id, space_id, slug, display_name, metadata_json, created_by_account_id, created_at, updated_at from core_groups where space_id = :spaceId and slug = :slug",
    parameters: ["spaceId", "slug"],
    returns: "Group | undefined",
  },
  {
    id: "core.groups.list_by_space",
    domain: "core",
    object: "group",
    operation: "list",
    sql:
      "select id, space_id, slug, display_name, metadata_json, created_by_account_id, created_at, updated_at from core_groups where space_id = :spaceId order by created_at asc, id asc",
    parameters: ["spaceId"],
    returns: "readonly Group[]",
  },
  {
    id: "core.space_memberships.upsert",
    domain: "core",
    object: "space_membership",
    operation: "upsert",
    sql:
      "insert into core_space_memberships (id, space_id, account_id, roles_json, status, created_at, updated_at) values (:id, :spaceId, :accountId, :rolesJson, :status, :createdAt, :updatedAt) on conflict (space_id, account_id) do update set roles_json = excluded.roles_json, status = excluded.status, updated_at = excluded.updated_at",
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
    id: "core.space_memberships.get",
    domain: "core",
    object: "space_membership",
    operation: "select",
    sql:
      "select id, space_id, account_id, roles_json, status, created_at, updated_at from core_space_memberships where space_id = :spaceId and account_id = :accountId",
    parameters: ["spaceId", "accountId"],
    returns: "SpaceMembership | undefined",
  },
  {
    id: "core.space_memberships.list_by_space",
    domain: "core",
    object: "space_membership",
    operation: "list",
    sql:
      "select id, space_id, account_id, roles_json, status, created_at, updated_at from core_space_memberships where space_id = :spaceId order by created_at asc, id asc",
    parameters: ["spaceId"],
    returns: "readonly SpaceMembership[]",
  },
];

const deploy: readonly StorageStatementDescription[] = [
  {
    id: "deploy.deployments.put",
    domain: "deploy",
    object: "deployment",
    operation: "upsert",
    sql:
      "insert into deployments (id, group_id, space_id, input_json, resolution_json, desired_json, status, conditions_json, policy_decisions_json, approval_json, rollback_target, created_at, applied_at, finalized_at) values (:id, :groupId, :spaceId, :inputJson, :resolutionJson, :desiredJson, :status, :conditionsJson, :policyDecisionsJson, :approvalJson, :rollbackTarget, :createdAt, :appliedAt, :finalizedAt) on conflict (id) do update set group_id = excluded.group_id, space_id = excluded.space_id, input_json = excluded.input_json, resolution_json = excluded.resolution_json, desired_json = excluded.desired_json, status = excluded.status, conditions_json = excluded.conditions_json, policy_decisions_json = excluded.policy_decisions_json, approval_json = excluded.approval_json, rollback_target = excluded.rollback_target, applied_at = excluded.applied_at, finalized_at = excluded.finalized_at",
    parameters: [
      "id",
      "groupId",
      "spaceId",
      "inputJson",
      "resolutionJson",
      "desiredJson",
      "status",
      "conditionsJson",
      "policyDecisionsJson",
      "approvalJson",
      "rollbackTarget",
      "createdAt",
      "appliedAt",
      "finalizedAt",
    ],
    returns: "Deployment",
    notes: "Canonical deployment record.",
  },
  {
    id: "deploy.deployments.get",
    domain: "deploy",
    object: "deployment",
    operation: "select",
    sql:
      "select id, group_id, space_id, input_json, resolution_json, desired_json, status, conditions_json, policy_decisions_json, approval_json, rollback_target, created_at, applied_at, finalized_at from deployments where id = :id",
    parameters: ["id"],
    returns: "Deployment | undefined",
  },
  {
    id: "deploy.deployments.list",
    domain: "deploy",
    object: "deployment",
    operation: "list",
    sql:
      "select id, group_id, space_id, input_json, resolution_json, desired_json, status, conditions_json, policy_decisions_json, approval_json, rollback_target, created_at, applied_at, finalized_at from deployments where (:spaceId is null or space_id = :spaceId) and (:groupId is null or group_id = :groupId) and (:status is null or status = :status) order by created_at asc, id asc limit coalesce(:limit, 9223372036854775807)",
    parameters: ["spaceId", "groupId", "status", "limit"],
    returns: "readonly Deployment[]",
  },
  {
    id: "deploy.group_heads.upsert",
    domain: "deploy",
    object: "group_head",
    operation: "upsert",
    sql:
      "insert into group_heads (space_id, group_id, current_deployment_id, previous_deployment_id, generation, advanced_at) values (:spaceId, :groupId, :currentDeploymentId, :previousDeploymentId, :generation, :advancedAt) on conflict (space_id, group_id) do update set current_deployment_id = excluded.current_deployment_id, previous_deployment_id = excluded.previous_deployment_id, generation = excluded.generation, advanced_at = excluded.advanced_at",
    parameters: [
      "spaceId",
      "groupId",
      "currentDeploymentId",
      "previousDeploymentId",
      "generation",
      "advancedAt",
    ],
    returns: "GroupHead",
    notes:
      "current_deployment_id and previous_deployment_id reference deployments(id).",
  },
  {
    id: "deploy.group_heads.get",
    domain: "deploy",
    object: "group_head",
    operation: "select",
    sql:
      "select space_id, group_id, current_deployment_id, previous_deployment_id, generation, advanced_at from group_heads where space_id = :spaceId and group_id = :groupId",
    parameters: ["spaceId", "groupId"],
    returns: "GroupHead | undefined",
  },
  {
    id: "deploy.provider_observations.record",
    domain: "deploy",
    object: "provider_observation",
    operation: "append",
    sql:
      "insert into provider_observations (id, deployment_id, provider_id, object_address, observed_state, drift_status, observed_digest, observed_state_json, observed_at) values (:id, :deploymentId, :providerId, :objectAddress, :observedState, :driftStatus, :observedDigest, :observedStateJson, :observedAt)",
    parameters: [
      "id",
      "deploymentId",
      "providerId",
      "objectAddress",
      "observedState",
      "driftStatus",
      "observedDigest",
      "observedStateJson",
      "observedAt",
    ],
    returns: "ProviderObservation",
  },
  {
    id: "deploy.provider_observations.list",
    domain: "deploy",
    object: "provider_observation",
    operation: "list",
    sql:
      "select id, deployment_id, provider_id, object_address, observed_state, drift_status, observed_digest, observed_state_json, observed_at from provider_observations where (:deploymentId is null or deployment_id = :deploymentId) and (:providerId is null or provider_id = :providerId) order by observed_at asc, id asc limit coalesce(:limit, 9223372036854775807)",
    parameters: ["deploymentId", "providerId", "limit"],
    returns: "readonly ProviderObservation[]",
  },
];

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
  core,
  deploy,
  runtime,
  resources,
  registry,
  audit,
  usage,
  serviceEndpoints,
  all: Object.freeze([
    ...core,
    ...deploy,
    ...runtime,
    ...resources,
    ...registry,
    ...audit,
    ...usage,
    ...serviceEndpoints,
  ]),
});
