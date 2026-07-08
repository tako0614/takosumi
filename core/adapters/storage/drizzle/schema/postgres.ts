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

export const spaces = pgTable(
  names.spaces,
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
    // Nullable: legacy upload-origin snapshots have no Git Source.
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

export const secretBlobs = pgTable(
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
    projectId: text("project_id"),
    name: text("name").notNull(),
    environment: text("environment").notNull(),
    // Nullable: legacy upload-origin capsules have no Git Source.
    sourceId: text("source_id"),
    installConfigId: text("install_config_id").notNull(),
    // current_deployment_id physically renamed to current_state_version_id
    // (retired-Deployment value-translation target); property keeps the old name.
    currentDeploymentId: text("current_state_version_id"),
    status: text("status").notNull(),
    installationJson: json("installation_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_capsules_space_name_environment_active_unique")
      .on(table.spaceId, table.name, table.environment)
      .where(sql`${table.status} <> 'destroyed'`),
    index("takosumi_capsules_space_idx").on(table.spaceId),
    index("takosumi_capsules_project_idx").on(table.projectId),
    index("takosumi_capsules_current_state_version_idx").on(
      table.currentDeploymentId,
    ),
    index("takosumi_capsules_created_at_idx").on(table.createdAt),
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
    rootModuleVariablesJson: json("root_module_variables_json")
      .notNull()
      .default([]),
    rootModuleOutputsJson: json("root_module_outputs_json")
      .notNull()
      .default([]),
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

export const providerEnvBindingSets = pgTable(
  names.providerEnvBindingSets,
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
      "takosumi_provider_env_bindings_installation_environment_unique",
    ).on(table.installationId, table.environment),
    index("takosumi_provider_env_bindings_installation_idx").on(
      table.installationId,
      table.environment,
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
    index("takosumi_outputs_installation_idx").on(
      table.installationId,
      table.stateGeneration,
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
    index("takosumi_output_shares_from_space_idx").on(
      table.fromSpaceId,
      table.createdAt,
    ),
    index("takosumi_output_shares_to_space_idx").on(
      table.toSpaceId,
      table.createdAt,
    ),
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
      "takosumi_state_versions_installation_environment_generation_un",
    ).on(table.installationId, table.environment, table.generation),
    index("takosumi_state_versions_installation_idx").on(
      table.installationId,
      table.environment,
      table.generation,
    ),
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
    index("takosumi_opentofu_deployments_created_at_idx").on(table.createdAt),
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
  includedUsdMicros: bigint("included_usd_micros", { mode: "number" }),
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
  availableUsdMicros: bigint("available_usd_micros", { mode: "number" }),
  reservedUsdMicros: bigint("reserved_usd_micros", { mode: "number" }),
  monthlyIncludedUsdMicros: bigint("monthly_included_usd_micros", {
    mode: "number",
  }),
  purchasedUsdMicros: bigint("purchased_usd_micros", { mode: "number" }),
  availableCredits: integer("available_credits").notNull(),
  reservedCredits: integer("reserved_credits").notNull(),
  monthlyIncludedCredits: integer("monthly_included_credits").notNull(),
  purchasedCredits: integer("purchased_credits").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const billingAutoRechargeAttempts = pgTable(
  names.billingAutoRechargeAttempts,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    runId: text("run_id").notNull(),
    billingAccountId: text("billing_account_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end"),
    requestedUsdMicros: bigint("requested_usd_micros", {
      mode: "number",
    }).notNull(),
    monthlyLimitUsdMicros: bigint("monthly_limit_usd_micros", {
      mode: "number",
    }),
    chargedUsdMicros: bigint("charged_usd_micros", { mode: "number" }),
    status: text("status").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    providerStatus: text("provider_status"),
    failureReason: text("failure_reason"),
    attemptJson: json("attempt_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex(
      "takosumi_billing_auto_recharge_attempts_idempotency_unique",
    ).on(table.idempotencyKey),
    index("takosumi_billing_auto_recharge_attempts_space_period_status_idx").on(
      table.spaceId,
      table.periodStart,
      table.status,
    ),
    index("takosumi_billing_auto_recharge_attempts_run_idx").on(table.runId),
  ],
);

export const usageEvents = pgTable(
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
    resourceMetadataJson: json("resource_metadata_json"),
    kind: text("kind").notNull(),
    quantity: real("quantity").notNull(),
    usdMicros: bigint("usd_micros", { mode: "number" }),
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
    estimatedUsdMicros: bigint("estimated_usd_micros", { mode: "number" }),
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

export const publicHostReservations = pgTable(
  names.publicHostReservations,
  {
    hostname: text("hostname").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    installationId: text("installation_id").notNull(),
    installationName: text("installation_name").notNull(),
    status: text("status").notNull(),
    reservedAt: text("reserved_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    releasedAt: text("released_at"),
  },
  (table) => [
    index("takosumi_public_host_reservations_workspace_idx").on(
      table.workspaceId,
    ),
    index("takosumi_public_host_reservations_installation_idx").on(
      table.installationId,
    ),
    index("takosumi_public_host_reservations_status_idx").on(table.status),
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
  (table) => [
    index("takosumi_audit_events_space_idx").on(table.spaceId, table.createdAt),
  ],
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
    index("takosumi_backups_space_idx").on(table.spaceId, table.createdAt),
    index("takosumi_backups_installation_idx").on(table.installationId),
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
    name: text("name").notNull(),
    managedBy: text("managed_by").notNull(),
    specJson: json("spec_json").notNull(),
    phase: text("phase").notNull(),
    generation: integer("generation").notNull(),
    observedGeneration: integer("observed_generation").notNull(),
    outputsJson: json("outputs_json"),
    conditionsJson: json("conditions_json"),
    labelsJson: json("labels_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("takosumi_resource_shapes_space_kind_name_unique").on(
      table.spaceId,
      table.kind,
      table.name,
    ),
    index("takosumi_resource_shapes_space_idx").on(table.spaceId),
  ],
);

export const resolutionLocks = pgTable(names.resolutionLocks, {
  resourceId: text("resource_id").primaryKey(),
  selectedImplementation: text("selected_implementation").notNull(),
  target: text("target").notNull(),
  locked: boolean("locked").notNull(),
  reasonJson: json("reason_json").notNull(),
  portability: text("portability"),
  nativeResourcesJson: json("native_resources_json"),
  lockedAt: text("locked_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
