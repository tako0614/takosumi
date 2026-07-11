type StorageDomain =
  | "space"
  | "deploy"
  | "runtime"
  | "resources"
  | "registry"
  | "audit"
  | "service-endpoints"
  // `runtime-projection` and `custom-domain` tag retired product surfaces, but they are NOT
  // dead union members: immutable, already-applied migration-ledger rows still carry them.
  // Migration history is frozen and append-only, so these tags must stay even though no
  // new code emits those product surfaces.
  | "runtime-projection"
  | "custom-domain"
  | "internal-auth";

type StorageMigrationDomain = StorageDomain | "core";

export interface StorageTableDefinition {
  readonly name: string;
  readonly domain: StorageMigrationDomain;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly uniqueConstraints?: readonly (readonly string[])[];
  readonly indexes?: readonly (readonly string[])[];
}

export interface StorageMigrationStatement {
  readonly id: string;
  readonly version: number;
  readonly domain: StorageMigrationDomain | "system";
  readonly description: string;
  readonly sql: string;
  /**
   * Optional reverse SQL applied when rolling a migration back via
   * `db:migrate:down` / `db:migrate:rollback`. Down migrations must:
   *   - drop only the schema this migration created (or revert the columns
   *     this migration added);
   *   - preserve user data wherever feasible (rollback is structural);
   *   - be idempotent (`drop table if exists`, `drop column if exists`).
   * A migration without a `down` clause is forward-only and the down runner
   * will refuse to rollback past it.
   */
  readonly down?: string;
}

export const postgresStorageTableDefinitions: readonly StorageTableDefinition[] =
  Object.freeze([
    {
      name: "spaces",
      domain: "space",
      columns: [
        "id",
        "name",
        "metadata_json",
        "created_by_account_id",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
    },
    {
      name: "space_groups",
      domain: "space",
      columns: [
        "id",
        "space_id",
        "slug",
        "display_name",
        "metadata_json",
        "created_by_account_id",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["space_id", "slug"]],
      indexes: [["space_id"]],
    },
    {
      name: "space_memberships",
      domain: "space",
      columns: [
        "id",
        "space_id",
        "account_id",
        "roles_json",
        "status",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["space_id", "account_id"]],
      indexes: [["space_id"]],
    },
    {
      name: "resource_instances",
      domain: "resources",
      columns: [
        "id",
        "space_id",
        "group_id",
        "contract",
        "origin",
        "sharing_mode",
        "provider",
        "provider_resource_id",
        "provider_materialization_id",
        "lifecycle_json",
        "schema_owner_json",
        "properties_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [
        ["space_id"],
        ["group_id"],
        ["provider", "provider_resource_id"],
      ],
    },
    {
      name: "resource_bindings",
      domain: "resources",
      columns: [
        "id",
        "space_id",
        "group_id",
        "claim_address",
        "instance_id",
        "role",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [
        ["space_id"],
        ["group_id"],
        ["group_id", "claim_address"],
        ["instance_id"],
      ],
    },
    {
      name: "resource_binding_set_revisions",
      domain: "resources",
      columns: [
        "id",
        "space_id",
        "group_id",
        "binding_value_resolutions_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id"], ["group_id"]],
    },
    {
      name: "resource_migration_ledger",
      domain: "resources",
      columns: [
        "id",
        "space_id",
        "resource_instance_id",
        "migration_ref",
        "from_version",
        "to_version",
        "status",
        "checkpoints_json",
        "started_at",
        "completed_at",
        "metadata_json",
      ],
      primaryKey: ["id"],
      indexes: [["space_id"], ["resource_instance_id"], ["migration_ref"]],
    },
    {
      name: "registry_package_descriptors",
      domain: "registry",
      columns: [
        "kind",
        "ref",
        "digest",
        "publisher",
        "version",
        "body_json",
        "published_at",
      ],
      primaryKey: ["kind", "ref", "digest"],
      indexes: [["kind", "ref"]],
    },
    {
      name: "registry_package_resolutions",
      domain: "registry",
      columns: [
        "kind",
        "ref",
        "digest",
        "registry",
        "trust_record_id",
        "resolved_at",
      ],
      primaryKey: ["kind", "ref", "digest"],
      indexes: [["kind", "ref"], ["trust_record_id"]],
    },
    {
      name: "registry_trust_records",
      domain: "registry",
      columns: [
        "id",
        "package_ref",
        "package_digest",
        "package_kind",
        "trust_level",
        "status",
        "conformance_tier",
        "verified_by",
        "verified_at",
        "revoked_at",
        "reason",
      ],
      primaryKey: ["id"],
      indexes: [["package_kind", "package_ref", "package_digest"]],
    },
    {
      name: "registry_catalog_publisher_keys",
      domain: "registry",
      columns: [
        "key_id",
        "publisher_id",
        "public_key_base64",
        "status",
        "enrolled_at",
        "revoked_at",
        "reason",
      ],
      primaryKey: ["key_id"],
      indexes: [["publisher_id"], ["status"]],
    },
    {
      name: "registry_catalog_releases",
      domain: "registry",
      columns: [
        "release_id",
        "publisher_id",
        "descriptor_digest",
        "descriptor_json",
        "signature_algorithm",
        "signature_key_id",
        "signature_value",
        "created_at",
        "activated_at",
      ],
      primaryKey: ["release_id"],
      indexes: [["publisher_id"], ["descriptor_digest"], ["created_at"]],
    },
    {
      name: "registry_catalog_release_adoptions",
      domain: "registry",
      columns: [
        "id",
        "space_id",
        "catalog_release_id",
        "publisher_id",
        "publisher_key_id",
        "descriptor_digest",
        "adopted_at",
        "rotated_from_catalog_release_id",
        "verification_json",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["space_id", "catalog_release_id"]],
      indexes: [
        ["space_id", "adopted_at"],
        ["catalog_release_id"],
        ["publisher_key_id"],
      ],
    },
    {
      name: "runtime_desired_states",
      domain: "runtime",
      columns: [
        "id",
        "space_id",
        "group_id",
        "activation_id",
        "state_json",
        "materialized_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id", "group_id"], ["activation_id"]],
    },
    {
      name: "runtime_observed_states",
      domain: "runtime",
      columns: ["id", "space_id", "group_id", "snapshot_json", "observed_at"],
      primaryKey: ["id"],
      indexes: [["space_id", "group_id"], ["observed_at"]],
    },
    {
      name: "runtime_provider_observations",
      domain: "runtime",
      columns: ["id", "materialization_id", "observation_json", "observed_at"],
      primaryKey: ["id"],
      indexes: [["materialization_id"], ["observed_at"]],
    },
    {
      name: "runtime_agents",
      domain: "runtime",
      columns: [
        "id",
        "provider",
        "endpoint",
        "capabilities_json",
        "status",
        "registered_at",
        "last_heartbeat_at",
        "drain_requested_at",
        "revoked_at",
        "expired_at",
        "host_key_digest",
        "metadata_json",
      ],
      primaryKey: ["id"],
      indexes: [["status"], ["last_heartbeat_at"]],
    },
    {
      name: "runtime_agent_work_items",
      domain: "runtime",
      columns: [
        "id",
        "agent_id",
        "kind",
        "status",
        "operation_id",
        "provider",
        "priority",
        "payload_json",
        "metadata_json",
        "queued_at",
        "leased_at",
        "lease_id",
        "lease_expires_at",
        "completed_at",
        "failed_at",
        "failure_reason",
        "attempts",
        "idempotency_key",
        "last_progress_json",
        "last_progress_at",
        "result_json",
      ],
      primaryKey: ["id"],
      indexes: [
        ["status"],
        ["agent_id"],
        ["lease_expires_at"],
        ["operation_id"],
      ],
    },
    {
      name: "audit_events",
      domain: "audit",
      columns: [
        "id",
        "event_class",
        "type",
        "severity",
        "actor_json",
        "space_id",
        "group_id",
        "target_type",
        "target_id",
        "payload_json",
        "occurred_at",
        "request_id",
        "correlation_id",
        "sequence",
        "previous_hash",
        "current_hash",
        "archived",
      ],
      primaryKey: ["id"],
      indexes: [
        ["space_id"],
        ["group_id"],
        ["target_type", "target_id"],
        ["type"],
        ["occurred_at"],
        ["sequence"],
      ],
      uniqueConstraints: [["sequence"]],
    },
    {
      name: "service_endpoints",
      domain: "service-endpoints",
      columns: [
        "id",
        "service_id",
        "space_id",
        "group_id",
        "endpoint_json",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [["service_id"], ["space_id", "group_id"]],
    },
    {
      name: "service_trust_records",
      domain: "service-endpoints",
      columns: ["id", "endpoint_id", "trust_record_json", "updated_at"],
      primaryKey: ["id"],
      indexes: [["endpoint_id"]],
    },
    {
      name: "service_grants",
      domain: "service-endpoints",
      columns: ["id", "trust_record_id", "subject", "grant_json"],
      primaryKey: ["id"],
      indexes: [["trust_record_id"], ["subject"]],
    },
    {
      name: "custom_domain_reservations",
      domain: "custom-domain",
      columns: [
        "hostname",
        "owner_tenant_id",
        "owner_group_id",
        "owner_deployment_id",
        "status",
        "reserved_at",
        "updated_at",
      ],
      primaryKey: ["hostname"],
      indexes: [
        ["owner_tenant_id", "owner_group_id"],
        ["owner_deployment_id"],
        ["status"],
      ],
    },
    {
      name: "internal_request_replay_log",
      domain: "internal-auth",
      columns: [
        "namespace",
        "request_id",
        "timestamp_ms",
        "expires_at_ms",
        "seen_at_ms",
      ],
      primaryKey: ["namespace", "request_id"],
      indexes: [["expires_at_ms"]],
    },
    {
      name: "takosumi_deployment_records",
      domain: "deploy",
      columns: [
        "id",
        "tenant_id",
        "name",
        "source_evidence_json",
        "applied_resources_json",
        "status",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["tenant_id", "name"]],
      indexes: [["tenant_id"], ["status"]],
    },
    {
      name: "takosumi_deployment_record_locks",
      domain: "deploy",
      columns: [
        "tenant_id",
        "name",
        "owner_token",
        "locked_until",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["tenant_id", "name"],
      indexes: [["locked_until"]],
    },
    {
      name: "takosumi_revoke_debts",
      domain: "deploy",
      columns: [
        "id",
        "source_key",
        "generated_object_id",
        "source_export_snapshot_id",
        "external_participant_id",
        "reason",
        "status",
        "owner_space_id",
        "originating_space_id",
        "deployment_name",
        "operation_plan_digest",
        "journal_entry_id",
        "operation_id",
        "resource_name",
        "provider_id",
        "retry_policy_json",
        "retry_attempts",
        "last_retry_at",
        "next_retry_at",
        "last_retry_error_json",
        "detail_json",
        "created_at",
        "status_updated_at",
        "aged_at",
        "cleared_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["source_key"]],
      indexes: [
        ["owner_space_id", "status"],
        ["owner_space_id", "deployment_name"],
        ["owner_space_id", "operation_plan_digest"],
        ["owner_space_id", "status", "next_retry_at"],
        ["created_at"],
      ],
    },
    {
      name: "takosumi_runner_profiles",
      domain: "deploy",
      columns: ["id", "profile_json", "created_at"],
      primaryKey: ["id"],
    },
    {
      // Single §27 run ledger: PlanRun (kind plan), ApplyRun (kind apply), and
      // SourceSyncRun (kind source_sync) persist as rows discriminated by kind.
      name: "takosumi_runs",
      domain: "deploy",
      columns: [
        "id",
        "kind",
        "space_id",
        "source_id",
        "installation_id",
        "status",
        "lease_token",
        "heartbeat_at",
        "created_at",
        "run_json",
      ],
      primaryKey: ["id"],
      indexes: [
        ["kind"],
        ["kind", "status"],
        ["space_id"],
        ["source_id"],
        ["installation_id"],
        ["created_at"],
      ],
    },
    {
      // §30 artifact ledger (R2 pointer metadata for plan / state archives).
      name: "takosumi_artifacts",
      domain: "deploy",
      columns: [
        "id",
        "run_id",
        "kind",
        "object_key",
        "digest",
        "size_bytes",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [["run_id"]],
    },
    {
      name: "takosumi_workspaces",
      domain: "deploy",
      columns: ["id", "handle", "space_json", "created_at", "updated_at"],
      primaryKey: ["id"],
      uniqueConstraints: [["handle"]],
    },
    {
      name: "takosumi_projects",
      domain: "deploy",
      columns: [
        "id",
        "workspace_id",
        "name",
        "slug",
        "project_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["workspace_id", "slug"]],
      indexes: [["workspace_id"]],
    },
    {
      name: "takosumi_install_configs",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "install_type",
        "trust_level",
        "config_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id"], ["install_type"]],
    },
    {
      name: "takosumi_capsules",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "project_id",
        "name",
        "environment",
        "source_id",
        "install_config_id",
        "current_state_version_id",
        "status",
        "installation_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [
        ["space_id"],
        ["project_id"],
        ["current_state_version_id"],
        ["created_at"],
      ],
    },
    {
      name: "takosumi_opentofu_deployments",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "installation_id",
        "environment",
        "apply_run_id",
        "source_snapshot_id",
        "dependency_snapshot_id",
        "state_generation",
        "output_snapshot_id",
        "status",
        "deployment_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [
        ["installation_id"],
        ["space_id"],
        ["apply_run_id"],
        ["created_at"],
      ],
    },
    {
      name: "takosumi_provider_env_binding_sets",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "installation_id",
        "environment",
        "profile_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["installation_id", "environment"]],
      indexes: [["installation_id", "environment"]],
    },
    {
      name: "takosumi_state_versions",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "installation_id",
        "environment",
        "generation",
        "snapshot_json",
        "created_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["installation_id", "environment", "generation"]],
      indexes: [["installation_id", "environment", "generation"]],
    },
    {
      // Dependency DAG edges (§14 / §15). One edge connects a producer
      // Installation's outputs to a consumer Installation's inputs in one Space.
      name: "takosumi_installation_dependencies",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "producer_installation_id",
        "consumer_installation_id",
        "dependency_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [
        ["space_id"],
        ["producer_installation_id"],
        ["consumer_installation_id"],
      ],
    },
    {
      // Plan-time pin of one run's dependency inputs (§17).
      name: "takosumi_dependency_snapshots",
      domain: "deploy",
      columns: ["id", "run_id", "snapshot_json", "created_at"],
      primaryKey: ["id"],
      indexes: [["run_id"]],
    },
    {
      // Projected outputs captured after a successful apply (§16). The raw
      // envelope stays an encrypted artifact; only the projection enters the DB.
      name: "takosumi_outputs",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "installation_id",
        "state_generation",
        "snapshot_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [["installation_id", "state_generation"]],
    },
    {
      // Ordered group of Runs across the dependency DAG (§19 / §24). The group
      // status is COMPUTED at read time from member runs; not a stored column.
      name: "takosumi_run_groups",
      domain: "deploy",
      columns: ["id", "space_id", "type", "group_json", "created_at"],
      primaryKey: ["id"],
      indexes: [["space_id"]],
    },
    {
      name: "takosumi_capsule_compatibility_reports",
      domain: "deploy",
      columns: [
        "id",
        "source_id",
        "installation_id",
        "source_snapshot_id",
        "level",
        "findings_json",
        "providers_json",
        "resources_json",
        "data_sources_json",
        "provisioners_json",
        "root_module_variables_json",
        "root_module_outputs_json",
        "normalized_object_key",
        "normalized_digest",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [
        ["installation_id"],
        ["source_snapshot_id"],
        ["source_id"],
        ["level"],
      ],
    },
    {
      // Cross-Space OutputShare grants (§18). A grant from a producer
      // Installation's projected outputs (in from_space_id) to a consumer
      // Space (to_space_id). share_json carries names + optional aliases +
      // sensitive flags only. Sensitive sharing requires explicit policy and a
      // host resolver at use time; resolved output VALUES never land in the
      // share.
      name: "takosumi_output_shares",
      domain: "deploy",
      columns: [
        "id",
        "from_space_id",
        "to_space_id",
        "producer_installation_id",
        "status",
        "share_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [
        ["from_space_id"],
        ["to_space_id"],
        ["producer_installation_id"],
      ],
    },
    {
      // Control-backup ledger pointers (§33 layer 1 / §26 R2_BACKUPS). One row
      // per sealed control-backup bundle written to R2_BACKUPS. The bundle
      // bytes live in object storage; only the pointer (objectKey / digest /
      // sizeBytes) round trips through backup_json — never secret material.
      name: "takosumi_backups",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "installation_id",
        "environment",
        "created_by_run_id",
        "backup_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id"], ["installation_id"]],
    },
    {
      name: "takosumi_billing_accounts",
      domain: "deploy",
      columns: [
        "id",
        "owner_type",
        "owner_id",
        "provider",
        "status",
        "account_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [["owner_type", "owner_id"], ["status"]],
    },
    {
      name: "takosumi_plans",
      domain: "deploy",
      columns: [
        "id",
        "name",
        "monthly_base_price",
        "included_usd_micros",
        "included_credits",
        "limits_json",
        "plan_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
    },
    {
      name: "takosumi_space_subscriptions",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "billing_account_id",
        "plan_id",
        "status",
        "subscription_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id"], ["billing_account_id"]],
    },
    {
      name: "takosumi_credit_balances",
      domain: "deploy",
      columns: [
        "space_id",
        "available_usd_micros",
        "reserved_usd_micros",
        "monthly_included_usd_micros",
        "purchased_usd_micros",
        "available_credits",
        "reserved_credits",
        "monthly_included_credits",
        "purchased_credits",
        "updated_at",
      ],
      primaryKey: ["space_id"],
    },
    {
      name: "takosumi_billing_auto_recharge_attempts",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "run_id",
        "billing_account_id",
        "idempotency_key",
        "period_start",
        "period_end",
        "requested_usd_micros",
        "monthly_limit_usd_micros",
        "charged_usd_micros",
        "status",
        "stripe_payment_intent_id",
        "provider_status",
        "failure_reason",
        "attempt_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["idempotency_key"]],
      indexes: [["space_id", "period_start", "status"], ["run_id"]],
    },
    {
      name: "takosumi_usage_events",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "installation_id",
        "run_id",
        "meter_id",
        "resource_family",
        "resource_id",
        "operation",
        "resource_metadata_json",
        "kind",
        "quantity",
        "usd_micros",
        "credits",
        "source",
        "idempotency_key",
        "created_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["idempotency_key"]],
      indexes: [["space_id"], ["run_id"]],
    },
    {
      name: "takosumi_credit_reservations",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "run_id",
        "estimated_usd_micros",
        "estimated_credits",
        "status",
        "mode",
        "reservation_json",
        "created_at",
        "expires_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id"], ["run_id"], ["status"]],
    },
    {
      name: "takosumi_credential_mint_events",
      domain: "deploy",
      columns: [
        "id",
        "run_id",
        "space_id",
        "installation_id",
        "source_id",
        "connection_id",
        "phase",
        "event_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [["run_id"], ["space_id"], ["source_id"]],
    },
    {
      name: "takosumi_security_findings",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "installation_id",
        "run_id",
        "severity",
        "type",
        "finding_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id"], ["run_id"], ["severity"]],
    },
    {
      name: "takosumi_resource_shapes",
      domain: "resources",
      columns: [
        "id",
        "space_id",
        "project",
        "environment",
        "kind",
        "name",
        "managed_by",
        "spec_json",
        "phase",
        "generation",
        "observed_generation",
        "outputs_json",
        "conditions_json",
        "labels_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["space_id", "kind", "name"]],
      indexes: [["space_id"]],
    },
    {
      name: "takosumi_resolution_locks",
      domain: "resources",
      columns: [
        "resource_id",
        "selected_implementation",
        "target",
        "locked",
        "reason_json",
        "portability",
        "native_resources_json",
        "locked_at",
        "updated_at",
      ],
      primaryKey: ["resource_id"],
    },
    {
      name: "takosumi_target_pools",
      domain: "resources",
      columns: [
        "id",
        "space_id",
        "name",
        "spec_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["space_id", "name"]],
      indexes: [["space_id"]],
    },
    {
      name: "takosumi_space_policies",
      domain: "resources",
      columns: [
        "id",
        "space_id",
        "name",
        "spec_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["space_id", "name"]],
      indexes: [["space_id"]],
    },
  ]);

export const postgresStorageMigrationStatements: readonly StorageMigrationStatement[] =
  Object.freeze([
    {
      id: "storage_migrations.create",
      version: 1,
      domain: "system",
      description: "Create storage migration ledger.",
      sql: "create table if not exists storage_migrations (id text primary key, version integer not null, applied_at timestamptz not null default now())",
      // The system ledger itself is intentionally forward-only: dropping it
      // erases the ability to track which down migrations have been applied.
      // Operators wanting a true factory-reset must drop the database.
    },
    {
      id: "core.tables.create",
      version: 2,
      domain: "core",
      description: "Create Takosumi spaces, groups, and memberships tables.",
      sql: `create table if not exists spaces (id text primary key, name text not null, metadata_json jsonb not null, created_by_account_id text not null, created_at timestamptz not null, updated_at timestamptz not null);
create table if not exists space_groups (id text primary key, space_id text not null references spaces(id), slug text not null, display_name text not null, metadata_json jsonb not null, created_by_account_id text not null, created_at timestamptz not null, updated_at timestamptz not null, unique (space_id, slug));
create table if not exists space_memberships (id text primary key, space_id text not null references spaces(id), account_id text not null, roles_json jsonb not null, status text not null, created_at timestamptz not null, updated_at timestamptz not null, unique (space_id, account_id));`,
      down: `drop table if exists space_memberships;
drop table if exists space_groups;
drop table if exists spaces;`,
    },
    {
      id: "resources.tables.create",
      version: 4,
      domain: "resources",
      description:
        "Create resource instance, binding, binding-set revision, and migration ledger tables.",
      sql: `create table if not exists resource_instances (id text primary key, space_id text not null, group_id text, contract text not null, origin text not null, sharing_mode text not null, provider text, provider_resource_id text, provider_materialization_id text, lifecycle_json jsonb not null, schema_owner_json jsonb, properties_json jsonb, created_at timestamptz not null, updated_at timestamptz not null);
create table if not exists resource_bindings (id text primary key, space_id text not null, group_id text not null, claim_address text not null, instance_id text not null references resource_instances(id), role text not null, created_at timestamptz not null, updated_at timestamptz not null);
create table if not exists resource_binding_set_revisions (id text primary key, space_id text not null, group_id text not null, binding_value_resolutions_json jsonb not null default '[]'::jsonb, created_at timestamptz not null);
create table if not exists resource_migration_ledger (id text primary key, space_id text not null, resource_instance_id text not null references resource_instances(id), migration_ref text not null, from_version text, to_version text, status text not null, checkpoints_json jsonb not null, started_at timestamptz not null, completed_at timestamptz, metadata_json jsonb);`,
      down: `drop table if exists resource_migration_ledger;
drop table if exists resource_binding_set_revisions;
drop table if exists resource_bindings;
drop table if exists resource_instances;`,
    },
    {
      id: "registry.tables.create",
      version: 5,
      domain: "registry",
      description:
        "Create package registry descriptor, resolution, and trust tables.",
      sql: `create table if not exists registry_package_descriptors (kind text not null, ref text not null, digest text not null, publisher text not null, version text, body_json jsonb not null, published_at timestamptz not null, primary key (kind, ref, digest));
create table if not exists registry_package_resolutions (kind text not null, ref text not null, digest text not null, registry text not null, trust_record_id text, resolved_at timestamptz not null, primary key (kind, ref, digest));
create table if not exists registry_trust_records (id text primary key, package_ref text not null, package_digest text not null, package_kind text not null, trust_level text not null, status text not null, conformance_tier text not null, verified_by text not null, verified_at timestamptz not null, revoked_at timestamptz, reason text);`,
      down: `drop table if exists registry_trust_records;
drop table if exists registry_package_resolutions;
drop table if exists registry_package_descriptors;`,
    },
    {
      id: "audit.tables.create",
      version: 6,
      domain: "audit",
      description: "Create immutable audit event table.",
      sql: "create table if not exists audit_events (id text primary key, event_class text not null, type text not null, severity text not null, actor_json jsonb, space_id text, group_id text, target_type text not null, target_id text, payload_json jsonb not null, occurred_at timestamptz not null, request_id text, correlation_id text)",
      down: "drop table if exists audit_events;",
    },
    {
      id: "resources.bindings.claim_index.create",
      version: 8,
      domain: "resources",
      description: "Index resource bindings by group and claim address.",
      sql: `create index if not exists resource_bindings_group_claim_address_idx on resource_bindings (group_id, claim_address);`,
      down: `drop index if exists resource_bindings_group_claim_address_idx;`,
    },
    {
      id: "runtime.agent_work_ledger.create",
      version: 11,
      domain: "runtime",
      description:
        "Create persistent runtime agent registry + work ledger so leases survive service restarts (Phase 18 / C5).",
      sql: `create table if not exists runtime_agents (
  id                  text        primary key,
  provider            text        not null,
  endpoint            text,
  capabilities_json   jsonb       not null default '{}'::jsonb,
  status              text        not null
    check (status in ('registered','ready','draining','revoked','expired')),
  registered_at       timestamptz not null,
  last_heartbeat_at   timestamptz not null,
  drain_requested_at  timestamptz,
  revoked_at          timestamptz,
  expired_at          timestamptz,
  host_key_digest     text,
  metadata_json       jsonb       not null default '{}'::jsonb
);
create index if not exists runtime_agents_status_idx on runtime_agents (status);
create index if not exists runtime_agents_last_heartbeat_idx on runtime_agents (last_heartbeat_at);
create table if not exists runtime_agent_work_items (
  id                  text        primary key,
  agent_id            text        references runtime_agents(id),
  kind                text        not null,
  status              text        not null
    check (status in ('queued','leased','completed','failed','cancelled')),
  operation_id        text,
  provider            text,
  priority            integer     not null default 0,
  payload_json        jsonb       not null default '{}'::jsonb,
  metadata_json       jsonb       not null default '{}'::jsonb,
  queued_at           timestamptz not null,
  leased_at           timestamptz,
  lease_id            text,
  lease_expires_at    timestamptz,
  completed_at        timestamptz,
  failed_at           timestamptz,
  failure_reason      text,
  attempts            integer     not null default 0,
  idempotency_key     text,
  last_progress_json  jsonb,
  last_progress_at    timestamptz,
  result_json         jsonb
);
create unique index if not exists runtime_agent_work_items_idempotency_key_idx
  on runtime_agent_work_items (idempotency_key)
  where idempotency_key is not null and status in ('queued','leased');
create index if not exists runtime_agent_work_items_status_idx on runtime_agent_work_items (status);
create index if not exists runtime_agent_work_items_agent_idx on runtime_agent_work_items (agent_id);
create index if not exists runtime_agent_work_items_lease_expires_idx on runtime_agent_work_items (lease_expires_at);
create index if not exists runtime_agent_work_items_operation_idx on runtime_agent_work_items (operation_id);`,
      down: `drop table if exists runtime_agent_work_items;
drop table if exists runtime_agents;`,
    },
    {
      id: "audit.hash_chain_and_retention.add",
      version: 12,
      domain: "audit",
      description:
        "Add tamper-evident hash chain columns + archived retention flag to audit_events (Phase 18 / C9).",
      sql: `alter table audit_events add column if not exists sequence bigint;
alter table audit_events add column if not exists previous_hash text;
alter table audit_events add column if not exists current_hash text;
alter table audit_events add column if not exists archived boolean not null default false;
create unique index if not exists audit_events_sequence_idx on audit_events (sequence);
create index if not exists audit_events_archived_idx on audit_events (archived);
create index if not exists audit_events_occurred_at_idx on audit_events (occurred_at);`,
      down: `drop index if exists audit_events_occurred_at_idx;
drop index if exists audit_events_archived_idx;
drop index if exists audit_events_sequence_idx;
alter table audit_events drop column if exists archived;
alter table audit_events drop column if exists current_hash;
alter table audit_events drop column if exists previous_hash;
alter table audit_events drop column if exists sequence;`,
    },
    {
      id: "runtime.materialization_state.create",
      version: 13,
      domain: "runtime",
      description:
        "Create runtime desired/observed state tables referenced by the runtime storage catalog.",
      sql: `create table if not exists runtime_desired_states (
  id              text        primary key,
  space_id        text        not null,
  group_id        text        not null,
  activation_id   text        not null,
  state_json      jsonb       not null,
  materialized_at timestamptz not null
);
create index if not exists runtime_desired_states_group_idx
  on runtime_desired_states (space_id, group_id);
create index if not exists runtime_desired_states_activation_idx
  on runtime_desired_states (activation_id);
create table if not exists runtime_observed_states (
  id            text        primary key,
  space_id      text        not null,
  group_id      text        not null,
  snapshot_json jsonb       not null,
  observed_at   timestamptz not null
);
create index if not exists runtime_observed_states_group_idx
  on runtime_observed_states (space_id, group_id);
create index if not exists runtime_observed_states_observed_at_idx
  on runtime_observed_states (observed_at desc);
create table if not exists runtime_provider_observations (
  id                 text        primary key default md5(random()::text || clock_timestamp()::text),
  materialization_id text        not null,
  observation_json   jsonb       not null,
  observed_at        timestamptz not null
);
create index if not exists runtime_provider_observations_materialization_idx
  on runtime_provider_observations (materialization_id);
create index if not exists runtime_provider_observations_observed_at_idx
  on runtime_provider_observations (observed_at desc);`,
      down: `drop table if exists runtime_provider_observations;
drop table if exists runtime_observed_states;
drop table if exists runtime_desired_states;`,
    },
    {
      id: "service_endpoints.tables.create",
      version: 15,
      domain: "service-endpoints",
      description:
        "Create service endpoint, trust-record, and grant tables referenced by the service endpoint storage catalog.",
      sql: `create table if not exists service_endpoints (
  id            text        primary key,
  service_id    text        not null,
  space_id      text        not null,
  group_id      text        not null,
  endpoint_json jsonb       not null,
  updated_at    timestamptz not null
);
create index if not exists service_endpoints_service_idx on service_endpoints (service_id);
create index if not exists service_endpoints_group_idx on service_endpoints (space_id, group_id);
create table if not exists service_trust_records (
  id                text        primary key,
  endpoint_id       text        not null references service_endpoints(id),
  trust_record_json jsonb       not null,
  updated_at        timestamptz not null
);
create index if not exists service_trust_records_endpoint_idx
  on service_trust_records (endpoint_id);
create table if not exists service_grants (
  id              text  primary key,
  trust_record_id text  not null references service_trust_records(id),
  subject         text  not null,
  grant_json      jsonb not null
);
create index if not exists service_grants_trust_record_idx on service_grants (trust_record_id);
create index if not exists service_grants_subject_idx on service_grants (subject);`,
      down: `drop table if exists service_grants;
drop table if exists service_trust_records;
drop table if exists service_endpoints;`,
    },
    {
      id: "custom_domain.reservations.create",
      version: 16,
      domain: "custom-domain",
      description:
        "Create service-side custom domain reservations table for cross-tenant collision detection.",
      sql: `create table if not exists custom_domain_reservations (
  hostname              text        primary key,
  owner_tenant_id       text        not null,
  owner_group_id        text        not null,
  owner_deployment_id   text        not null,
  status                text        not null
    check (status in ('pending','verified','released')),
  reserved_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists custom_domain_reservations_owner_idx
  on custom_domain_reservations (owner_tenant_id, owner_group_id);
create index if not exists custom_domain_reservations_deployment_idx
  on custom_domain_reservations (owner_deployment_id);
create index if not exists custom_domain_reservations_status_idx
  on custom_domain_reservations (status);`,
      down: "drop table if exists custom_domain_reservations;",
    },
    {
      id: "internal_auth.replay_protection_log.create",
      version: 19,
      domain: "internal-auth",
      description:
        "Create distributed replay protection log so multiple Takosumi replicas share one source of truth for observed signed internal RPC request-ids (Phase 18.3 / M4).",
      sql: `create table if not exists internal_request_replay_log (
  namespace      text   not null
    check (namespace in ('internal-request','internal-response')),
  request_id     text   not null,
  timestamp_ms   bigint not null,
  expires_at_ms  bigint not null,
  seen_at_ms     bigint not null,
  primary key (namespace, request_id)
);
create index if not exists internal_request_replay_log_expires_idx
  on internal_request_replay_log (expires_at_ms);`,
      down: `drop index if exists internal_request_replay_log_expires_idx;
drop table if exists internal_request_replay_log;`,
    },
    {
      id: "deploy.takosumi_deployment_records.create",
      version: 20,
      domain: "deploy",
      description:
        "Persist deployment record evidence for artifact retention and revoke cleanup.",
      sql: `create table if not exists takosumi_deployment_records (
  id                     text        primary key,
  tenant_id              text        not null,
  name                   text        not null,
  source_evidence_json   jsonb       not null,
  applied_resources_json jsonb       not null default '[]'::jsonb,
  status                 text        not null
    check (status in ('applied','destroyed','failed')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists takosumi_deployment_records_tenant_idx
  on takosumi_deployment_records (tenant_id);
create index if not exists takosumi_deployment_records_status_idx
  on takosumi_deployment_records (status);`,
      down: `drop index if exists takosumi_deployment_records_status_idx;
drop index if exists takosumi_deployment_records_tenant_idx;
drop table if exists takosumi_deployment_records;`,
    },
    {
      id: "deploy.takosumi_deployment_record_locks.create",
      version: 22,
      domain: "deploy",
      description:
        "Persist deployment record lease locks so same apply or destroy cleanup updates are fenced across service pods.",
      sql: `create table if not exists takosumi_deployment_record_locks (
  tenant_id    text        not null,
  name         text        not null,
  owner_token  text        not null,
  locked_until timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, name)
);
create index if not exists takosumi_deployment_record_locks_locked_until_idx
  on takosumi_deployment_record_locks (locked_until);`,
      down: `drop index if exists takosumi_deployment_record_locks_locked_until_idx;
drop table if exists takosumi_deployment_record_locks;`,
    },
    {
      id: "deploy.takosumi_revoke_debts.create",
      version: 24,
      domain: "deploy",
      description:
        "Persist RevokeDebt records created by deploy record cleanup paths.",
      sql: `create table if not exists takosumi_revoke_debts (
  id                        text        primary key,
  source_key                text        not null unique,
  generated_object_id       text        not null,
  source_export_snapshot_id text,
  external_participant_id   text,
  reason                    text        not null
    check (reason in ('external-revoke','link-revoke','activation-rollback','approval-invalidated','cross-space-share-expired')),
  status                    text        not null
    check (status in ('open','operator-action-required','cleared')),
  owner_space_id            text        not null,
  originating_space_id      text        not null,
  deployment_name           text,
  operation_plan_digest     text,
  journal_entry_id          text,
  operation_id              text,
  resource_name             text,
  provider_id               text,
  retry_policy_json         jsonb       not null,
  retry_attempts            integer     not null default 0,
  last_retry_at             timestamptz,
  next_retry_at             timestamptz,
  last_retry_error_json     jsonb,
  detail_json               jsonb,
  created_at                timestamptz not null default now(),
  status_updated_at         timestamptz not null default now(),
  aged_at                   timestamptz,
  cleared_at                timestamptz
);
create index if not exists takosumi_revoke_debts_owner_idx
  on takosumi_revoke_debts (owner_space_id, status);
create index if not exists takosumi_revoke_debts_deployment_idx
  on takosumi_revoke_debts (owner_space_id, deployment_name);
create index if not exists takosumi_revoke_debts_operation_plan_idx
  on takosumi_revoke_debts (owner_space_id, operation_plan_digest);
create index if not exists takosumi_revoke_debts_next_retry_idx
  on takosumi_revoke_debts (owner_space_id, status, next_retry_at);
create index if not exists takosumi_revoke_debts_created_at_idx
  on takosumi_revoke_debts (created_at);`,
      down: `drop index if exists takosumi_revoke_debts_created_at_idx;
drop index if exists takosumi_revoke_debts_next_retry_idx;
drop index if exists takosumi_revoke_debts_operation_plan_idx;
drop index if exists takosumi_revoke_debts_deployment_idx;
drop index if exists takosumi_revoke_debts_owner_idx;
drop table if exists takosumi_revoke_debts;`,
    },
    {
      id: "registry.catalog_releases.create",
      version: 25,
      domain: "registry",
      description:
        "Persist CatalogRelease publisher keys, signed descriptors, and per-Space adoption records.",
      sql: `create table if not exists registry_catalog_publisher_keys (
  key_id            text        primary key,
  publisher_id      text        not null,
  public_key_base64 text        not null,
  status            text        not null
    check (status in ('active','revoked')),
  enrolled_at       timestamptz not null,
  revoked_at        timestamptz,
  reason            text
);
create index if not exists registry_catalog_publisher_keys_publisher_idx
  on registry_catalog_publisher_keys (publisher_id);
create index if not exists registry_catalog_publisher_keys_status_idx
  on registry_catalog_publisher_keys (status);
create table if not exists registry_catalog_releases (
  release_id          text        primary key,
  publisher_id        text        not null,
  descriptor_digest   text        not null,
  descriptor_json     jsonb       not null,
  signature_algorithm text        not null,
  signature_key_id    text        not null,
  signature_value     text        not null,
  created_at          timestamptz not null,
  activated_at        timestamptz
);
create index if not exists registry_catalog_releases_publisher_idx
  on registry_catalog_releases (publisher_id);
create index if not exists registry_catalog_releases_digest_idx
  on registry_catalog_releases (descriptor_digest);
create index if not exists registry_catalog_releases_created_at_idx
  on registry_catalog_releases (created_at);
create table if not exists registry_catalog_release_adoptions (
  id                               text        primary key,
  space_id                         text        not null,
  catalog_release_id               text        not null
    references registry_catalog_releases(release_id),
  publisher_id                     text        not null,
  publisher_key_id                 text        not null
    references registry_catalog_publisher_keys(key_id),
  descriptor_digest                text        not null,
  adopted_at                       timestamptz not null,
  rotated_from_catalog_release_id  text,
  verification_json                jsonb       not null,
  unique (space_id, catalog_release_id)
);
create index if not exists registry_catalog_release_adoptions_space_idx
  on registry_catalog_release_adoptions (space_id, adopted_at);
create index if not exists registry_catalog_release_adoptions_release_idx
  on registry_catalog_release_adoptions (catalog_release_id);
create index if not exists registry_catalog_release_adoptions_key_idx
  on registry_catalog_release_adoptions (publisher_key_id);`,
      down: `drop index if exists registry_catalog_release_adoptions_key_idx;
drop index if exists registry_catalog_release_adoptions_release_idx;
drop index if exists registry_catalog_release_adoptions_space_idx;
drop table if exists registry_catalog_release_adoptions;
drop index if exists registry_catalog_releases_created_at_idx;
drop index if exists registry_catalog_releases_digest_idx;
drop index if exists registry_catalog_releases_publisher_idx;
drop table if exists registry_catalog_releases;
drop index if exists registry_catalog_publisher_keys_status_idx;
drop index if exists registry_catalog_publisher_keys_publisher_idx;
drop table if exists registry_catalog_publisher_keys;`,
    },
    {
      id: "deploy.opentofu_run_ledger.create",
      version: 29,
      domain: "deploy",
      description: "Create the OpenTofu-native PlanRun and ApplyRun ledger.",
      sql: `create table if not exists takosumi_runner_profiles (
  id           text   primary key,
  profile_json jsonb  not null,
  created_at   bigint not null
);
create table if not exists takosumi_plan_runs (
  id                text   primary key,
  space_id          text   not null,
  installation_id   text,
  runner_profile_id text   not null,
  status            text   not null
    check (status in ('queued','running','succeeded','failed','blocked','cancelled')),
  run_json          jsonb  not null,
  created_at        bigint not null,
  updated_at        bigint not null
);
create index if not exists takosumi_plan_runs_space_idx
  on takosumi_plan_runs (space_id);
create index if not exists takosumi_plan_runs_installation_idx
  on takosumi_plan_runs (installation_id);
create index if not exists takosumi_plan_runs_status_idx
  on takosumi_plan_runs (status);
create index if not exists takosumi_plan_runs_created_at_idx
  on takosumi_plan_runs (created_at);
create table if not exists takosumi_apply_runs (
  id                text   primary key,
  plan_run_id       text   not null,
  space_id          text   not null,
  installation_id   text,
  deployment_id     text,
  runner_profile_id text   not null,
  status            text   not null
    check (status in ('queued','running','succeeded','failed','blocked','cancelled')),
  run_json          jsonb  not null,
  created_at        bigint not null,
  updated_at        bigint not null
);
create index if not exists takosumi_apply_runs_plan_idx
  on takosumi_apply_runs (plan_run_id);
create index if not exists takosumi_apply_runs_space_idx
  on takosumi_apply_runs (space_id);
create index if not exists takosumi_apply_runs_installation_idx
  on takosumi_apply_runs (installation_id);
create index if not exists takosumi_apply_runs_status_idx
  on takosumi_apply_runs (status);
create table if not exists takosumi_destroy_runs (
  id                text   primary key,
  installation_id   text   not null,
  space_id          text   not null,
  runner_profile_id text   not null,
  status            text   not null
    check (status in ('queued','running','succeeded','failed','blocked','cancelled')),
  run_json          jsonb  not null,
  created_at        bigint not null,
  updated_at        bigint not null
);
create index if not exists takosumi_destroy_runs_installation_idx
  on takosumi_destroy_runs (installation_id);
create index if not exists takosumi_destroy_runs_space_idx
  on takosumi_destroy_runs (space_id);
create index if not exists takosumi_destroy_runs_status_idx
  on takosumi_destroy_runs (status);
create table if not exists takosumi_opentofu_installations (
  id                    text   primary key,
  space_id              text   not null,
  app_id                text   not null,
  current_deployment_id text,
  runner_profile_id     text   not null,
  status                text   not null
    check (status in ('installing','ready','failed','destroying','destroyed','suspended')),
  installation_json     jsonb  not null,
  created_at            bigint not null,
  updated_at            bigint not null
);
create index if not exists takosumi_opentofu_installations_space_idx
  on takosumi_opentofu_installations (space_id);
create index if not exists takosumi_opentofu_installations_current_deployment_idx
  on takosumi_opentofu_installations (current_deployment_id);
create index if not exists takosumi_opentofu_installations_created_at_idx
  on takosumi_opentofu_installations (created_at);
create table if not exists takosumi_opentofu_deployments (
  id                text   primary key,
  installation_id   text   not null,
  plan_run_id       text   not null,
  apply_run_id      text   not null,
  runner_profile_id text   not null,
  status            text   not null
    check (status in ('running','succeeded','failed','destroyed')),
  deployment_json   jsonb  not null,
  created_at        bigint not null,
  completed_at      bigint
);
create index if not exists takosumi_opentofu_deployments_installation_idx
  on takosumi_opentofu_deployments (installation_id);
create index if not exists takosumi_opentofu_deployments_plan_idx
  on takosumi_opentofu_deployments (plan_run_id);
create index if not exists takosumi_opentofu_deployments_apply_idx
  on takosumi_opentofu_deployments (apply_run_id);
create index if not exists takosumi_opentofu_deployments_created_at_idx
  on takosumi_opentofu_deployments (created_at);`,
      down: `drop index if exists takosumi_opentofu_deployments_created_at_idx;
drop index if exists takosumi_opentofu_deployments_apply_idx;
drop index if exists takosumi_opentofu_deployments_plan_idx;
drop index if exists takosumi_opentofu_deployments_installation_idx;
drop table if exists takosumi_opentofu_deployments;
drop index if exists takosumi_opentofu_installations_created_at_idx;
drop index if exists takosumi_opentofu_installations_current_deployment_idx;
drop index if exists takosumi_opentofu_installations_space_idx;
drop table if exists takosumi_opentofu_installations;
drop index if exists takosumi_destroy_runs_status_idx;
drop index if exists takosumi_destroy_runs_space_idx;
drop index if exists takosumi_destroy_runs_installation_idx;
drop table if exists takosumi_destroy_runs;
drop index if exists takosumi_apply_runs_status_idx;
drop index if exists takosumi_apply_runs_installation_idx;
drop index if exists takosumi_apply_runs_space_idx;
drop index if exists takosumi_apply_runs_plan_idx;
drop table if exists takosumi_apply_runs;
drop index if exists takosumi_plan_runs_created_at_idx;
drop index if exists takosumi_plan_runs_status_idx;
drop index if exists takosumi_plan_runs_installation_idx;
drop index if exists takosumi_plan_runs_space_idx;
drop table if exists takosumi_plan_runs;
drop table if exists takosumi_runner_profiles;`,
    },
    {
      id: "deploy.takosumi_connections.create",
      version: 30,
      domain: "deploy",
      description:
        "Create the Connection (provider credential registration) ledger and its sealed secret-blob sidecar. The blob column stores ciphertext only; plaintext credential values never land in the database.",
      sql: `create table if not exists takosumi_connections (
  id              text   primary key,
  space_id        text,
  provider        text   not null,
  status          text   not null
    check (status in ('pending','verified','revoked')),
  connection_json jsonb  not null,
  created_at      text   not null,
  updated_at      text   not null
);
create index if not exists takosumi_connections_space_idx
  on takosumi_connections (space_id);
create index if not exists takosumi_connections_status_idx
  on takosumi_connections (status);
create table if not exists takosumi_connection_secret_blobs (
  id            text  primary key,
  connection_id text  not null,
  space_id      text,
  kind          text  not null,
  ciphertext    text  not null,
  encrypted_dek text  not null,
  nonce         text  not null,
  aad           text  not null,
  key_version   int   not null,
  created_at    text  not null,
  rotated_at    text,
  blob_json     jsonb not null
);
create unique index if not exists takosumi_connection_secret_blobs_connection_idx
  on takosumi_connection_secret_blobs (connection_id);`,
      down: `drop table if exists takosumi_connection_secret_blobs;
drop index if exists takosumi_connections_status_idx;
drop index if exists takosumi_connections_space_idx;
drop table if exists takosumi_connections;`,
    },
    {
      id: "deploy.takosumi_plan_run_inputs.create",
      version: 31,
      domain: "deploy",
      description:
        "Create the internal plan-run inputs sidecar so the async run-queue consumer can re-run a queued plan with the submitted OpenTofu variables. Never projected into the public ledger; removed when the run reaches a terminal state.",
      sql: `create table if not exists takosumi_plan_run_inputs (
  plan_run_id text  primary key,
  inputs_json jsonb not null
);`,
      down: `drop table if exists takosumi_plan_run_inputs;`,
    },
    {
      id: "deploy.takosumi_sources.create",
      version: 32,
      domain: "deploy",
      description:
        "Create the Source / SourceSnapshot / SourceSyncRun ledger (Core Specification §6). source_json carries the public Source plus internal hook-secret hash / lastSeenCommit / autoSync; the hook-secret plaintext and any git credential value never land in the database.",
      sql: `create table if not exists takosumi_sources (
  id          text   primary key,
  space_id    text   not null,
  status      text   not null
    check (status in ('active','disabled','error')),
  source_json jsonb  not null,
  created_at  text   not null,
  updated_at  text   not null
);
create index if not exists takosumi_sources_space_idx
  on takosumi_sources (space_id);
create index if not exists takosumi_sources_status_idx
  on takosumi_sources (status);
create table if not exists takosumi_source_snapshots (
  id            text   primary key,
  source_id     text   not null,
  snapshot_json jsonb  not null,
  fetched_at    text   not null
);
create index if not exists takosumi_source_snapshots_source_idx
  on takosumi_source_snapshots (source_id, fetched_at);
create table if not exists takosumi_source_sync_runs (
  id         text   primary key,
  source_id  text   not null,
  space_id   text   not null,
  status     text   not null
    check (status in ('queued','running','succeeded','failed')),
  run_json   jsonb  not null,
  created_at text   not null,
  updated_at text   not null
);
create index if not exists takosumi_source_sync_runs_source_idx
  on takosumi_source_sync_runs (source_id, created_at);
create index if not exists takosumi_source_sync_runs_status_idx
  on takosumi_source_sync_runs (status);`,
      down: `drop index if exists takosumi_source_sync_runs_status_idx;
drop index if exists takosumi_source_sync_runs_source_idx;
drop table if exists takosumi_source_sync_runs;
drop index if exists takosumi_source_snapshots_source_idx;
drop table if exists takosumi_source_snapshots;
drop index if exists takosumi_sources_status_idx;
drop index if exists takosumi_sources_space_idx;
drop table if exists takosumi_sources;`,
    },
    {
      id: "deploy.takosumi_lanes.create",
      version: 33,
      domain: "deploy",
      description:
        "Create the historical lane ledger. App / Environment / InstallProfile columns are compatibility table names; the current public model is Space / Source / Installation / InstallConfig plus Installation provider env bindings, with no secret values in connection rows.",
      sql: `create table if not exists takosumi_apps (
  id                 text   primary key,
  space_id           text   not null,
  source_id          text   not null,
  install_type       text   not null
    check (install_type in ('app_source','opentofu_module','opentofu_root')),
  install_profile_id text,
  app_json           jsonb  not null,
  created_at         text   not null,
  updated_at         text   not null
);
create index if not exists takosumi_apps_space_idx
  on takosumi_apps (space_id);
create index if not exists takosumi_apps_source_idx
  on takosumi_apps (source_id);
create table if not exists takosumi_environments (
  id               text   primary key,
  app_id           text   not null,
  name             text   not null,
  environment_json jsonb  not null,
  created_at       text   not null,
  updated_at       text   not null,
  unique (app_id, name)
);
create index if not exists takosumi_environments_app_idx
  on takosumi_environments (app_id);
create table if not exists takosumi_install_profiles (
  id           text   primary key,
  install_type text   not null
    check (install_type in ('app_source','opentofu_module','opentofu_root')),
  trust_level  text   not null
    check (trust_level in ('official','trusted','customer','raw')),
  profile_json jsonb  not null,
  created_at   text   not null,
  updated_at   text   not null
);
create index if not exists takosumi_install_profiles_install_type_idx
  on takosumi_install_profiles (install_type);
create index if not exists takosumi_install_profiles_trust_level_idx
  on takosumi_install_profiles (trust_level);
create table if not exists takosumi_environment_binding_sets (
  id             text   primary key,
  environment_id text   not null unique,
  profile_json   jsonb  not null,
  created_at     text   not null,
  updated_at     text   not null
);
create index if not exists takosumi_environment_binding_sets_environment_idx
  on takosumi_environment_binding_sets (environment_id);`,
      down: `drop index if exists takosumi_environment_binding_sets_environment_idx;
drop table if exists takosumi_environment_binding_sets;
drop index if exists takosumi_install_profiles_trust_level_idx;
drop index if exists takosumi_install_profiles_install_type_idx;
drop table if exists takosumi_install_profiles;
drop index if exists takosumi_environments_app_idx;
drop table if exists takosumi_environments;
drop index if exists takosumi_apps_source_idx;
drop index if exists takosumi_apps_space_idx;
drop table if exists takosumi_apps;`,
    },
    {
      id: "deploy.takosumi_state_snapshots.create",
      version: 34,
      domain: "deploy",
      description:
        "Create the StateSnapshot ledger (Core Specification §6.9). Records per-(environment, generation) OpenTofu state metadata (encrypted object key + plaintext digest) after a successful env-driven apply/destroy state persist. The encrypted state bytes live in R2_STATE; only metadata enters the database, no secret value.",
      sql: `create table if not exists takosumi_state_snapshots (
  id             text    primary key,
  environment_id text    not null,
  generation     integer not null,
  snapshot_json  jsonb   not null,
  created_at     bigint  not null,
  unique (environment_id, generation)
);
create index if not exists takosumi_state_snapshots_environment_idx
  on takosumi_state_snapshots (environment_id, generation);`,
      down: `drop index if exists takosumi_state_snapshots_environment_idx;
drop table if exists takosumi_state_snapshots;`,
    },
    {
      id: "deploy.takosumi_space_direct_model.create",
      version: 35,
      domain: "deploy",
      description:
        "Migrate the deploy-control ledger to the Space-direct Installation model (Core Specification §27). Destructively drops the retired App / Environment / InstallProfile lane tables, the split plan/apply/destroy run tables, and the App/Environment-keyed installations / deployments / provider env binding sets / state_snapshots, then creates: spaces, install_configs, the new-shape installations (UNIQUE(space_id, name, environment)), deployments, provider env binding sets (keyed (installation_id, environment)), state_snapshots (keyed (installation_id, environment, generation) UNIQUE), and a SINGLE runs table (rows discriminated by kind plan / apply / source_sync). No data migration: the prior model is pre-GA and is dropped.",
      sql: `drop table if exists takosumi_apps;
drop table if exists takosumi_environments;
drop table if exists takosumi_install_profiles;
drop table if exists takosumi_destroy_runs;
drop table if exists takosumi_plan_runs;
drop table if exists takosumi_apply_runs;
drop table if exists takosumi_environment_binding_sets;
drop table if exists takosumi_state_snapshots;
drop table if exists takosumi_opentofu_deployments;
drop table if exists takosumi_opentofu_installations;
create table if not exists takosumi_runs (
  id              text   primary key,
  kind            text   not null
    check (kind in ('source_sync','compatibility_check','plan','apply','destroy_plan','destroy_apply','drift_check','backup','restore')),
  space_id        text   not null,
  installation_id text,
  created_at      text   not null,
  run_json        jsonb  not null
);
create index if not exists takosumi_runs_kind_idx
  on takosumi_runs (kind);
create index if not exists takosumi_runs_space_idx
  on takosumi_runs (space_id);
create index if not exists takosumi_runs_installation_idx
  on takosumi_runs (installation_id);
create index if not exists takosumi_runs_created_at_idx
  on takosumi_runs (created_at);
create table if not exists takosumi_spaces (
  id          text   primary key,
  handle      text   not null unique,
  space_json  jsonb  not null,
  created_at  text   not null,
  updated_at  text   not null
);
create table if not exists takosumi_install_configs (
  id           text   primary key,
  space_id     text,
  install_type text   not null
    check (install_type in ('core','opentofu_module','opentofu_root','app_source')),
  trust_level  text   not null
    check (trust_level in ('official','trusted','space','raw')),
  config_json  jsonb  not null,
  created_at   text   not null,
  updated_at   text   not null
);
create index if not exists takosumi_install_configs_space_idx
  on takosumi_install_configs (space_id);
create index if not exists takosumi_install_configs_install_type_idx
  on takosumi_install_configs (install_type);
create table if not exists takosumi_opentofu_installations (
  id                     text   primary key,
  space_id               text   not null,
  name                   text   not null,
  environment            text   not null,
  source_id              text   not null,
  install_config_id      text   not null,
  current_deployment_id  text,
  status                 text   not null
    check (status in ('pending','active','stale','error','disabled','destroyed')),
  installation_json      jsonb  not null,
  created_at             text   not null,
  updated_at             text   not null,
  unique (space_id, name, environment)
);
create index if not exists takosumi_opentofu_installations_space_idx
  on takosumi_opentofu_installations (space_id);
create index if not exists takosumi_opentofu_installations_current_deployment_idx
  on takosumi_opentofu_installations (current_deployment_id);
create index if not exists takosumi_opentofu_installations_created_at_idx
  on takosumi_opentofu_installations (created_at);
create table if not exists takosumi_opentofu_deployments (
  id               text    primary key,
  space_id         text    not null,
  installation_id  text    not null,
  environment      text    not null,
  apply_run_id     text    not null,
  source_snapshot_id text  not null,
  dependency_snapshot_id text,
  state_generation integer not null,
  output_snapshot_id text  not null,
  status           text    not null
    check (status in ('active','superseded','rolled_back','destroyed')),
  deployment_json  jsonb   not null,
  created_at       text    not null
);
create index if not exists takosumi_opentofu_deployments_installation_idx
  on takosumi_opentofu_deployments (installation_id);
create index if not exists takosumi_opentofu_deployments_space_idx
  on takosumi_opentofu_deployments (space_id);
create index if not exists takosumi_opentofu_deployments_apply_idx
  on takosumi_opentofu_deployments (apply_run_id);
create index if not exists takosumi_opentofu_deployments_created_at_idx
  on takosumi_opentofu_deployments (created_at);
create table if not exists takosumi_provider_env_binding_sets (
  id              text   primary key,
  space_id        text   not null,
  installation_id text   not null,
  environment     text   not null,
  profile_json    jsonb  not null,
  created_at      text   not null,
  updated_at      text   not null,
  unique (installation_id, environment)
);
create index if not exists takosumi_provider_env_bindings_installation_idx
  on takosumi_provider_env_binding_sets (installation_id, environment);
create table if not exists takosumi_state_snapshots (
  id              text    primary key,
  space_id        text    not null,
  installation_id text    not null,
  environment     text    not null,
  generation      integer not null,
  snapshot_json   jsonb   not null,
  created_at      text    not null,
  unique (installation_id, environment, generation)
);
create index if not exists takosumi_state_snapshots_installation_idx
  on takosumi_state_snapshots (installation_id, environment, generation);`,
      down: `drop index if exists takosumi_state_snapshots_installation_idx;
drop table if exists takosumi_state_snapshots;
drop index if exists takosumi_provider_env_bindings_installation_idx;
drop table if exists takosumi_provider_env_binding_sets;
drop index if exists takosumi_opentofu_deployments_created_at_idx;
drop index if exists takosumi_opentofu_deployments_apply_idx;
drop index if exists takosumi_opentofu_deployments_space_idx;
drop index if exists takosumi_opentofu_deployments_installation_idx;
drop table if exists takosumi_opentofu_deployments;
drop index if exists takosumi_opentofu_installations_created_at_idx;
drop index if exists takosumi_opentofu_installations_current_deployment_idx;
drop index if exists takosumi_opentofu_installations_space_idx;
drop table if exists takosumi_opentofu_installations;
drop index if exists takosumi_install_configs_install_type_idx;
drop index if exists takosumi_install_configs_space_idx;
drop table if exists takosumi_install_configs;
drop table if exists takosumi_spaces;
drop index if exists takosumi_runs_created_at_idx;
drop index if exists takosumi_runs_installation_idx;
drop index if exists takosumi_runs_space_idx;
drop index if exists takosumi_runs_kind_idx;
drop table if exists takosumi_runs;`,
    },
    {
      id: "deploy.takosumi_dependency_dag.create",
      version: 36,
      domain: "deploy",
      description:
        "Create the Dependency DAG ledger (Core Specification §14-§19 / §24 / §27): installation_dependencies (producer->consumer output edges within a Space), dependency_snapshots (plan-time pin of one run's injected inputs, §17), output_snapshots (the projected spaceOutputs / publicOutputs + digest captured after a successful apply, §16; the raw envelope stays an encrypted R2_ARTIFACTS artifact), and run_groups (ordered groups of Runs across the DAG for a Space update, §19/§24; the group status is computed at read time and is not a stored column). No data migration: additive new tables.",
      sql: `create table if not exists takosumi_installation_dependencies (
  id                        text   primary key,
  space_id                  text   not null,
  producer_installation_id  text   not null,
  consumer_installation_id  text   not null,
  dependency_json           jsonb  not null,
  created_at                text   not null
);
create index if not exists takosumi_installation_dependencies_space_idx
  on takosumi_installation_dependencies (space_id);
create index if not exists takosumi_installation_dependencies_producer_idx
  on takosumi_installation_dependencies (producer_installation_id);
create index if not exists takosumi_installation_dependencies_consumer_idx
  on takosumi_installation_dependencies (consumer_installation_id);
create table if not exists takosumi_dependency_snapshots (
  id            text   primary key,
  run_id        text   not null,
  snapshot_json jsonb  not null,
  created_at    text   not null
);
create index if not exists takosumi_dependency_snapshots_run_idx
  on takosumi_dependency_snapshots (run_id);
create table if not exists takosumi_output_snapshots (
  id               text    primary key,
  space_id         text    not null,
  installation_id  text    not null,
  state_generation integer not null,
  snapshot_json    jsonb   not null,
  created_at       text    not null
);
create index if not exists takosumi_output_snapshots_installation_idx
  on takosumi_output_snapshots (installation_id, state_generation);
create table if not exists takosumi_run_groups (
  id         text   primary key,
  space_id   text   not null,
  type       text   not null
    check (type in ('space_update','space_drift_check','installation_install','installation_update','installation_destroy')),
  group_json jsonb  not null,
  created_at text   not null
);
create index if not exists takosumi_run_groups_space_idx
  on takosumi_run_groups (space_id);`,
      down: `drop index if exists takosumi_run_groups_space_idx;
drop table if exists takosumi_run_groups;
drop index if exists takosumi_output_snapshots_installation_idx;
drop table if exists takosumi_output_snapshots;
drop index if exists takosumi_dependency_snapshots_run_idx;
drop table if exists takosumi_dependency_snapshots;
drop index if exists takosumi_installation_dependencies_consumer_idx;
drop index if exists takosumi_installation_dependencies_producer_idx;
drop index if exists takosumi_installation_dependencies_space_idx;
drop table if exists takosumi_installation_dependencies;`,
    },
    {
      id: "deploy.takosumi_audit_events.create",
      version: 37,
      domain: "deploy",
      description:
        "Create the Activity audit ledger (Core Specification §27 audit_events / §34 Activity): the Space-scoped audit trail surfaced in the dashboard Activity view. One row records a single state-changing action inside a Space (installation created, plan/apply/destroy milestone, dependency added/removed, stale propagation, run_group created). Searchable columns (space_id / created_at) drive the newest-first listing; the full non-secret event (identifiers / names / digests / counts only — never secret material or output VALUES) round trips through event_json. No data migration: additive new table.",
      sql: `create table if not exists takosumi_audit_events (
  id          text   primary key,
  space_id    text   not null,
  actor_id    text,
  action      text   not null,
  target_type text   not null,
  target_id   text   not null,
  run_id      text,
  event_json  jsonb  not null,
  created_at  text   not null
);
create index if not exists takosumi_audit_events_space_idx
  on takosumi_audit_events (space_id, created_at desc);`,
      down: `drop index if exists takosumi_audit_events_space_idx;
drop table if exists takosumi_audit_events;`,
    },
    {
      id: "deploy.takosumi_output_shares.create",
      version: 38,
      domain: "deploy",
      description:
        "Create the cross-Space OutputShare ledger (Core Specification §18 output_shares): a grant from a producer Installation's projected spaceOutputs (in from_space_id) to a consumer Space (to_space_id). share_json carries the public OutputShare — entry names + optional aliases only; sensitive entries require explicit policy and resolved output VALUES never land in the share. Searchable columns (from_space_id / to_space_id / producer_installation_id) drive the per-Space listings. No data migration: additive new table.",
      sql: `create table if not exists takosumi_output_shares (
  id                       text   primary key,
  from_space_id            text   not null,
  to_space_id              text   not null,
  producer_installation_id text   not null,
  status                   text   not null
    check (status in ('pending','active','revoked')),
  share_json               jsonb  not null,
  created_at               text   not null
);
create index if not exists takosumi_output_shares_from_space_idx
  on takosumi_output_shares (from_space_id, created_at);
create index if not exists takosumi_output_shares_to_space_idx
  on takosumi_output_shares (to_space_id, created_at);
create index if not exists takosumi_output_shares_producer_idx
  on takosumi_output_shares (producer_installation_id);`,
      down: `drop index if exists takosumi_output_shares_producer_idx;
drop index if exists takosumi_output_shares_to_space_idx;
drop index if exists takosumi_output_shares_from_space_idx;
drop table if exists takosumi_output_shares;`,
    },
    {
      id: "deploy.takosumi_backups.create",
      version: 39,
      domain: "deploy",
      description:
        "Create the control-backup ledger (Core Specification §33 layer 1 / §26 R2_BACKUPS): one pointer row per sealed control-backup bundle written to the R2_BACKUPS bucket. backup_json carries the public BackupRecord pointer (objectKey / digest / sizeBytes / optional createdByRunId) — the bundle bytes (zstd-compressed, sealed JSON export of the Space's control ledger) live in object storage, never the DB, and the bundle never contains secret material. The space_id column drives the newest-first per-Space listing. No data migration: additive new table.",
      sql: `create table if not exists takosumi_backups (
  id                text   primary key,
  space_id          text   not null,
  installation_id   text,
  environment       text,
  backup_json       jsonb  not null,
  created_at        text   not null
);
create index if not exists takosumi_backups_space_idx
  on takosumi_backups (space_id, created_at desc);
create index if not exists takosumi_backups_installation_idx
  on takosumi_backups (installation_id);`,
      down: `drop index if exists takosumi_backups_installation_idx;
drop index if exists takosumi_backups_space_idx;
drop table if exists takosumi_backups;`,
    },
    {
      id: "deploy.takosumi_capsule_billing_security_ledgers.create",
      version: 40,
      domain: "deploy",
      description:
        "Create additive Capsule compatibility, billing, credential mint audit, and security finding ledgers for the OpenTofu Module Capsule DAG model. OSS billing configuration is disabled or showback; the legacy enforce enum value is persisted only for Cloud-injected enforcement ports.",
      sql: `create table if not exists takosumi_capsule_compatibility_reports (
  id                 text   primary key,
  source_id          text,
  installation_id    text,
  source_snapshot_id text   not null,
  level              text   not null
    check (level in ('ready','auto_capsulized','needs_patch','unsupported')),
  findings_json      jsonb  not null,
  providers_json     jsonb  not null,
  resources_json     jsonb  not null,
  data_sources_json  jsonb  not null,
  provisioners_json  jsonb  not null,
  root_module_variables_json jsonb not null default '[]'::jsonb,
  root_module_outputs_json   jsonb not null default '[]'::jsonb,
  normalized_object_key text,
  normalized_digest  text,
  created_at         text   not null
);
create index if not exists takosumi_capsule_compat_reports_source_snapshot_idx
  on takosumi_capsule_compatibility_reports (source_snapshot_id);
create index if not exists takosumi_capsule_compat_reports_source_idx
  on takosumi_capsule_compatibility_reports (source_id);
create index if not exists takosumi_capsule_compat_reports_installation_idx
  on takosumi_capsule_compatibility_reports (installation_id);
create index if not exists takosumi_capsule_compat_reports_level_idx
  on takosumi_capsule_compatibility_reports (level);
create table if not exists takosumi_billing_accounts (
  id           text  primary key,
  owner_type   text  not null
    check (owner_type in ('user','space')),
  owner_id     text  not null,
  provider     text  not null
    check (provider in ('stripe','manual','none')),
  status       text  not null,
  account_json jsonb not null,
  created_at   text  not null,
  updated_at   text  not null
);
create index if not exists takosumi_billing_accounts_owner_idx
  on takosumi_billing_accounts (owner_type, owner_id);
create index if not exists takosumi_billing_accounts_status_idx
  on takosumi_billing_accounts (status);
create table if not exists takosumi_plans (
  id                 text    primary key,
  name               text    not null,
  monthly_base_price integer not null,
  included_credits   integer not null,
  limits_json        jsonb   not null,
  plan_json          jsonb   not null,
  created_at         text    not null,
  updated_at         text    not null
);
create table if not exists takosumi_space_subscriptions (
  id                 text  primary key,
  space_id           text  not null,
  billing_account_id text  not null,
  plan_id            text  not null,
  status             text  not null,
  subscription_json  jsonb not null,
  created_at         text  not null,
  updated_at         text  not null
);
create index if not exists takosumi_space_subscriptions_space_idx
  on takosumi_space_subscriptions (space_id);
create index if not exists takosumi_space_subscriptions_billing_account_idx
  on takosumi_space_subscriptions (billing_account_id);
create table if not exists takosumi_credit_balances (
  space_id                 text    primary key,
  available_credits        integer not null,
  reserved_credits         integer not null,
  monthly_included_credits integer not null,
  purchased_credits        integer not null,
  updated_at               text    not null
);
create table if not exists takosumi_usage_events (
  id              text             primary key,
  space_id        text             not null,
  installation_id text,
  run_id          text,
  kind            text             not null,
  quantity        double precision not null,
  credits         integer          not null,
  source          text             not null,
  idempotency_key text             not null unique,
  created_at      text             not null
);
create index if not exists takosumi_usage_events_space_idx
  on takosumi_usage_events (space_id);
create index if not exists takosumi_usage_events_run_idx
  on takosumi_usage_events (run_id);
create table if not exists takosumi_credit_reservations (
  id                text    primary key,
  space_id          text    not null,
  run_id            text    not null,
  estimated_credits integer not null,
  status            text    not null
    check (status in ('reserved','captured','released','expired')),
  reservation_json  jsonb   not null,
  created_at        text    not null,
  expires_at        text    not null
);
create index if not exists takosumi_credit_reservations_space_idx
  on takosumi_credit_reservations (space_id);
create index if not exists takosumi_credit_reservations_run_idx
  on takosumi_credit_reservations (run_id);
create index if not exists takosumi_credit_reservations_status_idx
  on takosumi_credit_reservations (status);
create table if not exists takosumi_credential_mint_events (
  id              text  primary key,
  run_id          text  not null,
  space_id        text  not null,
  installation_id text,
  source_id       text,
  connection_id   text  not null,
  phase           text  not null,
  event_json      jsonb not null,
  created_at      text  not null
);
create index if not exists takosumi_credential_mint_events_run_idx
  on takosumi_credential_mint_events (run_id);
create index if not exists takosumi_credential_mint_events_space_idx
  on takosumi_credential_mint_events (space_id);
create index if not exists takosumi_credential_mint_events_source_idx
  on takosumi_credential_mint_events (source_id);
create table if not exists takosumi_security_findings (
  id              text  primary key,
  space_id        text  not null,
  installation_id text,
  run_id          text,
  severity        text  not null
    check (severity in ('info','warning','error','critical')),
  type            text  not null,
  finding_json    jsonb not null,
  created_at      text  not null
);
create index if not exists takosumi_security_findings_space_idx
  on takosumi_security_findings (space_id);
create index if not exists takosumi_security_findings_run_idx
  on takosumi_security_findings (run_id);
create index if not exists takosumi_security_findings_severity_idx
  on takosumi_security_findings (severity);`,
      down: `drop index if exists takosumi_security_findings_severity_idx;
drop index if exists takosumi_security_findings_run_idx;
drop index if exists takosumi_security_findings_space_idx;
drop table if exists takosumi_security_findings;
drop index if exists takosumi_credential_mint_events_space_idx;
drop index if exists takosumi_credential_mint_events_source_idx;
drop index if exists takosumi_credential_mint_events_run_idx;
drop table if exists takosumi_credential_mint_events;
drop index if exists takosumi_credit_reservations_status_idx;
drop index if exists takosumi_credit_reservations_run_idx;
drop index if exists takosumi_credit_reservations_space_idx;
drop table if exists takosumi_credit_reservations;
drop index if exists takosumi_usage_events_run_idx;
drop index if exists takosumi_usage_events_space_idx;
drop table if exists takosumi_usage_events;
drop table if exists takosumi_credit_balances;
drop index if exists takosumi_space_subscriptions_billing_account_idx;
drop index if exists takosumi_space_subscriptions_space_idx;
drop table if exists takosumi_space_subscriptions;
drop table if exists takosumi_plans;
drop index if exists takosumi_billing_accounts_status_idx;
drop index if exists takosumi_billing_accounts_owner_idx;
drop table if exists takosumi_billing_accounts;
drop index if exists takosumi_capsule_compat_reports_level_idx;
drop index if exists takosumi_capsule_compat_reports_source_idx;
drop index if exists takosumi_capsule_compat_reports_source_snapshot_idx;
drop index if exists takosumi_capsule_compat_reports_installation_idx;
drop table if exists takosumi_capsule_compatibility_reports;`,
    },
    {
      id: "deploy.takosumi_connections.space_id_nullable",
      version: 41,
      domain: "deploy",
      description:
        "Allow operator-scoped Connections by making takosumi_connections.space_id nullable. Current OSS ProviderConnections remain Space-scoped; nullable rows are retained for legacy/operator migration compatibility.",
      sql: `alter table takosumi_connections alter column space_id drop not null;`,
      down: `alter table takosumi_connections alter column space_id set not null;`,
    },
    {
      id: "deploy.takosumi_d1_schema_projection_columns.create",
      version: 42,
      domain: "deploy",
      description:
        "Materialize spec-visible ledger columns that had previously lived only in JSON: runs.source_id for Source-scoped source_sync rows, credit_reservations.mode for billing reservation mode queries, and backup scope columns for backup Run ledger pointers. Backfills existing source_sync source_id from run_json/source-id fallback and keeps all columns additive.",
      sql: `alter table takosumi_runs
  add column if not exists source_id text;
create index if not exists takosumi_runs_source_idx
  on takosumi_runs (source_id);
update takosumi_runs
  set source_id = coalesce(run_json->>'sourceId', installation_id),
      installation_id = null
  where kind = 'source_sync'
    and source_id is null;

alter table takosumi_credit_reservations
  add column if not exists mode text not null default 'disabled'
    check (mode in ('disabled','showback','enforce'));
update takosumi_credit_reservations
  set mode = coalesce(reservation_json->>'mode', mode);
alter table takosumi_credit_reservations
  alter column mode drop default;

alter table takosumi_backups
  add column if not exists created_by_run_id text;
alter table takosumi_backups
  add column if not exists installation_id text;
alter table takosumi_backups
  add column if not exists environment text;
create index if not exists takosumi_backups_installation_idx
  on takosumi_backups (installation_id);
update takosumi_backups
  set created_by_run_id = coalesce(created_by_run_id, backup_json->>'createdByRunId'),
      installation_id = coalesce(installation_id, backup_json->>'installationId'),
      environment = coalesce(environment, backup_json->>'environment');`,
      down: `drop index if exists takosumi_backups_installation_idx;
alter table takosumi_backups
  drop column if exists environment;
alter table takosumi_backups
  drop column if exists installation_id;
alter table takosumi_backups
  drop column if exists created_by_run_id;
alter table takosumi_credit_reservations
  drop column if exists mode;
drop index if exists takosumi_runs_source_idx;
alter table takosumi_runs
  drop column if exists source_id;`,
    },
    {
      id: "deploy.takosumi_provider_templates.create",
      version: 43,
      domain: "deploy",
      description:
        "Create the provider catalog and provider-env provider env binding ledgers for the OpenTofu Capsule DAG provider model. Catalog entries are instance-wide; provider-env provider env bindings are Space-scoped and carry JSON records plus searchable support/status/source columns.",
      sql: `create table if not exists takosumi_provider_templates_entries (
  id               text    primary key,
  provider_source  text    not null unique,
  primary_credential_source     text    not null
    check (primary_credential_source in ('takosumi_managed','user_env_set')),
  default_eligible integer not null,
  entry_json       jsonb   not null,
  created_at       text    not null,
  updated_at       text    not null
);
create index if not exists takosumi_provider_templates_entries_primary_credential_source_idx
  on takosumi_provider_templates_entries (primary_credential_source);
create index if not exists takosumi_provider_templates_entries_default_eligible_idx
  on takosumi_provider_templates_entries (default_eligible);

create table if not exists takosumi_provider_env_sets (
  id              text  primary key,
  space_id        text  not null,
  provider_source text  not null,
  status          text  not null
    check (status in ('draft','active','disabled','quarantined')),
  pack_json       jsonb not null,
  created_at      text  not null,
  updated_at      text  not null
);
create index if not exists takosumi_provider_env_sets_space_idx
  on takosumi_provider_env_sets (space_id);
create index if not exists takosumi_provider_env_sets_provider_source_idx
  on takosumi_provider_env_sets (provider_source);
create index if not exists takosumi_provider_env_sets_status_idx
  on takosumi_provider_env_sets (status);

create table if not exists takosumi_provider_env_pins (
  id               text  primary key,
  space_id         text  not null,
  provider_pack_id text  not null,
  provider_source  text  not null,
  selected_version text  not null,
  pin_json         jsonb not null,
  created_at       text  not null
);
create index if not exists takosumi_provider_env_pins_space_idx
  on takosumi_provider_env_pins (space_id);
create index if not exists takosumi_provider_env_pins_pack_idx
  on takosumi_provider_env_pins (provider_pack_id);
create index if not exists takosumi_provider_env_pins_provider_source_idx
  on takosumi_provider_env_pins (provider_source);`,
      down: `drop index if exists takosumi_provider_env_pins_provider_source_idx;
drop index if exists takosumi_provider_env_pins_pack_idx;
drop index if exists takosumi_provider_env_pins_space_idx;
drop table if exists takosumi_provider_env_pins;
drop index if exists takosumi_provider_env_sets_status_idx;
drop index if exists takosumi_provider_env_sets_provider_source_idx;
drop index if exists takosumi_provider_env_sets_space_idx;
drop table if exists takosumi_provider_env_sets;
drop index if exists takosumi_provider_templates_entries_default_eligible_idx;
drop index if exists takosumi_provider_templates_entries_primary_credential_source_idx;
drop table if exists takosumi_provider_templates_entries;`,
    },
    {
      id: "deploy.takosumi_runs_kind_constraint.expand",
      version: 44,
      domain: "deploy",
      description:
        "Keep the single Run ledger discriminator constraint aligned with the public RunType contract, including Source-scoped compatibility_check rows and operator backup/drift/restore rows.",
      sql: `alter table takosumi_runs
  drop constraint if exists takosumi_runs_kind_check;
alter table takosumi_runs
  add constraint takosumi_runs_kind_check
  check (kind in ('source_sync','compatibility_check','plan','apply','destroy_plan','destroy_apply','drift_check','backup','restore'));`,
      down: `alter table takosumi_runs
  drop constraint if exists takosumi_runs_kind_check;
alter table takosumi_runs
  add constraint takosumi_runs_kind_check
  check (kind in ('plan','destroy_plan','apply','destroy_apply','source_sync'));`,
    },
    {
      id: "deploy.takosumi_provider_template_dead_tables.drop",
      version: 45,
      domain: "deploy",
      description:
        "Drop the never-read provider-template / retired provider material ledger tables created by the v43 migration. No live read path queries these tables: provider templates persist in takosumi_provider_templates and provider material persists as Provider Env records behind explicit Provider Connections. Idempotent: each drop is a no-op on databases that never created the retired tables.",
      sql: `drop index if exists takosumi_provider_env_pins_pack_idx;
drop index if exists takosumi_provider_env_pins_provider_source_idx;
drop index if exists takosumi_provider_env_pins_space_idx;
drop table if exists takosumi_provider_env_pins;
drop index if exists takosumi_provider_env_sets_pack_idx;
drop index if exists takosumi_provider_env_sets_status_idx;
drop index if exists takosumi_provider_env_sets_provider_source_idx;
drop index if exists takosumi_provider_env_sets_space_idx;
drop table if exists takosumi_provider_env_sets;
drop index if exists takosumi_provider_templates_entries_default_eligible_idx;
drop index if exists takosumi_provider_templates_entries_primary_credential_source_idx;
drop table if exists takosumi_provider_templates_entries;`,
    },
    {
      id: "deploy.takosumi_runs_lease_columns.add",
      version: 46,
      domain: "deploy",
      description:
        "Promote the single Run ledger's status / lease coordination fields to indexed columns: add status (mirroring the D1 ledger, backfilled from run_json), plus the lease_token / heartbeat_at columns and the (kind, status) index used by run-lease claim/heartbeat sweeps. Also create the takosumi_artifacts and takosumi_provider_templates ledgers that the deploy-control store has written but which no prior Postgres migration ever materialized (the D1 store and Drizzle schema already define them), and relax the source_id columns on takosumi_source_snapshots / takosumi_opentofu_installations to nullable so upload-origin (takosumi deploy) snapshots and installations — which have no Source — match the Drizzle schema. Additive and idempotent: each column add uses `if not exists`, the backfill reads run_json before status is enforced NOT NULL, the table / index creates are `if not exists`, and `drop not null` is a no-op when already nullable.",
      sql: `alter table takosumi_runs add column if not exists status text;
alter table takosumi_runs add column if not exists lease_token text;
alter table takosumi_runs add column if not exists heartbeat_at bigint;
update takosumi_runs
  set status = coalesce(run_json->>'status', status, 'queued')
  where status is null;
update takosumi_runs
  set heartbeat_at = (run_json->>'heartbeatAt')::bigint
  where heartbeat_at is null and run_json ? 'heartbeatAt';
alter table takosumi_runs alter column status set not null;
create index if not exists takosumi_runs_kind_status_idx
  on takosumi_runs (kind, status);
create table if not exists takosumi_artifacts (
  id          text    primary key,
  run_id      text    not null,
  kind        text    not null,
  object_key  text    not null,
  digest      text    not null,
  size_bytes  integer not null,
  created_at  text    not null
);
create index if not exists takosumi_artifacts_run_idx
  on takosumi_artifacts (run_id);
create table if not exists takosumi_provider_templates (
  id                        text    primary key,
  provider_source           text    not null,
  primary_credential_source text    not null,
  default_eligible          integer not null,
  entry_json                jsonb   not null,
  created_at                text    not null,
  updated_at                text    not null
);
create unique index if not exists takosumi_provider_templates_source_unique
  on takosumi_provider_templates (provider_source);
create index if not exists takosumi_provider_templates_primary_credential_source_idx
  on takosumi_provider_templates (primary_credential_source);
create index if not exists takosumi_provider_templates_default_eligible_idx
  on takosumi_provider_templates (default_eligible);
alter table takosumi_source_snapshots alter column source_id drop not null;
alter table takosumi_opentofu_installations alter column source_id drop not null;`,
      down: `drop index if exists takosumi_provider_templates_default_eligible_idx;
drop index if exists takosumi_provider_templates_primary_credential_source_idx;
drop index if exists takosumi_provider_templates_source_unique;
drop table if exists takosumi_provider_templates;
drop index if exists takosumi_artifacts_run_idx;
drop table if exists takosumi_artifacts;
drop index if exists takosumi_runs_kind_status_idx;
alter table takosumi_runs drop column if exists heartbeat_at;
alter table takosumi_runs drop column if exists lease_token;
alter table takosumi_runs drop column if exists status;`,
    },
    {
      id: "service_graph.records.create",
      version: 47,
      domain: "runtime-projection",
      description:
        "Create first-class Runtime Projection record tables for ServiceExport, ServiceBinding, and ServiceGrant. Runtime service publication and authority are stored as Takosumi-owned rows instead of being hidden inside a generic snapshot blob.",
      sql: `create table if not exists service_graph_exports (
  id                       text  primary key,
  space_id                 text  not null,
  producer_installation_id text  not null,
  name                     text  not null,
  capabilities_json        jsonb not null,
  visibility               text  not null,
  status                   text  not null,
  deployment_id            text,
  output_snapshot_id       text,
  record_json              jsonb not null,
  updated_at               text  not null
);
create index if not exists service_graph_exports_space_idx
  on service_graph_exports (space_id);
create index if not exists service_graph_exports_producer_idx
  on service_graph_exports (producer_installation_id);
create index if not exists service_graph_exports_status_idx
  on service_graph_exports (space_id, status);
create table if not exists service_graph_bindings (
  id                         text  primary key,
  space_id                   text  not null,
  consumer_installation_id   text  not null,
  selected_service_export_id text,
  selector_json              jsonb not null,
  status                     text  not null,
  dependency_snapshot_id     text,
  record_json                jsonb not null,
  updated_at                 text  not null
);
create index if not exists service_graph_bindings_space_idx
  on service_graph_bindings (space_id);
create index if not exists service_graph_bindings_consumer_idx
  on service_graph_bindings (consumer_installation_id);
create index if not exists service_graph_bindings_export_idx
  on service_graph_bindings (selected_service_export_id);
create table if not exists service_graph_grants (
  id                       text  primary key,
  space_id                 text  not null,
  binding_id               text  not null,
  service_export_id        text  not null,
  consumer_installation_id text  not null,
  status                   text  not null,
  expires_at               text,
  record_json              jsonb not null,
  created_at               text  not null
);
create index if not exists service_graph_grants_binding_idx
  on service_graph_grants (binding_id);
create index if not exists service_graph_grants_export_idx
  on service_graph_grants (service_export_id);
create index if not exists service_graph_grants_consumer_idx
  on service_graph_grants (consumer_installation_id, status);`,
      down: `drop index if exists service_graph_grants_consumer_idx;
drop index if exists service_graph_grants_export_idx;
drop index if exists service_graph_grants_binding_idx;
drop table if exists service_graph_grants;
drop index if exists service_graph_bindings_export_idx;
drop index if exists service_graph_bindings_consumer_idx;
drop index if exists service_graph_bindings_space_idx;
drop table if exists service_graph_bindings;
drop index if exists service_graph_exports_status_idx;
drop index if exists service_graph_exports_producer_idx;
drop index if exists service_graph_exports_space_idx;
drop table if exists service_graph_exports;`,
    },
    {
      id: "deploy.provider_catalog_table.rename",
      version: 48,
      domain: "deploy",
      description:
        "Rename the live Provider Catalog storage table from the earlier provider-template vocabulary to takosumi_provider_catalog. Existing rows are copied forward before the old table and indexes are dropped; the rollback path copies them back for structural rollback.",
      sql: `create table if not exists takosumi_provider_catalog (
  id                        text    primary key,
  provider_source           text    not null,
  primary_credential_source text    not null,
  default_eligible          integer not null,
  entry_json                jsonb   not null,
  created_at                text    not null,
  updated_at                text    not null
);
insert into takosumi_provider_catalog (
  id,
  provider_source,
  primary_credential_source,
  default_eligible,
  entry_json,
  created_at,
  updated_at
)
select
  id,
  provider_source,
  primary_credential_source,
  default_eligible,
  entry_json,
  created_at,
  updated_at
from takosumi_provider_templates
on conflict (id) do nothing;
create unique index if not exists takosumi_provider_catalog_source_unique
  on takosumi_provider_catalog (provider_source);
create index if not exists takosumi_provider_catalog_primary_credential_source_idx
  on takosumi_provider_catalog (primary_credential_source);
create index if not exists takosumi_provider_catalog_default_eligible_idx
  on takosumi_provider_catalog (default_eligible);
drop index if exists takosumi_provider_templates_default_eligible_idx;
drop index if exists takosumi_provider_templates_primary_credential_source_idx;
drop index if exists takosumi_provider_templates_source_unique;
drop table if exists takosumi_provider_templates;`,
      down: `create table if not exists takosumi_provider_templates (
  id                        text    primary key,
  provider_source           text    not null,
  primary_credential_source text    not null,
  default_eligible          integer not null,
  entry_json                jsonb   not null,
  created_at                text    not null,
  updated_at                text    not null
);
insert into takosumi_provider_templates (
  id,
  provider_source,
  primary_credential_source,
  default_eligible,
  entry_json,
  created_at,
  updated_at
)
select
  id,
  provider_source,
  primary_credential_source,
  default_eligible,
  entry_json,
  created_at,
  updated_at
from takosumi_provider_catalog
on conflict (id) do nothing;
create unique index if not exists takosumi_provider_templates_source_unique
  on takosumi_provider_templates (provider_source);
create index if not exists takosumi_provider_templates_primary_credential_source_idx
  on takosumi_provider_templates (primary_credential_source);
create index if not exists takosumi_provider_templates_default_eligible_idx
  on takosumi_provider_templates (default_eligible);
drop index if exists takosumi_provider_catalog_default_eligible_idx;
drop index if exists takosumi_provider_catalog_primary_credential_source_idx;
drop index if exists takosumi_provider_catalog_source_unique;
drop table if exists takosumi_provider_catalog;`,
    },
    {
      id: "deploy.provider_envs.current_shape",
      version: 49,
      domain: "deploy",
      description:
        "Create the current Provider Env and Provider Env binding set tables, and add current Provider Catalog materialization columns used by the Provider Env / Gateway model.",
      sql: `alter table takosumi_provider_catalog
  alter column primary_credential_source drop not null;
alter table takosumi_provider_catalog
  alter column default_eligible drop not null;
drop index if exists takosumi_provider_catalog_primary_credential_source_idx;
drop index if exists takosumi_provider_catalog_default_eligible_idx;
alter table takosumi_provider_catalog
  add column if not exists primary_materialization text;
alter table takosumi_provider_catalog
  add column if not exists gateway_eligible integer;
update takosumi_provider_catalog
  set primary_materialization = coalesce(primary_materialization, primary_credential_source, 'secret')
  where primary_materialization is null;
update takosumi_provider_catalog
  set gateway_eligible = coalesce(gateway_eligible, default_eligible, 0)
  where gateway_eligible is null;
alter table takosumi_provider_catalog
  alter column primary_materialization set not null;
alter table takosumi_provider_catalog
  alter column gateway_eligible set not null;
alter table takosumi_provider_catalog
  drop column if exists primary_credential_source;
alter table takosumi_provider_catalog
  drop column if exists default_eligible;
create index if not exists takosumi_provider_catalog_primary_materialization_idx
  on takosumi_provider_catalog (primary_materialization);
create index if not exists takosumi_provider_catalog_gateway_eligible_idx
  on takosumi_provider_catalog (gateway_eligible);

create table if not exists takosumi_provider_envs (
  id              text  primary key,
  space_id        text,
  provider_source text  not null,
  materialization text  not null,
  status          text  not null,
  env_json        jsonb not null,
  created_at      text  not null,
  updated_at      text  not null
);
create index if not exists takosumi_provider_envs_space_idx
  on takosumi_provider_envs (space_id);
create index if not exists takosumi_provider_envs_provider_source_idx
  on takosumi_provider_envs (provider_source);
create index if not exists takosumi_provider_envs_materialization_idx
  on takosumi_provider_envs (materialization);
create index if not exists takosumi_provider_envs_status_idx
  on takosumi_provider_envs (status);

create table if not exists takosumi_provider_env_binding_sets (
  id              text  primary key,
  space_id        text  not null,
  installation_id text  not null,
  environment     text  not null,
  profile_json    jsonb not null,
  created_at      text  not null,
  updated_at      text  not null
);
create unique index if not exists takosumi_provider_env_bindings_installation_environment_unique
  on takosumi_provider_env_binding_sets (installation_id, environment);
create index if not exists takosumi_provider_env_bindings_installation_idx
  on takosumi_provider_env_binding_sets (installation_id);`,
      down: `drop index if exists takosumi_provider_env_bindings_installation_idx;
drop index if exists takosumi_provider_env_bindings_installation_environment_unique;
drop table if exists takosumi_provider_env_binding_sets;
drop index if exists takosumi_provider_envs_status_idx;
drop index if exists takosumi_provider_envs_materialization_idx;
drop index if exists takosumi_provider_envs_provider_source_idx;
drop index if exists takosumi_provider_envs_space_idx;
drop table if exists takosumi_provider_envs;
drop index if exists takosumi_provider_catalog_gateway_eligible_idx;
drop index if exists takosumi_provider_catalog_primary_materialization_idx;
alter table takosumi_provider_catalog
  drop column if exists gateway_eligible;
alter table takosumi_provider_catalog
  drop column if exists primary_materialization;`,
    },
    {
      id: "deploy.provider_materialization_values.canonicalize",
      version: 50,
      domain: "deploy",
      description:
        "Canonicalize legacy Provider Catalog / Provider Env materialization values after the public provider model moved to explicit ProviderConnections. Old provider-template credential-source values are mapped once, then CHECK constraints keep the schema aligned with the current contract.",
      sql: `update takosumi_provider_catalog
  set primary_materialization = case
    when primary_materialization in ('takosumi_managed','gateway') then 'secret'
    when primary_materialization = 'user_env_set' then 'secret'
    when primary_materialization in ('oauth','secret') then primary_materialization
    else 'secret'
  end
  where primary_materialization not in ('oauth','secret')
     or primary_materialization = 'gateway';
delete from takosumi_provider_envs
  where space_id is null;
alter table takosumi_provider_envs
  alter column space_id set not null;
update takosumi_provider_envs
  set materialization = case
    when materialization in ('takosumi_managed','user_env_set','gateway') then 'secret'
    when materialization in ('oauth','secret') then materialization
    else 'secret'
  end
  where materialization not in ('oauth','secret')
     or materialization = 'gateway';
alter table takosumi_provider_catalog
  drop constraint if exists takosumi_provider_catalog_primary_materialization_check;
alter table takosumi_provider_catalog
  add constraint takosumi_provider_catalog_primary_materialization_check
  check (primary_materialization in ('oauth','secret'));
alter table takosumi_provider_envs
  drop constraint if exists takosumi_provider_envs_materialization_check;
alter table takosumi_provider_envs
  add constraint takosumi_provider_envs_materialization_check
  check (materialization in ('oauth','secret'));
alter table takosumi_provider_envs
  drop constraint if exists takosumi_provider_envs_global_materialization_check;
alter table takosumi_provider_envs
  add constraint takosumi_provider_envs_global_materialization_check
  check (space_id is not null);`,
      down: `alter table takosumi_provider_envs
  alter column space_id drop not null;
alter table takosumi_provider_envs
  drop constraint if exists takosumi_provider_envs_global_materialization_check;
alter table takosumi_provider_envs
  drop constraint if exists takosumi_provider_envs_materialization_check;
alter table takosumi_provider_catalog
  drop constraint if exists takosumi_provider_catalog_primary_materialization_check;`,
    },
    {
      id: "deploy.postgres_named_index_parity.normalize",
      version: 51,
      domain: "deploy",
      description:
        "Normalize Postgres unique/index names and composite index columns to the Drizzle schema mirror so schema diff gates compare the actual migration end-state instead of auto-generated table-constraint names.",
      sql: `alter table takosumi_spaces
  drop constraint if exists takosumi_spaces_handle_key;
create unique index if not exists takosumi_spaces_handle_unique
  on takosumi_spaces (handle);

alter table takosumi_opentofu_installations
  drop constraint if exists takosumi_opentofu_installations_space_id_name_environment_key;
create unique index if not exists takosumi_opentofu_installations_space_name_environment_unique
  on takosumi_opentofu_installations (space_id, name, environment);

alter table takosumi_provider_env_binding_sets
  drop constraint if exists takosumi_provider_env_binding_s_installation_id_environment_key;
create unique index if not exists takosumi_provider_env_bindings_installation_environment_unique
  on takosumi_provider_env_binding_sets (installation_id, environment);
drop index if exists takosumi_provider_env_bindings_installation_idx;
create index takosumi_provider_env_bindings_installation_idx
  on takosumi_provider_env_binding_sets (installation_id, environment);

alter table takosumi_state_snapshots
  drop constraint if exists takosumi_state_snapshots_installation_id_environment_genera_key;
create unique index if not exists takosumi_state_snapshots_installation_environment_generation_un
  on takosumi_state_snapshots (installation_id, environment, generation);

alter table takosumi_usage_events
  drop constraint if exists takosumi_usage_events_idempotency_key_key;
create unique index if not exists takosumi_usage_events_idempotency_key_unique
  on takosumi_usage_events (idempotency_key);`,
      down: `drop index if exists takosumi_usage_events_idempotency_key_unique;
drop index if exists takosumi_state_snapshots_installation_environment_generation_un;
drop index if exists takosumi_provider_env_bindings_installation_idx;
drop index if exists takosumi_provider_env_bindings_installation_environment_unique;
drop index if exists takosumi_opentofu_installations_space_name_environment_unique;
drop index if exists takosumi_spaces_handle_unique;`,
    },
    {
      id: "deploy.usage_event_meter_metadata",
      version: 52,
      domain: "deploy",
      description:
        "Add open managed-resource meter metadata to usage events so Cloud-only gateways can bill customer-facing resources such as Workers Script, KV, R2, D1, Workflows, Containers, and future resource families without enum migrations.",
      sql: `alter table takosumi_usage_events
  add column if not exists meter_id text;
alter table takosumi_usage_events
  add column if not exists resource_family text;
alter table takosumi_usage_events
  add column if not exists resource_id text;
alter table takosumi_usage_events
  add column if not exists operation text;
alter table takosumi_usage_events
  add column if not exists resource_metadata_json jsonb;`,
      down: `alter table takosumi_usage_events
  drop column if exists resource_metadata_json;
alter table takosumi_usage_events
  drop column if exists operation;
alter table takosumi_usage_events
  drop column if exists resource_id;
alter table takosumi_usage_events
  drop column if exists resource_family;
alter table takosumi_usage_events
  drop column if exists meter_id;`,
    },
    {
      id: "deploy.billing_usd_micros_columns.add",
      version: 53,
      domain: "deploy",
      description:
        "Add nullable persisted USD micros columns alongside legacy credit columns for billing plans, balances, reservations, and usage events. Backfills existing rows from legacy credits while preserving the legacy columns for compatibility.",
      sql: `alter table takosumi_plans
  add column if not exists included_usd_micros bigint;
alter table takosumi_plans
  alter column included_usd_micros type bigint;
update takosumi_plans
  set included_usd_micros = included_credits * 1000000
  where included_usd_micros is null;

alter table takosumi_credit_balances
  add column if not exists available_usd_micros bigint;
alter table takosumi_credit_balances
  alter column available_usd_micros type bigint;
alter table takosumi_credit_balances
  add column if not exists reserved_usd_micros bigint;
alter table takosumi_credit_balances
  alter column reserved_usd_micros type bigint;
alter table takosumi_credit_balances
  add column if not exists monthly_included_usd_micros bigint;
alter table takosumi_credit_balances
  alter column monthly_included_usd_micros type bigint;
alter table takosumi_credit_balances
  add column if not exists purchased_usd_micros bigint;
alter table takosumi_credit_balances
  alter column purchased_usd_micros type bigint;
update takosumi_credit_balances
  set available_usd_micros = coalesce(available_usd_micros, available_credits * 1000000),
      reserved_usd_micros = coalesce(reserved_usd_micros, reserved_credits * 1000000),
      monthly_included_usd_micros = coalesce(monthly_included_usd_micros, monthly_included_credits * 1000000),
      purchased_usd_micros = coalesce(purchased_usd_micros, purchased_credits * 1000000);

alter table takosumi_usage_events
  add column if not exists usd_micros bigint;
alter table takosumi_usage_events
  alter column usd_micros type bigint;
update takosumi_usage_events
  set usd_micros = credits * 1000000
  where usd_micros is null;

alter table takosumi_credit_reservations
  add column if not exists estimated_usd_micros bigint;
alter table takosumi_credit_reservations
  alter column estimated_usd_micros type bigint;
update takosumi_credit_reservations
  set estimated_usd_micros = estimated_credits * 1000000
  where estimated_usd_micros is null;

create or replace function takosumi_billing_usd_micros_compat()
returns trigger
language plpgsql
as $$
begin
  if TG_TABLE_NAME = 'takosumi_plans' then
    if TG_OP = 'INSERT' then
      if NEW.included_usd_micros is null then
        NEW.included_usd_micros := NEW.included_credits * 1000000;
      end if;
    elsif NEW.included_usd_micros is null
       or (
         NEW.included_usd_micros is not distinct from OLD.included_usd_micros
         and NEW.included_credits is distinct from OLD.included_credits
       ) then
      NEW.included_usd_micros := NEW.included_credits * 1000000;
    end if;
  elsif TG_TABLE_NAME = 'takosumi_credit_balances' then
    if TG_OP = 'INSERT' then
      if NEW.available_usd_micros is null then
        NEW.available_usd_micros := NEW.available_credits * 1000000;
      end if;
      if NEW.reserved_usd_micros is null then
        NEW.reserved_usd_micros := NEW.reserved_credits * 1000000;
      end if;
      if NEW.monthly_included_usd_micros is null then
        NEW.monthly_included_usd_micros := NEW.monthly_included_credits * 1000000;
      end if;
      if NEW.purchased_usd_micros is null then
        NEW.purchased_usd_micros := NEW.purchased_credits * 1000000;
      end if;
    else
      if NEW.available_usd_micros is null
         or (
           NEW.available_usd_micros is not distinct from OLD.available_usd_micros
           and NEW.available_credits is distinct from OLD.available_credits
         ) then
        NEW.available_usd_micros := NEW.available_credits * 1000000;
      end if;
      if NEW.reserved_usd_micros is null
         or (
           NEW.reserved_usd_micros is not distinct from OLD.reserved_usd_micros
           and NEW.reserved_credits is distinct from OLD.reserved_credits
         ) then
        NEW.reserved_usd_micros := NEW.reserved_credits * 1000000;
      end if;
      if NEW.monthly_included_usd_micros is null
         or (
           NEW.monthly_included_usd_micros is not distinct from OLD.monthly_included_usd_micros
           and NEW.monthly_included_credits is distinct from OLD.monthly_included_credits
         ) then
        NEW.monthly_included_usd_micros := NEW.monthly_included_credits * 1000000;
      end if;
      if NEW.purchased_usd_micros is null
         or (
           NEW.purchased_usd_micros is not distinct from OLD.purchased_usd_micros
           and NEW.purchased_credits is distinct from OLD.purchased_credits
         ) then
        NEW.purchased_usd_micros := NEW.purchased_credits * 1000000;
      end if;
    end if;
  elsif TG_TABLE_NAME = 'takosumi_usage_events' then
    if TG_OP = 'INSERT' then
      if NEW.usd_micros is null then
        NEW.usd_micros := NEW.credits * 1000000;
      end if;
    elsif NEW.usd_micros is null
       or (
         NEW.usd_micros is not distinct from OLD.usd_micros
         and NEW.credits is distinct from OLD.credits
       ) then
      NEW.usd_micros := NEW.credits * 1000000;
    end if;
  elsif TG_TABLE_NAME = 'takosumi_credit_reservations' then
    if TG_OP = 'INSERT' then
      if NEW.estimated_usd_micros is null then
        NEW.estimated_usd_micros := NEW.estimated_credits * 1000000;
      end if;
    elsif NEW.estimated_usd_micros is null
       or (
         NEW.estimated_usd_micros is not distinct from OLD.estimated_usd_micros
         and NEW.estimated_credits is distinct from OLD.estimated_credits
       ) then
      NEW.estimated_usd_micros := NEW.estimated_credits * 1000000;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists takosumi_plans_billing_usd_micros_compat on takosumi_plans;
create trigger takosumi_plans_billing_usd_micros_compat
  before insert or update on takosumi_plans
  for each row execute function takosumi_billing_usd_micros_compat();
drop trigger if exists takosumi_credit_balances_billing_usd_micros_compat on takosumi_credit_balances;
create trigger takosumi_credit_balances_billing_usd_micros_compat
  before insert or update on takosumi_credit_balances
  for each row execute function takosumi_billing_usd_micros_compat();
drop trigger if exists takosumi_usage_events_billing_usd_micros_compat on takosumi_usage_events;
create trigger takosumi_usage_events_billing_usd_micros_compat
  before insert or update on takosumi_usage_events
  for each row execute function takosumi_billing_usd_micros_compat();
drop trigger if exists takosumi_credit_reservations_billing_usd_micros_compat on takosumi_credit_reservations;
create trigger takosumi_credit_reservations_billing_usd_micros_compat
  before insert or update on takosumi_credit_reservations
  for each row execute function takosumi_billing_usd_micros_compat();`,
      down: `drop trigger if exists takosumi_credit_reservations_billing_usd_micros_compat on takosumi_credit_reservations;
drop trigger if exists takosumi_usage_events_billing_usd_micros_compat on takosumi_usage_events;
drop trigger if exists takosumi_credit_balances_billing_usd_micros_compat on takosumi_credit_balances;
drop trigger if exists takosumi_plans_billing_usd_micros_compat on takosumi_plans;
drop function if exists takosumi_billing_usd_micros_compat();
alter table takosumi_credit_reservations
  drop column if exists estimated_usd_micros;
alter table takosumi_usage_events
  drop column if exists usd_micros;
alter table takosumi_credit_balances
  drop column if exists purchased_usd_micros;
alter table takosumi_credit_balances
  drop column if exists monthly_included_usd_micros;
alter table takosumi_credit_balances
  drop column if exists reserved_usd_micros;
alter table takosumi_credit_balances
  drop column if exists available_usd_micros;
alter table takosumi_plans
  drop column if exists included_usd_micros;`,
    },
    {
      id: "deploy.billing_auto_recharge_attempts.create",
      version: 54,
      domain: "deploy",
      description:
        "Create the Takosumi Cloud billing auto-recharge attempt ledger. The table enforces one attempt per idempotency key and lets the Cloud-injected enforcement port count pending, pending_unknown, and succeeded attempts against a monthly USD micros cap before its Stripe adapter creates an off-session PaymentIntent. OSS core stores object ids and status metadata only, never card data or secrets, and never calls Stripe directly.",
      sql: `create table if not exists takosumi_billing_auto_recharge_attempts (
  id                       text   primary key,
  space_id                 text   not null,
  run_id                   text   not null,
  billing_account_id       text   not null,
  idempotency_key          text   not null,
  period_start             text   not null,
  period_end               text,
  requested_usd_micros     bigint not null,
  monthly_limit_usd_micros bigint,
  charged_usd_micros       bigint,
  status                   text   not null
    check (status in ('pending','pending_unknown','succeeded','failed')),
  stripe_payment_intent_id text,
  provider_status          text,
  failure_reason           text,
  attempt_json             jsonb  not null,
  created_at               text   not null,
  updated_at               text   not null
);
create unique index if not exists takosumi_billing_auto_recharge_attempts_idempotency_unique
  on takosumi_billing_auto_recharge_attempts (idempotency_key);
create index if not exists takosumi_billing_auto_recharge_attempts_space_period_status_idx
  on takosumi_billing_auto_recharge_attempts (space_id, period_start, status);
create index if not exists takosumi_billing_auto_recharge_attempts_run_idx
  on takosumi_billing_auto_recharge_attempts (run_id);`,
      down: `drop index if exists takosumi_billing_auto_recharge_attempts_run_idx;
drop index if exists takosumi_billing_auto_recharge_attempts_space_period_status_idx;
drop index if exists takosumi_billing_auto_recharge_attempts_idempotency_unique;
drop table if exists takosumi_billing_auto_recharge_attempts;`,
    },
    {
      id: "service_graph.records.rename_aside",
      version: 55,
      domain: "runtime-projection",
      description:
        "Retire the OSS Runtime Projection ledger (deploy decision D3): the ServiceExport / ServiceBinding / ServiceGrant records are no longer part of the OSS noun model and are projected from Capsule Outputs instead. The tables are renamed aside to `*_retired` (recoverable) rather than dropped, and are no longer created or read. `down` restores the original names.",
      sql: `alter table if exists service_graph_exports rename to service_graph_exports_retired;
alter table if exists service_graph_bindings rename to service_graph_bindings_retired;
alter table if exists service_graph_grants rename to service_graph_grants_retired;`,
      down: `alter table if exists service_graph_grants_retired rename to service_graph_grants;
alter table if exists service_graph_bindings_retired rename to service_graph_bindings;
alter table if exists service_graph_exports_retired rename to service_graph_exports;`,
    },
    {
      id: "deploy.provider_credential_collapse.rename_aside",
      version: 56,
      domain: "deploy",
      description:
        "Collapse the provider-credential model: fold the retired ProviderEnv resolver projection (materialization + providerSource) onto the unified Connection row (id-equal join), then retire the live Provider Catalog and Provider Env tables by renaming them aside to `*_retired` (non-destructive, recoverable). They are no longer created or read; the public Provider listing is computed read-only from the provider registry. `down` restores the original names (the additive connection_json fields are left in place).",
      sql: `update takosumi_connections c
  set connection_json = jsonb_set(
    jsonb_set(
      c.connection_json,
      '{materialization}',
      to_jsonb(coalesce(
        c.connection_json->>'materialization',
        case
          when c.connection_json->>'credentialDriver' in ('cloudflare_oauth', 'gcp_oauth_bootstrap')
          then 'oauth'
        end,
        'secret'
      )),
      true
    ),
    '{providerSource}',
    to_jsonb(coalesce(c.connection_json->>'providerSource', c.connection_json->>'provider')),
    true
  )
  where not (c.connection_json ? 'materialization')
     or not (c.connection_json ? 'providerSource');
update takosumi_connections c
  set connection_json = jsonb_set(
    jsonb_set(
      c.connection_json,
      '{materialization}',
      to_jsonb(pe.materialization),
      true
    ),
    '{providerSource}',
    to_jsonb(pe.provider_source),
    true
  )
  from takosumi_provider_envs pe
  where pe.id = c.id;
alter table if exists takosumi_provider_catalog rename to takosumi_provider_catalog_retired;
alter table if exists takosumi_provider_envs rename to takosumi_provider_envs_retired;`,
      down: `alter table if exists takosumi_provider_envs_retired rename to takosumi_provider_envs;
alter table if exists takosumi_provider_catalog_retired rename to takosumi_provider_catalog;`,
    },
    {
      id: "deploy.workspace_capsule_rename",
      version: 57,
      domain: "deploy",
      description:
        "P4 17-noun rename (structural): rename the deploy-control ledger tables takosumi_spaces -> takosumi_workspaces, takosumi_opentofu_installations -> takosumi_capsules, takosumi_state_snapshots -> takosumi_state_versions, takosumi_output_snapshots -> takosumi_outputs, with their canonical named indexes. On takosumi_capsules, rename current_deployment_id -> current_state_version_id (the retired-Deployment pointer is value-translated by deploy.retire_deployment_tracking) and add the nullable Workspace-owned project_id. Create the new takosumi_projects table. Rename-aside / additive only; `down` reverses every rename and drops the added column / table.",
      sql: `alter table if exists takosumi_spaces rename to takosumi_workspaces;
alter index if exists takosumi_spaces_handle_unique rename to takosumi_workspaces_handle_unique;
alter table if exists takosumi_opentofu_installations rename to takosumi_capsules;
alter table if exists takosumi_capsules rename column current_deployment_id to current_state_version_id;
alter table if exists takosumi_capsules add column if not exists project_id text;
alter index if exists takosumi_opentofu_installations_space_name_environment_unique rename to takosumi_capsules_space_name_environment_unique;
alter index if exists takosumi_opentofu_installations_space_idx rename to takosumi_capsules_space_idx;
alter index if exists takosumi_opentofu_installations_current_deployment_idx rename to takosumi_capsules_current_state_version_idx;
alter index if exists takosumi_opentofu_installations_created_at_idx rename to takosumi_capsules_created_at_idx;
create index if not exists takosumi_capsules_project_idx on takosumi_capsules (project_id);
alter table if exists takosumi_state_snapshots rename to takosumi_state_versions;
alter index if exists takosumi_state_snapshots_installation_environment_generation_un rename to takosumi_state_versions_installation_environment_generation_un;
alter index if exists takosumi_state_snapshots_installation_idx rename to takosumi_state_versions_installation_idx;
alter table if exists takosumi_output_snapshots rename to takosumi_outputs;
alter index if exists takosumi_output_snapshots_installation_idx rename to takosumi_outputs_installation_idx;
create table if not exists takosumi_projects (
  id           text   primary key,
  workspace_id text   not null,
  name         text   not null,
  slug         text   not null,
  project_json jsonb  not null,
  created_at   text   not null,
  updated_at   text   not null
);
create unique index if not exists takosumi_projects_workspace_slug_unique
  on takosumi_projects (workspace_id, slug);
create index if not exists takosumi_projects_workspace_idx
  on takosumi_projects (workspace_id);`,
      down: `drop index if exists takosumi_projects_workspace_idx;
drop index if exists takosumi_projects_workspace_slug_unique;
drop table if exists takosumi_projects;
alter index if exists takosumi_outputs_installation_idx rename to takosumi_output_snapshots_installation_idx;
alter table if exists takosumi_outputs rename to takosumi_output_snapshots;
alter index if exists takosumi_state_versions_installation_idx rename to takosumi_state_snapshots_installation_idx;
alter index if exists takosumi_state_versions_installation_environment_generation_un rename to takosumi_state_snapshots_installation_environment_generation_un;
alter table if exists takosumi_state_versions rename to takosumi_state_snapshots;
drop index if exists takosumi_capsules_project_idx;
alter index if exists takosumi_capsules_created_at_idx rename to takosumi_opentofu_installations_created_at_idx;
alter index if exists takosumi_capsules_current_state_version_idx rename to takosumi_opentofu_installations_current_deployment_idx;
alter index if exists takosumi_capsules_space_idx rename to takosumi_opentofu_installations_space_idx;
alter index if exists takosumi_capsules_space_name_environment_unique rename to takosumi_opentofu_installations_space_name_environment_unique;
alter table if exists takosumi_capsules drop column if exists project_id;
alter table if exists takosumi_capsules rename column current_state_version_id to current_deployment_id;
alter table if exists takosumi_capsules rename to takosumi_opentofu_installations;
alter index if exists takosumi_workspaces_handle_unique rename to takosumi_spaces_handle_unique;
alter table if exists takosumi_workspaces rename to takosumi_spaces;`,
    },
    {
      id: "deploy.projects_default_backfill",
      version: 58,
      domain: "deploy",
      description:
        "P4 backfill: create one default Project (prj_default_<workspaceId>, slug `default`) per Workspace, then point every pre-Project Capsule at its Workspace's default Project (capsules.project_id, joined on the kept space_id column). `down` clears the backfilled project_id and deletes the default Projects.",
      sql: `insert into takosumi_projects (id, workspace_id, name, slug, project_json, created_at, updated_at)
  select
    'prj_default_' || w.id,
    w.id,
    'Default',
    'default',
    jsonb_build_object(
      'id', 'prj_default_' || w.id,
      'workspaceId', w.id,
      'name', 'Default',
      'slug', 'default',
      'projectJson', jsonb_build_object(),
      'createdAt', w.created_at,
      'updatedAt', w.updated_at
    ),
    w.created_at,
    w.updated_at
  from takosumi_workspaces w
  on conflict (id) do nothing;
update takosumi_capsules c
  set project_id = 'prj_default_' || c.space_id
  where c.project_id is null
    and exists (
      select 1 from takosumi_projects p where p.id = 'prj_default_' || c.space_id
    );`,
      down: `update takosumi_capsules
  set project_id = null
  where starts_with(project_id, 'prj_default_');
delete from takosumi_projects where starts_with(id, 'prj_default_');`,
    },
    {
      id: "deploy.workspace_capsule_blob_key_rewrite",
      version: 59,
      domain: "deploy",
      description:
        "P4 record_json blob-key rewrite (reversible): rename the renamed-noun keys inside the stored JSON envelopes so getCapsule / getStateVersion / getOutput / OutputShare reads deserialize the new contract fields. takosumi_capsules.installation_json: spaceId->workspaceId, currentOutputSnapshotId->currentOutputId. takosumi_state_versions / takosumi_outputs snapshot_json: spaceId->workspaceId, installationId->capsuleId. takosumi_output_shares.share_json: fromSpaceId->fromWorkspaceId, toSpaceId->toWorkspaceId, producerInstallationId->producerCapsuleId. (currentDeploymentId->currentStateVersionId is handled by deploy.retire_deployment_tracking because the value is translated, not copied.) `down` reverses each key rename.",
      sql: `update takosumi_capsules set installation_json =
  (installation_json - 'spaceId') || jsonb_build_object('workspaceId', installation_json->'spaceId')
  where installation_json ? 'spaceId';
update takosumi_capsules set installation_json =
  (installation_json - 'currentOutputSnapshotId') || jsonb_build_object('currentOutputId', installation_json->'currentOutputSnapshotId')
  where installation_json ? 'currentOutputSnapshotId';
update takosumi_state_versions set snapshot_json =
  (snapshot_json - 'spaceId') || jsonb_build_object('workspaceId', snapshot_json->'spaceId')
  where snapshot_json ? 'spaceId';
update takosumi_state_versions set snapshot_json =
  (snapshot_json - 'installationId') || jsonb_build_object('capsuleId', snapshot_json->'installationId')
  where snapshot_json ? 'installationId';
update takosumi_outputs set snapshot_json =
  (snapshot_json - 'spaceId') || jsonb_build_object('workspaceId', snapshot_json->'spaceId')
  where snapshot_json ? 'spaceId';
update takosumi_outputs set snapshot_json =
  (snapshot_json - 'installationId') || jsonb_build_object('capsuleId', snapshot_json->'installationId')
  where snapshot_json ? 'installationId';
update takosumi_output_shares set share_json =
  (share_json - 'fromSpaceId') || jsonb_build_object('fromWorkspaceId', share_json->'fromSpaceId')
  where share_json ? 'fromSpaceId';
update takosumi_output_shares set share_json =
  (share_json - 'toSpaceId') || jsonb_build_object('toWorkspaceId', share_json->'toSpaceId')
  where share_json ? 'toSpaceId';
update takosumi_output_shares set share_json =
  (share_json - 'producerInstallationId') || jsonb_build_object('producerCapsuleId', share_json->'producerInstallationId')
  where share_json ? 'producerInstallationId';`,
      down: `update takosumi_output_shares set share_json =
  (share_json - 'producerCapsuleId') || jsonb_build_object('producerInstallationId', share_json->'producerCapsuleId')
  where share_json ? 'producerCapsuleId';
update takosumi_output_shares set share_json =
  (share_json - 'toWorkspaceId') || jsonb_build_object('toSpaceId', share_json->'toWorkspaceId')
  where share_json ? 'toWorkspaceId';
update takosumi_output_shares set share_json =
  (share_json - 'fromWorkspaceId') || jsonb_build_object('fromSpaceId', share_json->'fromWorkspaceId')
  where share_json ? 'fromWorkspaceId';
update takosumi_outputs set snapshot_json =
  (snapshot_json - 'capsuleId') || jsonb_build_object('installationId', snapshot_json->'capsuleId')
  where snapshot_json ? 'capsuleId';
update takosumi_outputs set snapshot_json =
  (snapshot_json - 'workspaceId') || jsonb_build_object('spaceId', snapshot_json->'workspaceId')
  where snapshot_json ? 'workspaceId';
update takosumi_state_versions set snapshot_json =
  (snapshot_json - 'capsuleId') || jsonb_build_object('installationId', snapshot_json->'capsuleId')
  where snapshot_json ? 'capsuleId';
update takosumi_state_versions set snapshot_json =
  (snapshot_json - 'workspaceId') || jsonb_build_object('spaceId', snapshot_json->'workspaceId')
  where snapshot_json ? 'workspaceId';
update takosumi_capsules set installation_json =
  (installation_json - 'currentOutputId') || jsonb_build_object('currentOutputSnapshotId', installation_json->'currentOutputId')
  where installation_json ? 'currentOutputId';
update takosumi_capsules set installation_json =
  (installation_json - 'workspaceId') || jsonb_build_object('spaceId', installation_json->'workspaceId')
  where installation_json ? 'workspaceId';`,
    },
    {
      id: "deploy.retire_deployment_tracking",
      version: 60,
      domain: "deploy",
      description:
        "P4 retire-Deployment value-translation (forward-only data): the Takosumi Deployment ledger is retired — a successful apply Run + StateVersion + Output is the record. Rewrite takosumi_capsules.current_state_version_id (which carried a retired takosumi_opentofu_deployments id) to the id of the highest-generation StateVersion for the Capsule's current environment, and reflect that into installation_json (drop currentDeploymentId, set currentStateVersionId from the translated column, set projectId from the column). Forward-only: the original deployment id is intentionally not recoverable; the retired takosumi_opentofu_deployments table is kept read-only for audit.",
      sql: `update takosumi_capsules c
  set current_state_version_id = (
    select sv.id from takosumi_state_versions sv
    where sv.installation_id = c.id and sv.environment = c.environment
    order by sv.generation desc
    limit 1
  )
  where exists (
    select 1 from takosumi_state_versions sv
    where sv.installation_id = c.id and sv.environment = c.environment
  );
update takosumi_capsules
  set installation_json = (installation_json - 'currentDeploymentId')
    || (case when current_state_version_id is not null
          then jsonb_build_object('currentStateVersionId', to_jsonb(current_state_version_id))
          else '{}'::jsonb end)
    || (case when project_id is not null
          then jsonb_build_object('projectId', to_jsonb(project_id))
          else '{}'::jsonb end);`,
    },
    {
      id: "resources.resource_shape_flow.create",
      version: 61,
      domain: "resources",
      description:
        "Create the durable Resource Shape flow projections (`takosumi.dev/v1alpha1`) on the deploy-control plane (`final-plan.md` §10): takosumi_resource_shapes (desired spec + observed status, unique per (space, kind, name)), takosumi_resolution_locks (the pinned resolution decision keyed by resource id), takosumi_target_pools, and takosumi_space_policies (both unique per (space, name)). Complex sub-objects persist as jsonb columns. `down` drops the four tables (and their indexes).",
      sql: `create table if not exists takosumi_resource_shapes (
  id                  text    primary key,
  space_id            text    not null,
  project             text,
  environment         text,
  kind                text    not null,
  name                text    not null,
  managed_by          text    not null,
  spec_json           jsonb   not null,
  phase               text    not null,
  generation          integer not null,
  observed_generation integer not null,
  outputs_json        jsonb,
  conditions_json     jsonb,
  labels_json         jsonb,
  created_at          text    not null,
  updated_at          text    not null
);
create unique index if not exists takosumi_resource_shapes_space_kind_name_unique
  on takosumi_resource_shapes (space_id, kind, name);
create index if not exists takosumi_resource_shapes_space_idx
  on takosumi_resource_shapes (space_id);
create table if not exists takosumi_resolution_locks (
  resource_id             text    primary key,
  selected_implementation text    not null,
  target                  text    not null,
  locked                  boolean not null,
  reason_json             jsonb   not null,
  portability             text,
  native_resources_json   jsonb,
  locked_at               text    not null,
  updated_at              text    not null
);
create table if not exists takosumi_target_pools (
  id          text  primary key,
  space_id    text  not null,
  name        text  not null,
  spec_json   jsonb not null,
  created_at  text  not null,
  updated_at  text  not null
);
create unique index if not exists takosumi_target_pools_space_name_unique
  on takosumi_target_pools (space_id, name);
create index if not exists takosumi_target_pools_space_idx
  on takosumi_target_pools (space_id);
create table if not exists takosumi_space_policies (
  id          text  primary key,
  space_id    text  not null,
  name        text  not null,
  spec_json   jsonb not null,
  created_at  text  not null,
  updated_at  text  not null
);
create unique index if not exists takosumi_space_policies_space_name_unique
  on takosumi_space_policies (space_id, name);
create index if not exists takosumi_space_policies_space_idx
  on takosumi_space_policies (space_id);`,
      down: `drop table if exists takosumi_space_policies;
drop table if exists takosumi_target_pools;
drop table if exists takosumi_resolution_locks;
drop table if exists takosumi_resource_shapes;`,
    },
    {
      id: "deploy.capsule_compatibility_root_interface.add",
      version: 62,
      domain: "deploy",
      description:
        "Persist non-secret root module variable/output names on CapsuleCompatibilityReport so a preflight report can be reused for plan creation without expanding the source archive again. This preserves ProviderConnection-derived variable injection for Git/OpenTofu installs in SQL-backed ledgers.",
      sql: `alter table takosumi_capsule_compatibility_reports
  add column if not exists root_module_variables_json jsonb not null default '[]'::jsonb;
alter table takosumi_capsule_compatibility_reports
  add column if not exists root_module_outputs_json jsonb not null default '[]'::jsonb;`,
      down: `alter table takosumi_capsule_compatibility_reports
  drop column if exists root_module_outputs_json;
alter table takosumi_capsule_compatibility_reports
  drop column if exists root_module_variables_json;`,
    },
    {
      id: "deploy.public_host_reservations.create",
      version: 63,
      domain: "deploy",
      description:
        "Create the public host reservation ledger used to atomically claim shared hostnames such as <name>.app.takos.jp and user custom domains before a Capsule plan is queued. hostname is the primary key, giving first-writer-wins semantics across Workspaces; reservations are idempotent for the same Capsule and released on successful destroy.",
      sql: `create table if not exists takosumi_public_host_reservations (
  hostname          text primary key,
  workspace_id      text not null,
  installation_id   text not null,
  installation_name text not null,
  status            text not null
    check (status in ('reserved','released')),
  reserved_at       text not null,
  updated_at        text not null,
  released_at       text
);
create index if not exists takosumi_public_host_reservations_workspace_idx
  on takosumi_public_host_reservations (workspace_id);
create index if not exists takosumi_public_host_reservations_installation_idx
  on takosumi_public_host_reservations (installation_id);
create index if not exists takosumi_public_host_reservations_status_idx
  on takosumi_public_host_reservations (status);`,
      down: `drop index if exists takosumi_public_host_reservations_status_idx;
drop index if exists takosumi_public_host_reservations_installation_idx;
drop index if exists takosumi_public_host_reservations_workspace_idx;
drop table if exists takosumi_public_host_reservations;`,
    },
    {
      id: "deploy.public_host_reservations.backfill",
      version: 64,
      domain: "deploy",
      description:
        "Backfill public host reservations from existing Capsule output URLs so SQL-backed Operators inherit the same hostname ownership guarantees as the D1 platform worker. When historical outputs conflict, active Capsules win over stale/error/pending rows; workers.dev preview hosts are intentionally ignored.",
      sql: `with output_links as (
  select c.id as installation_id,
         c.space_id as workspace_id,
         c.name as installation_name,
         c.status as installation_status,
         c.created_at as installation_created_at,
         coalesce(
           nullif(c.installation_json->>'currentOutputId', ''),
           nullif(c.installation_json->>'currentOutputSnapshotId', '')
         ) as output_id,
         case
           when coalesce(c.installation_json->>'currentStateGeneration', '') ~ '^[0-9]+$'
             then (c.installation_json->>'currentStateGeneration')::integer
           else 0
         end as current_state_generation
  from takosumi_capsules c
  where c.status != 'destroyed'
),
raw_hosts as (
  select l.installation_id,
         l.workspace_id,
         l.installation_name,
         l.installation_status,
         l.installation_created_at,
         l.current_state_generation,
         urls.url
  from output_links l
  join takosumi_outputs o on o.id = l.output_id
  cross join lateral (
    values
      (o.snapshot_json #>> '{publicOutputs,url}'),
      (o.snapshot_json #>> '{publicOutputs,launch_url}'),
      (o.snapshot_json #>> '{publicOutputs,app_url}'),
      (o.snapshot_json #>> '{publicOutputs,public_url}'),
      (o.snapshot_json #>> '{publicOutputs,app_deployment,url}'),
      (o.snapshot_json #>> '{publicOutputs,app_deployment,launch_url}'),
      (o.snapshot_json #>> '{publicOutputs,app_deployment,app_url}'),
      (o.snapshot_json #>> '{workspaceOutputs,url}'),
      (o.snapshot_json #>> '{workspaceOutputs,launch_url}'),
      (o.snapshot_json #>> '{workspaceOutputs,app_url}'),
      (o.snapshot_json #>> '{workspaceOutputs,public_url}'),
      (o.snapshot_json #>> '{workspaceOutputs,app_deployment,url}'),
      (o.snapshot_json #>> '{workspaceOutputs,app_deployment,launch_url}'),
      (o.snapshot_json #>> '{workspaceOutputs,app_deployment,app_url}')
  ) as urls(url)
),
parsed_hosts as (
  select installation_id,
         workspace_id,
         installation_name,
         installation_status,
         installation_created_at,
         lower(
           case
             when url like 'https://%' then split_part(substring(url from 9), '/', 1)
             else null
           end
         ) as hostname,
         case
           when installation_status = 'active' then 400
           when installation_status = 'stale' then 300
           when installation_status = 'error' and current_state_generation > 0 then 200
           when installation_status = 'pending' and current_state_generation > 0 then 100
           when installation_status = 'disabled' then 50
           else 0
         end as priority
  from raw_hosts
  where url is not null
),
distinct_hosts as (
  select hostname,
         installation_id,
         workspace_id,
         installation_name,
         installation_status,
         installation_created_at,
         max(priority) as priority
  from parsed_hosts
  where hostname is not null
    and hostname != ''
    and hostname not like '%.workers.dev'
  group by hostname, installation_id, workspace_id, installation_name,
           installation_status, installation_created_at
),
ranked as (
  select *,
         row_number() over (
           partition by hostname
           order by priority desc, installation_created_at desc, installation_id desc
         ) as rn
  from distinct_hosts
)
insert into takosumi_public_host_reservations (
  hostname, workspace_id, installation_id, installation_name,
  status, reserved_at, updated_at, released_at
)
select hostname,
       workspace_id,
       installation_id,
       installation_name,
       'reserved',
       to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       null
from ranked
where rn = 1
on conflict (hostname) do update set
  workspace_id = excluded.workspace_id,
  installation_id = excluded.installation_id,
  installation_name = excluded.installation_name,
  status = 'reserved',
  updated_at = excluded.updated_at,
  released_at = null
where takosumi_public_host_reservations.status = 'released'
   or takosumi_public_host_reservations.installation_id = excluded.installation_id`,
    },
    {
      id: "deploy.capsules_active_name_unique",
      version: 65,
      domain: "deploy",
      description:
        "Make Capsule service-name uniqueness apply only to non-destroyed rows so a destroyed Capsule remains in the audit ledger without blocking a later reinstall in the same Workspace/Space and environment.",
      sql: `drop index if exists takosumi_capsules_space_name_environment_unique;
drop index if exists takosumi_opentofu_installations_space_name_environment_unique;
create unique index if not exists takosumi_capsules_space_name_environment_active_unique
  on takosumi_capsules (space_id, name, environment)
  where status <> 'destroyed';`,
      down: `drop index if exists takosumi_capsules_space_name_environment_active_unique;
create unique index if not exists takosumi_capsules_space_name_environment_unique
  on takosumi_capsules (space_id, name, environment);`,
    },
    {
      id: "runtime_projection.service_graph_retired_tables.drop",
      version: 66,
      domain: "runtime-projection",
      description:
        "Drop the retired Service Graph tables after the OSS runtime projection model moved fully to Capsule Outputs. Historical migration rows remain in the immutable migration ledger for checksum validation, but no live or retained table shape is kept.",
      sql: `drop table if exists service_graph_grants_retired;
drop table if exists service_graph_bindings_retired;
drop table if exists service_graph_exports_retired;
drop table if exists service_graph_grants;
drop table if exists service_graph_bindings;
drop table if exists service_graph_exports;`,
    },
    {
      id: "deploy.install_config_store_key.normalize",
      version: 67,
      domain: "deploy",
      description:
        "Converge pre-v1 InstallConfig JSON onto the canonical store key and remove the retired catalog key without retaining a runtime compatibility branch.",
      sql: `update takosumi_install_configs
set config_json = case
  when config_json ? 'store' then config_json - 'catalog'
  else (config_json - 'catalog') || jsonb_build_object('store', config_json -> 'catalog')
end
where config_json ? 'catalog';`,
    },
  ]);
