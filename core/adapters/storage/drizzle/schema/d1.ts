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

export const spaces = sqliteTable(
  names.spaces,
  {
    id: text("id").primaryKey(),
    handle: text("handle").notNull(),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("workspaces_handle_unique").on(table.handle)],
);

// Takosumi-specific Output Sync extension state. OpenTofu Output records remain
// authoritative; this row only tracks Workspace aggregation/reconciliation.
export const workspaceOutputSync = sqliteTable(
  names.workspaceOutputSync,
  {
    workspaceId: text("workspace_id").primaryKey(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    outputRevision: integer("output_revision").notNull().default(0),
    reconciledRevision: integer("reconciled_revision").notNull().default(0),
    activeRunGroupId: text("active_run_group_id"),
    consecutivePasses: integer("consecutive_passes").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("workspace_output_sync_pending_idx").on(
      table.enabled,
      table.outputRevision,
      table.reconciledRevision,
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
    // Nullable: legacy upload-origin snapshots have no Git Source.
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
    // P4 column decision (D1 capsules): space_id, current_output_snapshot_id and
    // the slug/install_type columns are KEPT physical (drizzle-mapped, deferred
    // to convergence slice 7). The Drizzle property names also stay unchanged so
    // the worker store and store.ts contract are untouched. Only the two
    // genuinely-new/renamed columns move physically:
    //   - current_deployment_id -> current_state_version_id (retired-Deployment
    //     value-translation target; the property keeps the old name and maps to
    //     the new physical column).
    //   - project_id ADDED (Workspace-owned Project pointer, backfilled).
    spaceId: text("space_id").notNull(),
    projectId: text("project_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Nullable: legacy upload-origin capsules have no Git Source.
    sourceId: text("source_id"),
    installType: text("install_type").notNull(),
    installConfigId: text("install_config_id").notNull(),
    environment: text("environment").notNull(),
    currentDeploymentId: text("current_state_version_id"),
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
    uniqueIndex("capsules_space_name_environment_active_unique")
      .on(table.spaceId, table.name, table.environment)
      .where(sql`${table.status} <> 'destroyed'`),
    index("capsules_space_idx").on(table.spaceId),
    index("capsules_project_idx").on(table.projectId),
    index("capsules_current_state_version_idx").on(table.currentDeploymentId),
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
    rootModuleVariablesJson: jsonText("root_module_variables_json")
      .notNull()
      .default([]),
    rootModuleOutputsJson: jsonText("root_module_outputs_json")
      .notNull()
      .default([]),
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
  (table) => [index("outputs_installation_idx").on(table.installationId)],
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
    uniqueIndex("state_versions_installation_environment_generation_unique").on(
      table.installationId,
      table.environment,
      table.generation,
    ),
    index("state_versions_installation_idx").on(table.installationId),
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
  includedUsdMicros: integer("included_usd_micros"),
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
  availableUsdMicros: integer("available_usd_micros"),
  reservedUsdMicros: integer("reserved_usd_micros"),
  monthlyIncludedUsdMicros: integer("monthly_included_usd_micros"),
  purchasedUsdMicros: integer("purchased_usd_micros"),
  availableCredits: integer("available_credits").notNull(),
  reservedCredits: integer("reserved_credits").notNull(),
  monthlyIncludedCredits: integer("monthly_included_credits").notNull(),
  purchasedCredits: integer("purchased_credits").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const billingAutoRechargeAttempts = sqliteTable(
  names.billingAutoRechargeAttempts,
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    runId: text("run_id").notNull(),
    billingAccountId: text("billing_account_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end"),
    requestedUsdMicros: integer("requested_usd_micros").notNull(),
    monthlyLimitUsdMicros: integer("monthly_limit_usd_micros"),
    chargedUsdMicros: integer("charged_usd_micros"),
    status: text("status").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    providerStatus: text("provider_status"),
    failureReason: text("failure_reason"),
    recordJson: jsonText("record_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("billing_auto_recharge_attempts_idempotency_unique").on(
      table.idempotencyKey,
    ),
    index("billing_auto_recharge_attempts_space_period_status_idx").on(
      table.spaceId,
      table.periodStart,
      table.status,
    ),
    index("billing_auto_recharge_attempts_run_idx").on(table.runId),
  ],
);

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
    usdMicros: integer("usd_micros"),
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
    estimatedUsdMicros: integer("estimated_usd_micros"),
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

export const publicHostReservations = sqliteTable(
  names.publicHostReservations,
  {
    hostname: text("hostname").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    installationId: text("installation_id").notNull(),
    installationName: text("installation_name").notNull(),
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
    index("public_host_reservations_installation_idx").on(table.installationId),
    index("public_host_reservations_status_idx").on(table.status),
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
    conditionsJson: jsonText("conditions_json"),
    labelsJson: jsonText("labels_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("resource_shapes_space_kind_name_unique").on(
      table.spaceId,
      table.kind,
      table.name,
    ),
    index("resource_shapes_space_idx").on(table.spaceId),
  ],
);

export const resolutionLocks = sqliteTable(names.resolutionLocks, {
  resourceId: text("resource_id").primaryKey(),
  selectedImplementation: text("selected_implementation").notNull(),
  target: text("target").notNull(),
  locked: integer("locked").notNull(),
  reasonJson: jsonText("reason_json").notNull(),
  portability: text("portability"),
  nativeResourcesJson: jsonText("native_resources_json"),
  lockedAt: text("locked_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
