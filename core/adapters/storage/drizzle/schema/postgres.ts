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
import { deployControlPostgresTableNames as names } from "./logical.ts";

const json = (name: string) => jsonb(name).$type<unknown>();

export const runnerProfiles = pgTable(names.runnerProfiles, {
  id: text("id").primaryKey(),
  profileJson: json("profile_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const spaces = pgTable(
  names.spaces,
  {
    id: text("id").primaryKey(),
    handle: text("handle").notNull(),
    spaceJson: json("space_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("takosumi_spaces_handle_unique").on(table.handle)],
);

export const sources = pgTable(
  names.sources,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    status: text("status").notNull(),
    sourceJson: json("source_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_sources_space_idx").on(table.spaceId),
    index("takosumi_sources_status_idx").on(table.status),
  ],
);

export const sourceSnapshots = pgTable(
  names.sourceSnapshots,
  {
    id: text("id").primaryKey(),
    // Nullable: upload-origin snapshots (takosumi deploy) have no Source.
    sourceId: text("source_id"),
    snapshotJson: json("snapshot_json").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [index("takosumi_source_snapshots_source_idx").on(table.sourceId)],
);

export const connections = pgTable(
  names.connections,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id"),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    connectionJson: json("connection_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_connections_space_idx").on(table.spaceId),
    index("takosumi_connections_status_idx").on(table.status),
  ],
);

export const secretBlobs = pgTable(names.secretBlobs, {
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
  blobJson: json("blob_json").notNull(),
}, (table) => [
  uniqueIndex("takosumi_connection_secret_blobs_connection_idx").on(
    table.connectionId,
  ),
]);

export const operatorConnectionDefaults = pgTable(
  names.operatorConnectionDefaults,
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    connectionId: text("connection_id").notNull(),
    defaultJson: json("default_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_operator_connection_defaults_provider_unique").on(
      table.provider,
    ),
  ],
);

export const providerTemplates = pgTable(
  names.providerTemplates,
  {
    id: text("id").primaryKey(),
    providerSource: text("provider_source").notNull(),
    primaryCredentialSource: text("primary_credential_source").notNull(),
    defaultEligible: integer("default_eligible").notNull(),
    entryJson: json("entry_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_provider_templates_source_unique").on(
      table.providerSource,
    ),
    index("takosumi_provider_templates_primary_credential_source_idx").on(
      table.primaryCredentialSource,
    ),
    index("takosumi_provider_templates_default_eligible_idx").on(
      table.defaultEligible,
    ),
  ],
);

export const installConfigs = pgTable(
  names.installConfigs,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id"),
    installType: text("install_type").notNull(),
    trustLevel: text("trust_level").notNull(),
    configJson: json("config_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_install_configs_space_idx").on(table.spaceId),
    index("takosumi_install_configs_install_type_idx").on(table.installType),
  ],
);

export const installations = pgTable(
  names.installations,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    name: text("name").notNull(),
    environment: text("environment").notNull(),
    // Nullable: upload-origin installations (takosumi deploy) have no Source.
    sourceId: text("source_id"),
    installConfigId: text("install_config_id").notNull(),
    currentDeploymentId: text("current_deployment_id"),
    status: text("status").notNull(),
    installationJson: json("installation_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex(
      "takosumi_opentofu_installations_space_name_environment_unique",
    ).on(table.spaceId, table.name, table.environment),
    index("takosumi_opentofu_installations_space_idx").on(table.spaceId),
    index("takosumi_opentofu_installations_current_deployment_idx").on(
      table.currentDeploymentId,
    ),
  ],
);

export const capsuleCompatibilityReports = pgTable(
  names.capsuleCompatibilityReports,
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id"),
    installationId: text("installation_id"),
    sourceSnapshotId: text("source_snapshot_id").notNull(),
    level: text("level").notNull(),
    findingsJson: json("findings_json").notNull(),
    providersJson: json("providers_json").notNull(),
    resourcesJson: json("resources_json").notNull(),
    dataSourcesJson: json("data_sources_json").notNull(),
    provisionersJson: json("provisioners_json").notNull(),
    normalizedObjectKey: text("normalized_object_key"),
    normalizedDigest: text("normalized_digest"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_capsule_compat_reports_source_snapshot_idx").on(
      table.sourceSnapshotId,
    ),
    index("takosumi_capsule_compat_reports_source_idx").on(table.sourceId),
    index("takosumi_capsule_compat_reports_installation_idx").on(
      table.installationId,
    ),
    index("takosumi_capsule_compat_reports_level_idx").on(table.level),
  ],
);

export const deploymentProfiles = pgTable(
  names.deploymentProfiles,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    profileJson: json("profile_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex(
      "takosumi_deployment_profiles_installation_environment_unique",
    ).on(table.installationId, table.environment),
    index("takosumi_deployment_profiles_installation_idx").on(
      table.installationId,
    ),
  ],
);

export const installationDependencies = pgTable(
  names.installationDependencies,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    producerInstallationId: text("producer_installation_id").notNull(),
    consumerInstallationId: text("consumer_installation_id").notNull(),
    dependencyJson: json("dependency_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_installation_dependencies_space_idx").on(table.spaceId),
    index("takosumi_installation_dependencies_producer_idx").on(
      table.producerInstallationId,
    ),
    index("takosumi_installation_dependencies_consumer_idx").on(
      table.consumerInstallationId,
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

export const outputSnapshots = pgTable(
  names.outputSnapshots,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id").notNull(),
    stateGeneration: integer("state_generation").notNull(),
    snapshotJson: json("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_output_snapshots_installation_idx").on(
      table.installationId,
    ),
  ],
);

export const outputShares = pgTable(
  names.outputShares,
  {
    id: text("id").primaryKey(),
    fromSpaceId: text("from_space_id").notNull(),
    toSpaceId: text("to_space_id").notNull(),
    producerInstallationId: text("producer_installation_id").notNull(),
    status: text("status").notNull(),
    shareJson: json("share_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_output_shares_from_space_idx").on(table.fromSpaceId),
    index("takosumi_output_shares_to_space_idx").on(table.toSpaceId),
    index("takosumi_output_shares_producer_idx").on(
      table.producerInstallationId,
    ),
  ],
);

export const runGroups = pgTable(
  names.runGroups,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    type: text("type").notNull(),
    groupJson: json("group_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("takosumi_run_groups_space_idx").on(table.spaceId)],
);

export const runs = pgTable(
  names.runs,
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    spaceId: text("space_id").notNull(),
    sourceId: text("source_id"),
    installationId: text("installation_id"),
    status: text("status").notNull(),
    leaseToken: text("lease_token"),
    heartbeatAt: bigint("heartbeat_at", { mode: "number" }),
    createdAt: text("created_at").notNull(),
    runJson: json("run_json").notNull(),
  },
  (table) => [
    index("takosumi_runs_kind_idx").on(table.kind),
    index("takosumi_runs_kind_status_idx").on(table.kind, table.status),
    index("takosumi_runs_space_idx").on(table.spaceId),
    index("takosumi_runs_source_idx").on(table.sourceId),
    index("takosumi_runs_installation_idx").on(table.installationId),
    index("takosumi_runs_created_at_idx").on(table.createdAt),
  ],
);

export const runsInputs = pgTable(names.runsInputs, {
  planRunId: text("plan_run_id").primaryKey(),
  inputsJson: json("inputs_json").notNull(),
});

export const stateSnapshots = pgTable(
  names.stateSnapshots,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id").notNull(),
    environment: text("environment").notNull(),
    generation: integer("generation").notNull(),
    snapshotJson: json("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex(
      "takosumi_state_snapshots_installation_environment_generation_unique",
    ).on(table.installationId, table.environment, table.generation),
    index("takosumi_state_snapshots_installation_idx").on(table.installationId),
  ],
);

export const deployments = pgTable(
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
    status: text("status").notNull(),
    deploymentJson: json("deployment_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_opentofu_deployments_space_idx").on(table.spaceId),
    index("takosumi_opentofu_deployments_installation_idx").on(
      table.installationId,
    ),
    index("takosumi_opentofu_deployments_apply_idx").on(table.applyRunId),
  ],
);

export const artifacts = pgTable(
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
  (table) => [index("takosumi_artifacts_run_idx").on(table.runId)],
);

export const billingAccounts = pgTable(
  names.billingAccounts,
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    accountJson: json("account_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_billing_accounts_owner_idx").on(
      table.ownerType,
      table.ownerId,
    ),
    index("takosumi_billing_accounts_status_idx").on(table.status),
  ],
);

export const billingPlans = pgTable(names.billingPlans, {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  monthlyBasePrice: integer("monthly_base_price").notNull(),
  includedCredits: integer("included_credits").notNull(),
  limitsJson: json("limits_json").notNull(),
  planJson: json("plan_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const spaceSubscriptions = pgTable(
  names.spaceSubscriptions,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    billingAccountId: text("billing_account_id").notNull(),
    planId: text("plan_id").notNull(),
    status: text("status").notNull(),
    subscriptionJson: json("subscription_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("takosumi_space_subscriptions_space_idx").on(table.spaceId),
    index("takosumi_space_subscriptions_billing_account_idx").on(
      table.billingAccountId,
    ),
  ],
);

export const creditBalances = pgTable(names.creditBalances, {
  spaceId: text("space_id").primaryKey(),
  availableCredits: integer("available_credits").notNull(),
  reservedCredits: integer("reserved_credits").notNull(),
  monthlyIncludedCredits: integer("monthly_included_credits").notNull(),
  purchasedCredits: integer("purchased_credits").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const usageEvents = pgTable(
  names.usageEvents,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id"),
    runId: text("run_id"),
    kind: text("kind").notNull(),
    quantity: real("quantity").notNull(),
    credits: integer("credits").notNull(),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_usage_events_space_idx").on(table.spaceId),
    index("takosumi_usage_events_run_idx").on(table.runId),
    uniqueIndex("takosumi_usage_events_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
  ],
);

export const creditReservations = pgTable(
  names.creditReservations,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    runId: text("run_id").notNull(),
    estimatedCredits: integer("estimated_credits").notNull(),
    status: text("status").notNull(),
    mode: text("mode").notNull(),
    reservationJson: json("reservation_json").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("takosumi_credit_reservations_space_idx").on(table.spaceId),
    index("takosumi_credit_reservations_run_idx").on(table.runId),
    index("takosumi_credit_reservations_status_idx").on(table.status),
  ],
);

export const credentialMintEvents = pgTable(
  names.credentialMintEvents,
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id"),
    sourceId: text("source_id"),
    connectionId: text("connection_id").notNull(),
    phase: text("phase").notNull(),
    eventJson: json("event_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_credential_mint_events_run_idx").on(table.runId),
    index("takosumi_credential_mint_events_space_idx").on(table.spaceId),
    index("takosumi_credential_mint_events_source_idx").on(table.sourceId),
  ],
);

export const securityFindings = pgTable(
  names.securityFindings,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id"),
    runId: text("run_id"),
    severity: text("severity").notNull(),
    type: text("type").notNull(),
    findingJson: json("finding_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_security_findings_space_idx").on(table.spaceId),
    index("takosumi_security_findings_run_idx").on(table.runId),
    index("takosumi_security_findings_severity_idx").on(table.severity),
  ],
);

export const auditEvents = pgTable(
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
    eventJson: json("event_json").notNull(),
  },
  (table) => [index("takosumi_audit_events_space_idx").on(table.spaceId)],
);

export const backups = pgTable(
  names.backups,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    installationId: text("installation_id"),
    environment: text("environment"),
    createdByRunId: text("created_by_run_id"),
    backupJson: json("backup_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("takosumi_backups_space_idx").on(table.spaceId),
    index("takosumi_backups_installation_idx").on(table.installationId),
  ],
);
