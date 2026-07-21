import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { deployControlPostgresTableNames as names } from "./logical.ts";

const json = (name: string) => jsonb(name).$type<unknown>();

export const runnerProfiles = pgTable(names.runnerProfiles, {
  id: text("id").primaryKey(),
  profileJson: json("profile_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const workspaces = pgTable(
  names.workspaces,
  {
    id: text("id").primaryKey(),
    handle: text("handle").notNull(),
    spaceJson: json("space_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_workspaces_handle_unique").on(table.handle),
  ],
);

export const workspaceMembers = pgTable(
  names.workspaceMembers,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    accountId: text("account_id").notNull(),
    status: text("status").notNull(),
    memberJson: json("member_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_workspace_members_workspace_account_unique").on(
      table.workspaceId,
      table.accountId,
    ),
    index("takosumi_workspace_members_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    index("takosumi_workspace_members_account_status_idx").on(
      table.accountId,
      table.status,
    ),
  ],
);

// P4 17-noun rename: NEW Workspace-owned Project grouping.
export const projects = pgTable(
  names.projects,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    projectJson: json("project_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_projects_workspace_slug_unique").on(
      table.workspaceId,
      table.slug,
    ),
    index("takosumi_projects_workspace_idx").on(table.workspaceId),
  ],
);

export const sources = pgTable(
  names.sources,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    status: text("status").notNull(),
    sourceJson: json("source_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_sources_space_idx").on(table.workspaceId),
    index("takosumi_sources_status_idx").on(table.status),
  ],
);

export const sourceSnapshots = pgTable(
  names.sourceSnapshots,
  {
    id: text("id").primaryKey(),
    // Physically nullable only for historical pre-Git-only rows. Current
    // writers and row mappers require a registered Git Source.
    sourceId: text("source_id"),
    snapshotJson: json("snapshot_json").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    index("takosumi_source_snapshots_source_idx").on(
      table.sourceId,
      table.fetchedAt,
    ),
  ],
);

export const connections = pgTable(
  names.connections,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id"),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    connectionJson: json("connection_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_connections_space_idx").on(table.workspaceId),
    index("takosumi_connections_status_idx").on(table.status),
  ],
);

export const secretBlobs = pgTable(
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
    blobJson: json("blob_json").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_connection_secret_blobs_connection_idx").on(
      table.connectionId,
    ),
  ],
);

export const installConfigs = pgTable(
  names.installConfigs,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id"),
    configJson: json("config_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_install_configs_space_idx").on(table.workspaceId),
    index("takosumi_install_configs_space_created_id_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const capsules = pgTable(
  names.capsules,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    environment: text("environment").notNull(),
    // Historical source-less rows may remain physically readable for operator
    // migration, but current Capsule writes and public contracts require Git.
    sourceId: text("source_id"),
    installConfigId: text("install_config_id").notNull(),
    // Historical current_deployment_id was physically renamed and translated;
    // the current property and column both point at a StateVersion.
    currentStateVersionId: text("current_state_version_id"),
    status: text("status").notNull(),
    capsuleJson: json("installation_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_capsules_project_name_environment_active_unique")
      .on(table.projectId, table.name, table.environment)
      .where(sql`${table.status} <> 'destroyed'`),
    index("takosumi_capsules_space_idx").on(table.workspaceId),
    index("takosumi_capsules_project_idx").on(table.projectId),
    index("takosumi_capsules_current_state_version_idx").on(
      table.currentStateVersionId,
    ),
    index("takosumi_capsules_created_at_idx").on(table.createdAt),
  ],
);

export const capsuleCompatibilityReports = pgTable(
  names.capsuleCompatibilityReports,
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id"),
    capsuleId: text("installation_id"),
    sourceSnapshotId: text("source_snapshot_id").notNull(),
    level: text("level").notNull(),
    findingsJson: json("findings_json").notNull(),
    providersJson: json("providers_json").notNull(),
    resourcesJson: json("resources_json").notNull(),
    dataSourcesJson: json("data_sources_json").notNull(),
    provisionersJson: json("provisioners_json").notNull(),
    rootModuleVariablesJson: json("root_module_variables_json")
      .notNull()
      .default([]),
    rootModuleOutputsJson: json("root_module_outputs_json")
      .notNull()
      .default([]),
    createdAt: text("created_at").notNull(),
    modulePath: text("module_path"),
  },
  (table) => [
    index("takosumi_capsule_compat_reports_source_snapshot_idx").on(
      table.sourceSnapshotId,
    ),
    index("takosumi_capsule_compat_reports_source_idx").on(table.sourceId),
    index("takosumi_capsule_compat_reports_installation_idx").on(
      table.capsuleId,
    ),
    index("takosumi_capsule_compat_reports_level_idx").on(table.level),
  ],
);

export const providerBindingSets = pgTable(
  names.providerBindingSets,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    profileJson: json("profile_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex(
      "takosumi_provider_env_bindings_installation_environment_unique",
    ).on(table.capsuleId, table.environment),
    index("takosumi_provider_env_bindings_installation_idx").on(
      table.capsuleId,
      table.environment,
    ),
  ],
);

export const dependencies = pgTable(
  names.dependencies,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    producerCapsuleId: text("producer_installation_id").notNull(),
    consumerCapsuleId: text("consumer_installation_id").notNull(),
    dependencyJson: json("dependency_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_installation_dependencies_space_idx").on(table.workspaceId),
    index("takosumi_installation_dependencies_producer_idx").on(
      table.producerCapsuleId,
    ),
    index("takosumi_installation_dependencies_consumer_idx").on(
      table.consumerCapsuleId,
    ),
  ],
);

export const dependencySnapshots = pgTable(
  names.dependencySnapshots,
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    snapshotJson: json("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("takosumi_dependency_snapshots_run_idx").on(table.runId)],
);

export const outputs = pgTable(
  names.outputs,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id").notNull(),
    stateGeneration: integer("state_generation").notNull(),
    snapshotJson: json("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_outputs_installation_idx").on(
      table.capsuleId,
      table.stateGeneration,
    ),
  ],
);

export const outputShares = pgTable(
  names.outputShares,
  {
    id: text("id").primaryKey(),
    fromWorkspaceId: text("from_space_id").notNull(),
    toWorkspaceId: text("to_space_id").notNull(),
    producerCapsuleId: text("producer_installation_id").notNull(),
    status: text("status").notNull(),
    shareJson: json("share_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_output_shares_from_space_idx").on(
      table.fromWorkspaceId,
      table.createdAt,
    ),
    index("takosumi_output_shares_to_space_idx").on(
      table.toWorkspaceId,
      table.createdAt,
    ),
    index("takosumi_output_shares_producer_idx").on(table.producerCapsuleId),
  ],
);

export const runGroups = pgTable(
  names.runGroups,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    type: text("type").notNull(),
    groupJson: json("group_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("takosumi_run_groups_space_idx").on(table.workspaceId)],
);

export const runs = pgTable(
  names.runs,
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    workspaceId: text("space_id").notNull(),
    sourceId: text("source_id"),
    capsuleId: text("installation_id"),
    status: text("status").notNull(),
    leaseToken: text("lease_token"),
    heartbeatAt: bigint("heartbeat_at", { mode: "number" }),
    createdAt: text("created_at").notNull(),
    runJson: json("run_json").notNull(),
  },
  (table) => [
    index("takosumi_runs_kind_idx").on(table.kind),
    index("takosumi_runs_kind_status_idx").on(table.kind, table.status),
    index("takosumi_runs_space_idx").on(table.workspaceId),
    index("takosumi_runs_source_idx").on(table.sourceId),
    index("takosumi_runs_installation_idx").on(table.capsuleId),
    index("takosumi_runs_installation_created_at_idx").on(
      table.capsuleId,
      table.createdAt,
    ),
    index("takosumi_runs_created_at_idx").on(table.createdAt),
  ],
);

export const planRunInputs = pgTable(names.planRunInputs, {
  planRunId: text("plan_run_id").primaryKey(),
  inputsJson: json("inputs_json").notNull(),
});

export const stateVersions = pgTable(
  names.stateVersions,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    generation: integer("generation").notNull(),
    snapshotJson: json("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex(
      "takosumi_state_versions_installation_environment_generation_un",
    ).on(table.capsuleId, table.environment, table.generation),
    index("takosumi_state_versions_installation_idx").on(
      table.capsuleId,
      table.environment,
      table.generation,
    ),
  ],
);

export const artifacts = pgTable(
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
  (table) => [index("takosumi_artifacts_run_idx").on(table.runId)],
);

export const usageEvents = pgTable(
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
    resourceMetadataJson: json("resource_metadata_json"),
    kind: text("kind").notNull(),
    quantity: real("quantity").notNull(),
    usdMicros: bigint("usd_micros", { mode: "number" }).notNull(),
    ratingStatus: text("rating_status").notNull(),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_usage_events_workspace_idx").on(table.workspaceId),
    index("takosumi_usage_events_run_idx").on(table.runId),
    uniqueIndex("takosumi_usage_events_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
  ],
);

export const publicHostReservations = pgTable(
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
    index("takosumi_public_host_reservations_workspace_idx").on(
      table.workspaceId,
    ),
    index("takosumi_public_host_reservations_owner_kind_idx").on(
      table.ownerUserId,
      table.allocationKind,
      table.status,
    ),
    index("takosumi_public_host_reservations_installation_idx").on(
      table.capsuleId,
    ),
    index("takosumi_public_host_reservations_status_idx").on(table.status),
  ],
);

export const credentialMintEvents = pgTable(
  names.credentialMintEvents,
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id"),
    sourceId: text("source_id"),
    connectionId: text("connection_id").notNull(),
    phase: text("phase").notNull(),
    eventJson: json("event_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_credential_mint_events_run_idx").on(table.runId),
    index("takosumi_credential_mint_events_space_idx").on(table.workspaceId),
    index("takosumi_credential_mint_events_source_idx").on(table.sourceId),
  ],
);

export const securityFindings = pgTable(
  names.securityFindings,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id"),
    runId: text("run_id"),
    severity: text("severity").notNull(),
    type: text("type").notNull(),
    findingJson: json("finding_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_security_findings_space_idx").on(table.workspaceId),
    index("takosumi_security_findings_run_idx").on(table.runId),
    index("takosumi_security_findings_severity_idx").on(table.severity),
  ],
);

export const auditEvents = pgTable(
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
    eventJson: json("event_json").notNull(),
  },
  (table) => [
    index("takosumi_audit_events_space_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("takosumi_audit_events_space_target_created_id_idx").on(
      table.workspaceId,
      table.targetType,
      table.targetId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const backups = pgTable(
  names.backups,
  {
    id: text("id").primaryKey(),
    workspaceId: text("space_id").notNull(),
    capsuleId: text("installation_id"),
    environment: text("environment"),
    createdByRunId: text("created_by_run_id"),
    backupJson: json("backup_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_backups_space_idx").on(table.workspaceId, table.createdAt),
    index("takosumi_backups_installation_idx").on(table.capsuleId),
  ],
);

// --- Resource Shape flow (`takosumi.dev/v1alpha1`) ---------------------------
//
// Columnar projections of the public Resource / ResolutionLock / TargetPool /
// SpacePolicy objects on the deploy-control persistence plane (`final-plan.md`
// §10). Complex sub-objects (spec / outputs / conditions / labels / reason /
// native resources) are jsonb columns; the indexed columns drive name / space
// lookups.

export const resourceShapes = pgTable(
  names.resourceShapes,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    project: text("project"),
    environment: text("environment"),
    kind: text("kind").notNull(),
    formRefJson: json("form_ref_json"),
    packageDigest: text("package_digest"),
    name: text("name").notNull(),
    managedBy: text("managed_by").notNull(),
    specJson: json("spec_json").notNull(),
    phase: text("phase").notNull(),
    generation: integer("generation").notNull(),
    observedGeneration: integer("observed_generation").notNull(),
    outputsJson: json("outputs_json"),
    executionJson: json("execution_json"),
    stateAdoptionJson: json("state_adoption_json"),
    conditionsJson: json("conditions_json"),
    labelsJson: json("labels_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    observationLeaseId: text("observation_lease_id"),
    observationClaimedAt: text("observation_claimed_at"),
    lastObservationAttemptAt: text("last_observation_attempt_at"),
  },
  (table) => [
    uniqueIndex("takosumi_resource_shapes_space_kind_name_unique").on(
      table.spaceId,
      table.kind,
      table.name,
    ),
    index("takosumi_resource_shapes_space_idx").on(table.spaceId),
    index("takosumi_resource_shapes_space_created_id_idx").on(
      table.spaceId,
      table.createdAt,
      table.id,
    ),
    index("takosumi_resource_shapes_ready_kind_created_id_idx").on(
      table.kind,
      table.phase,
      table.createdAt,
      table.id,
    ),
    index("takosumi_resource_shapes_observation_due_idx").on(
      table.phase,
      table.lastObservationAttemptAt,
      table.observationClaimedAt,
      table.id,
    ),
    index("takosumi_resource_shapes_unpinned_form_kind_id_idx")
      .on(table.kind, table.id)
      .where(sql`${table.formRefJson} is null`),
  ],
);

export const resolutionLocks = pgTable(
  names.resolutionLocks,
  {
    resourceId: text("resource_id").primaryKey(),
    formRefJson: json("form_ref_json"),
    packageDigest: text("package_digest"),
    selectedImplementation: text("selected_implementation").notNull(),
    targetPool: text("target_pool"),
    target: text("target").notNull(),
    targetSnapshotJson: json("target_snapshot_json"),
    implementationSnapshotJson: json("implementation_snapshot_json"),
    implementationPlugin: text("implementation_plugin"),
    implementationOptionsJson: json("implementation_options_json"),
    implementationFingerprint: text("implementation_fingerprint"),
    locked: boolean("locked").notNull(),
    reasonJson: json("reason_json").notNull(),
    portability: text("portability"),
    nativeResourcesJson: json("native_resources_json"),
    lockedAt: text("locked_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_resolution_locks_unpinned_form_resource_idx")
      .on(table.resourceId)
      .where(sql`${table.formRefJson} is null`),
  ],
);

export const targetPools = pgTable(
  names.targetPools,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    name: text("name").notNull(),
    specJson: json("spec_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_target_pools_space_name_unique").on(
      table.spaceId,
      table.name,
    ),
    index("takosumi_target_pools_space_idx").on(table.spaceId),
    index("takosumi_target_pools_space_created_id_idx").on(
      table.spaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const spacePolicies = pgTable(
  names.spacePolicies,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    name: text("name").notNull(),
    specJson: json("spec_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_space_policies_space_name_unique").on(
      table.spaceId,
      table.name,
    ),
    index("takosumi_space_policies_space_idx").on(table.spaceId),
  ],
);

export const interfaces = pgTable(
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
    oauthResourceUri: text("oauth_resource_uri"),
    formRefKey: text("form_ref_key"),
    formSchemaDigest: text("form_schema_digest"),
    descriptorName: text("descriptor_name"),
    descriptorVersion: text("descriptor_version"),
    recordJson: json("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_interfaces_active_name_unique")
      .on(table.workspaceId, table.ownerKind, table.ownerId, table.name)
      .where(sql`${table.phase} <> 'Retired'`),
    index("takosumi_interfaces_workspace_type_phase_idx").on(
      table.workspaceId,
      table.interfaceType,
      table.phase,
    ),
    uniqueIndex("takosumi_interfaces_oauth_resource_claim_unique")
      .on(
        table.workspaceId,
        table.ownerKind,
        table.ownerId,
        table.oauthResourceUri,
      )
      .where(sql`${table.oauthResourceUri} is not null`),
    index("takosumi_interfaces_form_descriptor_idx")
      .on(
        table.workspaceId,
        table.formRefKey,
        table.formSchemaDigest,
        table.descriptorName,
        table.descriptorVersion,
      )
      .where(sql`${table.formRefKey} is not null`),
  ],
);

export const interfaceBindings = pgTable(
  names.interfaceBindings,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    interfaceId: text("interface_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    phase: text("phase").notNull(),
    generation: integer("generation").notNull(),
    recordJson: json("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_interface_bindings_active_subject_unique")
      .on(table.interfaceId, table.subjectKind, table.subjectId)
      .where(sql`${table.phase} <> 'Revoked'`),
    index("takosumi_interface_bindings_interface_idx").on(table.interfaceId),
    index("takosumi_interface_bindings_workspace_subject_idx").on(
      table.workspaceId,
      table.subjectKind,
      table.subjectId,
    ),
  ],
);

export const serviceFormPackages = pgTable(
  names.serviceFormPackages,
  {
    packageDigest: text("package_digest").primaryKey(),
    status: text("status").notNull(),
    recordJson: json("record_json").notNull(),
    installedAt: text("installed_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_service_form_packages_status_updated_digest_idx").on(
      table.status,
      table.updatedAt,
      table.packageDigest,
    ),
  ],
);

export const serviceFormDefinitions = pgTable(
  names.serviceFormDefinitions,
  {
    formRefKey: text("form_ref_key").primaryKey(),
    packageDigest: text("package_digest").notNull(),
    apiVersion: text("api_version").notNull(),
    kind: text("kind").notNull(),
    definitionVersion: text("definition_version").notNull(),
    schemaDigest: text("schema_digest").notNull(),
    recordJson: json("record_json").notNull(),
    installedAt: text("installed_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_service_form_definitions_ref_package_unique").on(
      table.formRefKey,
      table.packageDigest,
    ),
    index("takosumi_service_form_definitions_package_idx").on(
      table.packageDigest,
    ),
    index("takosumi_service_form_definitions_kind_installed_ref_idx").on(
      table.kind,
      table.installedAt,
      table.formRefKey,
    ),
  ],
);

export const serviceFormActivations = pgTable(
  names.serviceFormActivations,
  {
    id: text("id").primaryKey(),
    formRefKey: text("form_ref_key").notNull(),
    packageDigest: text("package_digest").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    status: text("status").notNull(),
    revision: integer("revision").notNull(),
    recordJson: json("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_service_form_activations_scope_status_updated_id_idx").on(
      table.scopeType,
      table.scopeId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    index("takosumi_service_form_activations_identity_idx").on(
      table.formRefKey,
      table.packageDigest,
    ),
  ],
);

export const offeringCatalogs = pgTable(
  names.offeringCatalogs,
  {
    catalogKey: text("catalog_key").primaryKey(),
    catalogId: text("catalog_id").notNull(),
    catalogVersion: text("catalog_version").notNull(),
    effectiveAt: text("effective_at").notNull(),
    recordJson: json("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_offering_catalogs_id_version_unique").on(
      table.catalogId,
      table.catalogVersion,
    ),
    index("takosumi_offering_catalogs_created_key_idx").on(
      table.createdAt,
      table.catalogKey,
    ),
    index("takosumi_offering_catalogs_effective_key_idx").on(
      table.effectiveAt,
      table.catalogKey,
    ),
  ],
);
