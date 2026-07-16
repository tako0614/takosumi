import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { deployControlD1TableNames as names } from "./logical.ts";

const jsonText = (name: string) =>
  text(name, { mode: "json" }).$type<unknown>();

export const runnerProfiles = sqliteTable(names.runnerProfiles, {
  id: text("id").primaryKey(),
  recordJson: jsonText("record_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const workspaces = sqliteTable(
  names.workspaces,
  {
    id: text("id").primaryKey(),
    handle: text("handle").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("workspaces_handle_unique").on(table.handle)],
);

export const workspaceMembers = sqliteTable(
  names.workspaceMembers,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    accountId: text("account_id").notNull(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("workspace_members_workspace_account_unique").on(
      table.workspaceId,
      table.accountId,
    ),
    index("workspace_members_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    index("workspace_members_account_status_idx").on(
      table.accountId,
      table.status,
    ),
  ],
);

// P4 17-noun rename: NEW Workspace-owned Project grouping. Capsules live under a
// Project (`capsules.project_id`); a default Project is backfilled per Workspace
// so pre-Project Capsules keep a stable owner.
export const projects = sqliteTable(
  names.projects,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("projects_workspace_slug_unique").on(
      table.workspaceId,
      table.slug,
    ),
    index("projects_workspace_idx").on(table.workspaceId),
  ],
);

export const sources = sqliteTable(
  names.sources,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("sources_space_idx").on(table.workspaceId),
    index("sources_status_idx").on(table.status),
  ],
);

export const sourceSnapshots = sqliteTable(
  names.sourceSnapshots,
  {
    id: text("id").primaryKey(),
    // Physically nullable only for historical pre-Git-only rows. Current
    // writers and row mappers require a registered Git Source.
    sourceId: text("source_id"),
    recordJson: jsonText("record_json").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [index("source_snapshots_source_idx").on(table.sourceId)],
);

export const connections = sqliteTable(
  names.connections,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id"),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    connectionJson: jsonText("connection_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("connections_space_idx").on(table.workspaceId),
    index("connections_provider_idx").on(table.provider),
    index("connections_status_idx").on(table.status),
  ],
);

export const secretBlobs = sqliteTable(
  names.secretBlobs,
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    workspaceId: text("space_id"),
    kind: text("kind").notNull(),
    ciphertext: text("ciphertext").notNull(),
    encryptedDek: text("encrypted_dek").notNull(),
    nonce: text("nonce").notNull(),
    aad: text("aad").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: text("created_at").notNull(),
    rotatedAt: text("rotated_at"),
    blobJson: jsonText("blob_json").notNull(),
  },
  (table) => [
    uniqueIndex("secret_blobs_connection_idx").on(table.connectionId),
  ],
);

export const installConfigs = sqliteTable(
  names.installConfigs,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id"),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("install_configs_space_idx").on(table.workspaceId)],
);

export const capsules = sqliteTable(
  names.capsules,
  {
    id: text("id").primaryKey(),
    // P4 column decision (D1 capsules): space_id, current_output_snapshot_id and
    // The slug remains physical for uniqueness. The retired install_type
    // discriminator is deliberately absent from the current schema.
    //   - current_deployment_id -> current_state_version_id (historical
    //     value-translation target; the current property and column use the
    //     StateVersion name).
    //   - project_id ADDED (Workspace-owned Project pointer, backfilled).
    workspaceId: text("space_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Historical source-less rows may remain physically readable for operator
    // migration, but current Capsule writes and public contracts require Git.
    sourceId: text("source_id"),
    installConfigId: text("install_config_id").notNull(),
    environment: text("environment").notNull(),
    currentStateVersionId: text("current_state_version_id"),
    currentStateGeneration: integer("current_state_generation")
      .notNull()
      .default(0),
    currentOutputId: text("current_output_snapshot_id"),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("capsules_project_name_environment_active_unique")
      .on(table.projectId, table.name, table.environment)
      .where(sql`${table.status} <> 'destroyed'`),
    index("capsules_space_idx").on(table.workspaceId),
    index("capsules_project_idx").on(table.projectId),
    index("capsules_current_state_version_idx").on(table.currentStateVersionId),
  ],
);

export const capsuleCompatibilityReports = sqliteTable(
  names.capsuleCompatibilityReports,
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id"),
    capsuleId: text("installation_id"),
    sourceSnapshotId: text("source_snapshot_id").notNull(),
    level: text("level").notNull(),
    findingsJson: jsonText("findings_json").notNull(),
    providersJson: jsonText("providers_json").notNull(),
    resourcesJson: jsonText("resources_json").notNull(),
    dataSourcesJson: jsonText("data_sources_json").notNull(),
    provisionersJson: jsonText("provisioners_json").notNull(),
    rootModuleVariablesJson: jsonText("root_module_variables_json")
      .notNull()
      .default([]),
    rootModuleOutputsJson: jsonText("root_module_outputs_json")
      .notNull()
      .default([]),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("capsule_compatibility_reports_source_snapshot_idx").on(
      table.sourceSnapshotId,
    ),
    index("capsule_compatibility_reports_source_idx").on(table.sourceId),
    index("capsule_compatibility_reports_installation_idx").on(table.capsuleId),
    index("capsule_compatibility_reports_level_idx").on(table.level),
  ],
);

export const providerBindingSets = sqliteTable(
  names.providerBindingSets,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("provider_env_binding_sets_installation_environment_unique").on(
      table.capsuleId,
      table.environment,
    ),
    index("provider_env_binding_sets_installation_idx").on(table.capsuleId),
  ],
);

export const dependencies = sqliteTable(
  names.dependencies,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    producerCapsuleId: text("producer_installation_id").notNull(),
    consumerCapsuleId: text("consumer_installation_id").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("installation_dependencies_space_idx").on(table.workspaceId),
    index("installation_dependencies_producer_idx").on(table.producerCapsuleId),
    index("installation_dependencies_consumer_idx").on(table.consumerCapsuleId),
  ],
);

export const dependencySnapshots = sqliteTable(
  names.dependencySnapshots,
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("dependency_snapshots_run_idx").on(table.runId)],
);

export const outputs = sqliteTable(
  names.outputs,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id").notNull(),
    stateGeneration: integer("state_generation").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("outputs_installation_idx").on(table.capsuleId)],
);

export const outputShares = sqliteTable(
  names.outputShares,
  {
    id: text("id").primaryKey(),
    fromWorkspaceId: text("from_space_id").notNull(),
    toWorkspaceId: text("to_space_id").notNull(),
    producerCapsuleId: text("producer_installation_id").notNull(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("output_shares_from_space_idx").on(table.fromWorkspaceId),
    index("output_shares_to_space_idx").on(table.toWorkspaceId),
    index("output_shares_producer_idx").on(table.producerCapsuleId),
  ],
);

export const runGroups = sqliteTable(
  names.runGroups,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    type: text("type").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("run_groups_space_idx").on(table.workspaceId)],
);

export const runs = sqliteTable(
  names.runs,
  {
    id: text("id").primaryKey(),
    runGroupId: text("run_group_id"),
    workspaceId: text("space_id").notNull(),
    sourceId: text("source_id"),
    capsuleId: text("installation_id"),
    environment: text("environment"),
    type: text("type").notNull(),
    status: text("status").notNull(),
    leaseToken: text("lease_token"),
    heartbeatAt: integer("heartbeat_at"),
    runJson: jsonText("run_json").notNull(),
    createdAt: text("created_at").notNull().default(""),
  },
  (table) => [
    index("runs_space_idx").on(table.workspaceId),
    index("runs_source_idx").on(table.sourceId),
    index("runs_installation_idx").on(table.capsuleId),
    index("runs_installation_created_at_idx").on(
      table.capsuleId,
      table.createdAt,
    ),
    index("runs_type_idx").on(table.type),
    index("runs_created_at_idx").on(table.createdAt),
  ],
);

export const planRunInputs = sqliteTable(names.planRunInputs, {
  planRunId: text("plan_run_id").primaryKey(),
  inputsJson: jsonText("inputs_json").notNull(),
});

export const stateVersions = sqliteTable(
  names.stateVersions,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    generation: integer("generation").notNull(),
    stateRef: text("object_key").notNull(),
    digest: text("digest").notNull(),
    createdByRunId: text("created_by_run_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("state_versions_installation_environment_generation_unique").on(
      table.capsuleId,
      table.environment,
      table.generation,
    ),
    index("state_versions_installation_idx").on(table.capsuleId),
  ],
);

export const artifacts = sqliteTable(
  names.artifacts,
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    kind: text("kind").notNull(),
    ref: text("object_key").notNull(),
    digest: text("digest").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("artifacts_run_idx").on(table.runId)],
);

export const usageEvents = sqliteTable(
  names.usageEvents,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    capsuleId: text("capsule_id"),
    runId: text("run_id"),
    meterId: text("meter_id"),
    resourceFamily: text("resource_family"),
    resourceId: text("resource_id"),
    operation: text("operation"),
    resourceMetadataJson: jsonText("resource_metadata_json"),
    kind: text("kind").notNull(),
    quantity: real("quantity").notNull(),
    usdMicros: integer("usd_micros").notNull(),
    ratingStatus: text("rating_status").notNull(),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("usage_events_workspace_idx").on(table.workspaceId),
    index("usage_events_run_idx").on(table.runId),
    uniqueIndex("usage_events_idempotency_key_unique").on(table.idempotencyKey),
  ],
);

export const publicHostReservations = sqliteTable(
  names.publicHostReservations,
  {
    hostname: text("hostname").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    capsuleId: text("installation_id").notNull(),
    capsuleName: text("installation_name").notNull(),
    allocationKind: text("allocation_kind").notNull(),
    status: text("status").notNull(),
    reservedAt: text("reserved_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    releasedAt: text("released_at"),
  },
  (table) => [
    index("public_host_reservations_workspace_idx").on(table.workspaceId),
    index("public_host_reservations_owner_kind_idx").on(
      table.ownerUserId,
      table.allocationKind,
      table.status,
    ),
    index("public_host_reservations_installation_idx").on(table.capsuleId),
    index("public_host_reservations_status_idx").on(table.status),
  ],
);

export const credentialMintEvents = sqliteTable(
  names.credentialMintEvents,
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id"),
    sourceId: text("source_id"),
    connectionId: text("connection_id").notNull(),
    phase: text("phase").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("credential_mint_events_run_idx").on(table.runId),
    index("credential_mint_events_space_idx").on(table.workspaceId),
    index("credential_mint_events_source_idx").on(table.sourceId),
  ],
);

export const securityFindings = sqliteTable(
  names.securityFindings,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id"),
    runId: text("run_id"),
    severity: text("severity").notNull(),
    type: text("type").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("security_findings_space_idx").on(table.workspaceId),
    index("security_findings_run_idx").on(table.runId),
    index("security_findings_severity_idx").on(table.severity),
  ],
);

export const auditEvents = sqliteTable(
  names.auditEvents,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    runId: text("run_id"),
    createdAt: text("created_at").notNull(),
    recordJson: jsonText("record_json").notNull(),
  },
  (table) => [
    index("audit_events_space_idx").on(table.workspaceId),
    index("audit_events_space_target_created_id_idx").on(
      table.workspaceId,
      table.targetType,
      table.targetId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const backups = sqliteTable(
  names.backups,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id"),
    environment: text("environment"),
    createdByRunId: text("created_by_run_id"),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("backups_space_idx").on(table.workspaceId),
    index("backups_installation_idx").on(table.capsuleId),
  ],
);

// --- Resource Shape flow (`takosumi.dev/v1alpha1`) ---------------------------
//
// Columnar projections of the public Resource / ResolutionLock / TargetPool /
// SpacePolicy objects. Complex sub-objects (spec / outputs / conditions /
// labels / reason / native resources) are TEXT JSON columns; the indexed
// columns drive name / space lookups. Booleans persist as 0/1 integers.

export const resourceShapes = sqliteTable(
  names.resourceShapes,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    project: text("project"),
    environment: text("environment"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    managedBy: text("managed_by").notNull(),
    specJson: jsonText("spec_json").notNull(),
    phase: text("phase").notNull(),
    generation: integer("generation").notNull(),
    observedGeneration: integer("observed_generation").notNull(),
    outputsJson: jsonText("outputs_json"),
    executionJson: jsonText("execution_json"),
    stateAdoptionJson: jsonText("state_adoption_json"),
    conditionsJson: jsonText("conditions_json"),
    labelsJson: jsonText("labels_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    observationLeaseId: text("observation_lease_id"),
    observationClaimedAt: text("observation_claimed_at"),
    lastObservationAttemptAt: text("last_observation_attempt_at"),
    // v46 is additive; keep append order aligned with upgraded databases.
    formRefJson: jsonText("form_ref_json"),
    packageDigest: text("package_digest"),
  },
  (table) => [
    uniqueIndex("resource_shapes_space_kind_name_unique").on(
      table.spaceId,
      table.kind,
      table.name,
    ),
    index("resource_shapes_space_idx").on(table.spaceId),
    index("resource_shapes_space_created_id_idx").on(
      table.spaceId,
      table.createdAt,
      table.id,
    ),
    index("resource_shapes_ready_kind_created_id_idx").on(
      table.kind,
      table.phase,
      table.createdAt,
      table.id,
    ),
    index("resource_shapes_observation_due_idx").on(
      table.phase,
      table.lastObservationAttemptAt,
      table.observationClaimedAt,
      table.id,
    ),
    index("resource_shapes_unpinned_form_kind_id_idx")
      .on(table.kind, table.id)
      .where(sql`${table.formRefJson} is null`),
  ],
);

export const resolutionLocks = sqliteTable(
  names.resolutionLocks,
  {
    resourceId: text("resource_id").primaryKey(),
    selectedImplementation: text("selected_implementation").notNull(),
    targetPool: text("target_pool"),
    target: text("target").notNull(),
    targetSnapshotJson: jsonText("target_snapshot_json"),
    implementationSnapshotJson: jsonText("implementation_snapshot_json"),
    implementationPlugin: text("implementation_plugin"),
    implementationOptionsJson: jsonText("implementation_options_json"),
    implementationFingerprint: text("implementation_fingerprint"),
    locked: integer("locked").notNull(),
    reasonJson: jsonText("reason_json").notNull(),
    portability: text("portability"),
    nativeResourcesJson: jsonText("native_resources_json"),
    lockedAt: text("locked_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // v46 is additive; keep append order aligned with upgraded databases.
    formRefJson: jsonText("form_ref_json"),
    packageDigest: text("package_digest"),
  },
  (table) => [
    index("resolution_locks_unpinned_form_resource_idx")
      .on(table.resourceId)
      .where(sql`${table.formRefJson} is null`),
  ],
);

export const targetPools = sqliteTable(
  names.targetPools,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    name: text("name").notNull(),
    specJson: jsonText("spec_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("target_pools_space_name_unique").on(table.spaceId, table.name),
    index("target_pools_space_idx").on(table.spaceId),
    index("target_pools_space_created_id_idx").on(
      table.spaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const spacePolicies = sqliteTable(
  names.spacePolicies,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    name: text("name").notNull(),
    specJson: jsonText("spec_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("space_policies_space_name_unique").on(
      table.spaceId,
      table.name,
    ),
    index("space_policies_space_idx").on(table.spaceId),
  ],
);

export const interfaces = sqliteTable(
  names.interfaces,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    interfaceType: text("interface_type").notNull(),
    phase: text("phase").notNull(),
    generation: integer("generation").notNull(),
    resolvedRevision: integer("resolved_revision").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("interfaces_active_name_unique")
      .on(table.workspaceId, table.ownerKind, table.ownerId, table.name)
      .where(sql`${table.phase} <> 'Retired'`),
    index("interfaces_workspace_type_phase_idx").on(
      table.workspaceId,
      table.interfaceType,
      table.phase,
    ),
  ],
);

export const interfaceBindings = sqliteTable(
  names.interfaceBindings,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    interfaceId: text("interface_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    phase: text("phase").notNull(),
    generation: integer("generation").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("interface_bindings_active_subject_unique")
      .on(table.interfaceId, table.subjectKind, table.subjectId)
      .where(sql`${table.phase} <> 'Revoked'`),
    index("interface_bindings_interface_idx").on(table.interfaceId),
    index("interface_bindings_workspace_subject_idx").on(
      table.workspaceId,
      table.subjectKind,
      table.subjectId,
    ),
  ],
);

export const serviceFormPackages = sqliteTable(
  names.serviceFormPackages,
  {
    packageDigest: text("package_digest").primaryKey(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    installedAt: text("installed_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("service_form_packages_status_updated_digest_idx").on(
      table.status,
      table.updatedAt,
      table.packageDigest,
    ),
  ],
);

export const serviceFormDefinitions = sqliteTable(
  names.serviceFormDefinitions,
  {
    formRefKey: text("form_ref_key").primaryKey(),
    packageDigest: text("package_digest").notNull(),
    apiVersion: text("api_version").notNull(),
    kind: text("kind").notNull(),
    definitionVersion: text("definition_version").notNull(),
    schemaDigest: text("schema_digest").notNull(),
    recordJson: jsonText("record_json").notNull(),
    installedAt: text("installed_at").notNull(),
  },
  (table) => [
    uniqueIndex("service_form_definitions_ref_package_unique").on(
      table.formRefKey,
      table.packageDigest,
    ),
    index("service_form_definitions_package_idx").on(table.packageDigest),
    index("service_form_definitions_kind_installed_ref_idx").on(
      table.kind,
      table.installedAt,
      table.formRefKey,
    ),
  ],
);

export const serviceFormActivations = sqliteTable(
  names.serviceFormActivations,
  {
    id: text("id").primaryKey(),
    formRefKey: text("form_ref_key").notNull(),
    packageDigest: text("package_digest").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    status: text("status").notNull(),
    revision: integer("revision").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("service_form_activations_scope_status_updated_id_idx").on(
      table.scopeType,
      table.scopeId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    index("service_form_activations_identity_idx").on(
      table.formRefKey,
      table.packageDigest,
    ),
  ],
);
