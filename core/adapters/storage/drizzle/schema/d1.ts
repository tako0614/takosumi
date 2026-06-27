import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { deployControlD1TableNames as names } from "./logical.ts";

const jsonText = (name: string) =>
  text(name, { mode: "json" }).$type<unknown>();

export const runnerProfiles = sqliteTable(names.runnerProfiles, {
  id: text("id").primaryKey(),
  recordJson: jsonText("record_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const spaces = sqliteTable(
  names.spaces,
  {
    id: text("id").primaryKey(),
    handle: text("handle").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("spaces_handle_unique").on(table.handle)],
);

export const sources = sqliteTable(
  names.sources,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("sources_space_idx").on(table.spaceId),
    index("sources_status_idx").on(table.status),
  ],
);

export const sourceSnapshots = sqliteTable(
  names.sourceSnapshots,
  {
    id: text("id").primaryKey(),
    // Nullable: upload-origin snapshots (takosumi deploy) have no Source.
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
    spaceId: text("space_id"),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    connectionJson: jsonText("connection_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("connections_space_idx").on(table.spaceId),
    index("connections_provider_idx").on(table.provider),
    index("connections_status_idx").on(table.status),
  ],
);

export const secretBlobs = sqliteTable(
  names.secretBlobs,
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    spaceId: text("space_id"),
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

export const providerEnvs = sqliteTable(
  names.providerEnvs,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    providerSource: text("provider_source").notNull(),
    materialization: text("materialization").notNull(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("provider_envs_space_idx").on(table.spaceId),
    index("provider_envs_provider_source_idx").on(table.providerSource),
    index("provider_envs_materialization_idx").on(table.materialization),
    index("provider_envs_status_idx").on(table.status),
  ],
);

export const providerCatalog = sqliteTable(
  names.providerCatalog,
  {
    id: text("id").primaryKey(),
    providerSource: text("provider_source").notNull(),
    primaryMaterialization: text("primary_materialization").notNull(),
    gatewayEligible: integer("gateway_eligible").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("provider_catalog_source_unique").on(table.providerSource),
    index("provider_catalog_primary_materialization_idx").on(
      table.primaryMaterialization,
    ),
    index("provider_catalog_gateway_eligible_idx").on(table.gatewayEligible),
  ],
);

export const installConfigs = sqliteTable(
  names.installConfigs,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id"),
    installType: text("install_type").notNull(),
    trustLevel: text("trust_level").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("install_configs_space_idx").on(table.spaceId),
    index("install_configs_install_type_idx").on(table.installType),
  ],
);

export const installations = sqliteTable(
  names.installations,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Nullable: upload-origin installations (takosumi deploy) have no Source.
    sourceId: text("source_id"),
    installType: text("install_type").notNull(),
    installConfigId: text("install_config_id").notNull(),
    environment: text("environment").notNull(),
    currentDeploymentId: text("current_deployment_id"),
    currentStateGeneration: integer("current_state_generation")
      .notNull()
      .default(0),
    currentOutputSnapshotId: text("current_output_snapshot_id"),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("installations_space_name_environment_unique").on(
      table.spaceId,
      table.name,
      table.environment,
    ),
    index("installations_space_idx").on(table.spaceId),
    index("installations_current_deployment_idx").on(table.currentDeploymentId),
  ],
);

export const capsuleCompatibilityReports = sqliteTable(
  names.capsuleCompatibilityReports,
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id"),
    installationId: text("installation_id"),
    sourceSnapshotId: text("source_snapshot_id").notNull(),
    level: text("level").notNull(),
    findingsJson: jsonText("findings_json").notNull(),
    providersJson: jsonText("providers_json").notNull(),
    resourcesJson: jsonText("resources_json").notNull(),
    dataSourcesJson: jsonText("data_sources_json").notNull(),
    provisionersJson: jsonText("provisioners_json").notNull(),
    normalizedObjectKey: text("normalized_object_key"),
    normalizedDigest: text("normalized_digest"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("capsule_compatibility_reports_source_snapshot_idx").on(
      table.sourceSnapshotId,
    ),
    index("capsule_compatibility_reports_source_idx").on(table.sourceId),
    index("capsule_compatibility_reports_installation_idx").on(
      table.installationId,
    ),
    index("capsule_compatibility_reports_level_idx").on(table.level),
  ],
);

export const providerEnvBindingSets = sqliteTable(
  names.providerEnvBindingSets,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("provider_env_binding_sets_installation_environment_unique").on(
      table.installationId,
      table.environment,
    ),
    index("provider_env_binding_sets_installation_idx").on(
      table.installationId,
    ),
  ],
);

export const installationDependencies = sqliteTable(
  names.installationDependencies,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    producerInstallationId: text("producer_installation_id").notNull(),
    consumerInstallationId: text("consumer_installation_id").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("installation_dependencies_space_idx").on(table.spaceId),
    index("installation_dependencies_producer_idx").on(
      table.producerInstallationId,
    ),
    index("installation_dependencies_consumer_idx").on(
      table.consumerInstallationId,
    ),
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

export const outputSnapshots = sqliteTable(
  names.outputSnapshots,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id").notNull(),
    stateGeneration: integer("state_generation").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("output_snapshots_installation_idx").on(table.installationId),
  ],
);

export const outputShares = sqliteTable(
  names.outputShares,
  {
    id: text("id").primaryKey(),
    fromSpaceId: text("from_space_id").notNull(),
    toSpaceId: text("to_space_id").notNull(),
    producerInstallationId: text("producer_installation_id").notNull(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("output_shares_from_space_idx").on(table.fromSpaceId),
    index("output_shares_to_space_idx").on(table.toSpaceId),
    index("output_shares_producer_idx").on(table.producerInstallationId),
  ],
);

export const runGroups = sqliteTable(
  names.runGroups,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    type: text("type").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("run_groups_space_idx").on(table.spaceId)],
);

export const runs = sqliteTable(
  names.runs,
  {
    id: text("id").primaryKey(),
    runGroupId: text("run_group_id"),
    spaceId: text("space_id").notNull(),
    sourceId: text("source_id"),
    installationId: text("installation_id"),
    environment: text("environment"),
    type: text("type").notNull(),
    status: text("status").notNull(),
    leaseToken: text("lease_token"),
    heartbeatAt: integer("heartbeat_at"),
    runJson: jsonText("run_json").notNull(),
    createdAt: text("created_at").notNull().default(""),
  },
  (table) => [
    index("runs_space_idx").on(table.spaceId),
    index("runs_source_idx").on(table.sourceId),
    index("runs_installation_idx").on(table.installationId),
    index("runs_type_idx").on(table.type),
    index("runs_created_at_idx").on(table.createdAt),
  ],
);

export const runsInputs = sqliteTable(names.runsInputs, {
  planRunId: text("plan_run_id").primaryKey(),
  inputsJson: jsonText("inputs_json").notNull(),
});

export const stateSnapshots = sqliteTable(
  names.stateSnapshots,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    generation: integer("generation").notNull(),
    objectKey: text("object_key").notNull(),
    digest: text("digest").notNull(),
    createdByRunId: text("created_by_run_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex(
      "state_snapshots_installation_environment_generation_unique",
    ).on(table.installationId, table.environment, table.generation),
    index("state_snapshots_installation_idx").on(table.installationId),
  ],
);

export const deployments = sqliteTable(
  names.deployments,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    applyRunId: text("apply_run_id").notNull(),
    sourceSnapshotId: text("source_snapshot_id").notNull(),
    dependencySnapshotId: text("dependency_snapshot_id"),
    stateGeneration: integer("state_generation").notNull(),
    outputSnapshotId: text("output_snapshot_id").notNull(),
    outputsPublicJson: jsonText("outputs_public_json").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("deployments_space_idx").on(table.spaceId),
    index("deployments_installation_idx").on(table.installationId),
    index("deployments_apply_idx").on(table.applyRunId),
  ],
);

export const artifacts = sqliteTable(
  names.artifacts,
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    kind: text("kind").notNull(),
    objectKey: text("object_key").notNull(),
    digest: text("digest").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("artifacts_run_idx").on(table.runId)],
);

export const billingAccounts = sqliteTable(
  names.billingAccounts,
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("billing_accounts_owner_idx").on(table.ownerType, table.ownerId),
    index("billing_accounts_status_idx").on(table.status),
  ],
);

export const billingPlans = sqliteTable(names.billingPlans, {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  monthlyBasePrice: integer("monthly_base_price").notNull(),
  includedCredits: integer("included_credits").notNull(),
  limitsJson: jsonText("limits_json").notNull(),
  recordJson: jsonText("record_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const spaceSubscriptions = sqliteTable(
  names.spaceSubscriptions,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    billingAccountId: text("billing_account_id").notNull(),
    planId: text("plan_id").notNull(),
    status: text("status").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("space_subscriptions_space_idx").on(table.spaceId),
    index("space_subscriptions_billing_account_idx").on(table.billingAccountId),
  ],
);

export const creditBalances = sqliteTable(names.creditBalances, {
  spaceId: text("space_id").primaryKey(),
  availableCredits: integer("available_credits").notNull(),
  reservedCredits: integer("reserved_credits").notNull(),
  monthlyIncludedCredits: integer("monthly_included_credits").notNull(),
  purchasedCredits: integer("purchased_credits").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const usageEvents = sqliteTable(
  names.usageEvents,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id"),
    runId: text("run_id"),
    meterId: text("meter_id"),
    resourceFamily: text("resource_family"),
    resourceId: text("resource_id"),
    operation: text("operation"),
    resourceMetadataJson: jsonText("resource_metadata_json"),
    kind: text("kind").notNull(),
    quantity: real("quantity").notNull(),
    credits: integer("credits").notNull(),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("usage_events_space_idx").on(table.spaceId),
    index("usage_events_run_idx").on(table.runId),
    uniqueIndex("usage_events_idempotency_key_unique").on(table.idempotencyKey),
  ],
);

export const creditReservations = sqliteTable(
  names.creditReservations,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    runId: text("run_id").notNull(),
    estimatedCredits: integer("estimated_credits").notNull(),
    status: text("status").notNull(),
    mode: text("mode").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("credit_reservations_space_idx").on(table.spaceId),
    index("credit_reservations_run_idx").on(table.runId),
    index("credit_reservations_status_idx").on(table.status),
  ],
);

export const credentialMintEvents = sqliteTable(
  names.credentialMintEvents,
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id"),
    sourceId: text("source_id"),
    connectionId: text("connection_id").notNull(),
    phase: text("phase").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("credential_mint_events_run_idx").on(table.runId),
    index("credential_mint_events_space_idx").on(table.spaceId),
    index("credential_mint_events_source_idx").on(table.sourceId),
  ],
);

export const securityFindings = sqliteTable(
  names.securityFindings,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id"),
    runId: text("run_id"),
    severity: text("severity").notNull(),
    type: text("type").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("security_findings_space_idx").on(table.spaceId),
    index("security_findings_run_idx").on(table.runId),
    index("security_findings_severity_idx").on(table.severity),
  ],
);

export const auditEvents = sqliteTable(
  names.auditEvents,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    runId: text("run_id"),
    createdAt: text("created_at").notNull(),
    recordJson: jsonText("record_json").notNull(),
  },
  (table) => [index("audit_events_space_idx").on(table.spaceId)],
);

export const backups = sqliteTable(
  names.backups,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id"),
    environment: text("environment"),
    createdByRunId: text("created_by_run_id"),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("backups_space_idx").on(table.spaceId),
    index("backups_installation_idx").on(table.installationId),
  ],
);
