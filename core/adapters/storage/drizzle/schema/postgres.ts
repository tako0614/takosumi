import {
  bigint,
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
    ownerUserId: text("owner_user_id").generatedAlwaysAs(
      sql`space_json ->> 'ownerUserId'`,
    ),
    workspaceType: text("workspace_type").generatedAlwaysAs(
      sql`space_json ->> 'type'`,
    ),
    personalBootstrapOwnerId: text("personal_bootstrap_owner_id"),
  },
  (table) => [
    uniqueIndex("takosumi_workspaces_handle_unique").on(table.handle),
    index("takosumi_workspaces_owner_type_created_idx").on(
      table.ownerUserId,
      table.workspaceType,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("takosumi_workspaces_personal_bootstrap_owner_unique")
      .on(table.personalBootstrapOwnerId)
      .where(sql`${table.personalBootstrapOwnerId} is not null`),
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

export const gitInstallPlans = pgTable(
  names.gitInstallPlans,
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    actorSubject: text("actor_subject").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestDigest: text("request_digest").notNull(),
    phase: text("phase").notNull(),
    generation: integer("generation").notNull(),
    recordJson: json("record_json").notNull(),
    reconcileLeaseToken: text("reconcile_lease_token"),
    reconcileLeaseExpiresAt: text("reconcile_lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_git_install_plans_actor_key_unique").on(
      table.workspaceId,
      table.actorSubject,
      table.idempotencyKeyHash,
    ),
    index("takosumi_git_install_plans_workspace_phase_idx").on(
      table.workspaceId,
      table.phase,
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
    executionAuthorityEpoch: integer("execution_authority_epoch")
      .notNull()
      .default(1),
    /** Private non-secret reservation lifecycle; never in Capsule JSON. */
    publicInputReservationJson: json("public_input_reservation_json"),
    publicInputReservationCleanupRunId: text(
      "public_input_reservation_cleanup_run_id",
    ),
    publicInputReservationCleanupAt: bigint(
      "public_input_reservation_cleanup_at",
      { mode: "number" },
    ),
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
    index("takosumi_capsules_execution_authority_exact_idx").on(
      table.workspaceId,
      table.id,
    ),
    index("takosumi_capsules_public_input_cleanup_idx").on(
      table.publicInputReservationCleanupAt,
      table.publicInputReservationCleanupRunId,
    ),
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

export const capsuleInterfaceMaterializationIntents = pgTable(
  names.capsuleInterfaceMaterializationIntents,
  {
    id: text("id").primaryKey(),
    applyRunId: text("apply_run_id"),
    restoreRunId: text("restore_run_id"),
    sourceIntentId: text("source_intent_id"),
    workspaceId: text("workspace_id").notNull(),
    capsuleId: text("capsule_id").notNull(),
    installConfigId: text("install_config_id").notNull(),
    stateVersionId: text("state_version_id").notNull(),
    outputId: text("output_id").notNull(),
    stateGeneration: integer("state_generation").notNull(),
    blueprintsDigest: text("blueprints_digest").notNull(),
    blueprintsJson: text("blueprints_json").notNull(),
    totalItems: integer("total_items").notNull(),
    nextItemIndex: integer("next_item_index").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(),
    nextRetryAt: text("next_retry_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    errorJson: json("error_json"),
    receiptJson: json("receipt_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    deadLetteredAt: text("dead_lettered_at"),
  },
  (table) => [
    uniqueIndex(
      "takosumi_interface_intents_apply_run_unique",
    ).on(table.applyRunId),
    uniqueIndex(
      "takosumi_interface_intents_restore_run_unique",
    ).on(table.restoreRunId),
    uniqueIndex(
      "takosumi_interface_intents_capsule_generation_unique",
    ).on(table.capsuleId, table.stateGeneration),
    index("takosumi_interface_intents_pending_idx").on(
      table.status,
      table.nextRetryAt,
    ),
    index("takosumi_interface_intents_dead_letter_idx").on(
      table.workspaceId,
      table.status,
      table.deadLetteredAt,
      table.id,
    ),
  ],
);

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
    index("takosumi_interfaces_authorized_page_idx").on(
      table.workspaceId,
      table.phase,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("takosumi_interfaces_oauth_resource_claim_unique")
      .on(
        table.workspaceId,
        table.ownerKind,
        table.ownerId,
        table.oauthResourceUri,
      )
      .where(sql`${table.oauthResourceUri} is not null`),
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
    index("takosumi_interface_bindings_authorized_current_idx")
      .on(
        table.workspaceId,
        table.subjectKind,
        table.subjectId,
        table.interfaceId,
      )
      .where(sql`${table.phase} = 'Ready'`),
  ],
);
