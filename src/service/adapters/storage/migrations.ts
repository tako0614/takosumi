type StorageDomain =
  | "space"
  | "deploy"
  | "runtime"
  | "resources"
  | "registry"
  | "audit"
  | "service-endpoints"
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

export const postgresStorageTableDefinitions:
  readonly StorageTableDefinition[] = Object.freeze([
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
      indexes: [["space_id"], ["group_id"], [
        "provider",
        "provider_resource_id",
      ]],
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
      indexes: [["space_id"], ["group_id"], ["group_id", "claim_address"], [
        "instance_id",
      ]],
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
      columns: [
        "id",
        "space_id",
        "group_id",
        "snapshot_json",
        "observed_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id", "group_id"], ["observed_at"]],
    },
    {
      name: "runtime_provider_observations",
      domain: "runtime",
      columns: [
        "id",
        "materialization_id",
        "observation_json",
        "observed_at",
      ],
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
        [
          "type",
        ],
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
      columns: [
        "id",
        "endpoint_id",
        "trust_record_json",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [["endpoint_id"]],
    },
    {
      name: "service_grants",
      domain: "service-endpoints",
      columns: [
        "id",
        "trust_record_id",
        "subject",
        "grant_json",
      ],
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
        "installation_id",
        "created_at",
        "run_json",
      ],
      primaryKey: ["id"],
      indexes: [["kind"], ["space_id"], ["installation_id"], ["created_at"]],
    },
    {
      name: "takosumi_spaces",
      domain: "deploy",
      columns: [
        "id",
        "handle",
        "space_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["handle"]],
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
      name: "takosumi_operator_connection_defaults",
      domain: "deploy",
      columns: [
        "id",
        "capability",
        "provider",
        "connection_id",
        "default_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["capability"]],
    },
    {
      name: "takosumi_opentofu_installations",
      domain: "deploy",
      columns: [
        "id",
        "space_id",
        "name",
        "environment",
        "source_id",
        "install_config_id",
        "current_deployment_id",
        "status",
        "installation_json",
        "created_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["space_id", "name", "environment"]],
      indexes: [["space_id"], ["current_deployment_id"], ["created_at"]],
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
        "state_generation",
        "status",
        "deployment_json",
        "created_at",
      ],
      primaryKey: ["id"],
      indexes: [["installation_id"], ["space_id"], ["apply_run_id"], [
        "created_at",
      ]],
    },
    {
      name: "takosumi_deployment_profiles",
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
      name: "takosumi_state_snapshots",
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
      indexes: [["space_id"], ["producer_installation_id"], [
        "consumer_installation_id",
      ]],
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
      name: "takosumi_output_snapshots",
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
      // Cross-Space OutputShare grants (§18). A grant from a producer
      // Installation's projected outputs (in from_space_id) to a consumer
      // Space (to_space_id). share_json carries names + optional aliases only —
      // sensitive sharing is not supported (invariant 12) and resolved output
      // VALUES never land in the share.
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
      indexes: [["from_space_id"], ["to_space_id"], [
        "producer_installation_id",
      ]],
    },
    {
      // Control-backup ledger pointers (§33 layer 1 / §26 R2_BACKUPS). One row
      // per sealed control-backup bundle written to R2_BACKUPS. The bundle
      // bytes live in object storage; only the pointer (objectKey / digest /
      // sizeBytes) round trips through backup_json — never secret material.
      name: "takosumi_backups",
      domain: "deploy",
      columns: ["id", "space_id", "backup_json", "created_at"],
      primaryKey: ["id"],
      indexes: [["space_id"]],
    },
  ]);

export const postgresStorageMigrationStatements:
  readonly StorageMigrationStatement[] = Object.freeze([
    {
      id: "storage_migrations.create",
      version: 1,
      domain: "system",
      description: "Create storage migration ledger.",
      sql:
        "create table if not exists storage_migrations (id text primary key, version integer not null, applied_at timestamptz not null default now())",
      // The system ledger itself is intentionally forward-only: dropping it
      // erases the ability to track which down migrations have been applied.
      // Operators wanting a true factory-reset must drop the database.
    },
    {
      id: "core.tables.create",
      version: 2,
      domain: "core",
      description: "Create Takosumi spaces, groups, and memberships tables.",
      sql:
        `create table if not exists spaces (id text primary key, name text not null, metadata_json jsonb not null, created_by_account_id text not null, created_at timestamptz not null, updated_at timestamptz not null);
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
      sql:
        `create table if not exists resource_instances (id text primary key, space_id text not null, group_id text, contract text not null, origin text not null, sharing_mode text not null, provider text, provider_resource_id text, provider_materialization_id text, lifecycle_json jsonb not null, schema_owner_json jsonb, properties_json jsonb, created_at timestamptz not null, updated_at timestamptz not null);
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
      sql:
        `create table if not exists registry_package_descriptors (kind text not null, ref text not null, digest text not null, publisher text not null, version text, body_json jsonb not null, published_at timestamptz not null, primary key (kind, ref, digest));
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
      sql:
        "create table if not exists audit_events (id text primary key, event_class text not null, type text not null, severity text not null, actor_json jsonb, space_id text, group_id text, target_type text not null, target_id text, payload_json jsonb not null, occurred_at timestamptz not null, request_id text, correlation_id text)",
      down: "drop table if exists audit_events;",
    },
    {
      id: "resources.bindings.claim_index.create",
      version: 8,
      domain: "resources",
      description:
        "Index resource bindings by group and claim address.",
      sql:
        `create index if not exists resource_bindings_group_claim_address_idx on resource_bindings (group_id, claim_address);`,
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
      down:
        `drop index if exists takosumi_deployment_record_locks_locked_until_idx;
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
      description:
        "Create the OpenTofu-native PlanRun and ApplyRun ledger.",
      sql:
        `create table if not exists takosumi_runner_profiles (
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
      down:
        `drop index if exists takosumi_opentofu_deployments_created_at_idx;
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
  space_id        text   not null,
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
  connection_id text  primary key,
  blob_json     jsonb not null
);`,
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
        "Create the App / Environment / InstallProfile / DeploymentProfile lane ledger (Core Specification §6.3-§6.7). An App binds a Source to one install type; an Environment is one execution lane; an InstallProfile is service-side install config (seeded from the official template catalog); a DeploymentProfile carries the per-Environment Connection binding (no secret values).",
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
create table if not exists takosumi_deployment_profiles (
  id             text   primary key,
  environment_id text   not null unique,
  profile_json   jsonb  not null,
  created_at     text   not null,
  updated_at     text   not null
);
create index if not exists takosumi_deployment_profiles_environment_idx
  on takosumi_deployment_profiles (environment_id);`,
      down: `drop index if exists takosumi_deployment_profiles_environment_idx;
drop table if exists takosumi_deployment_profiles;
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
        "Migrate the deploy-control ledger to the Space-direct Installation model (Core Specification §27). Destructively drops the retired App / Environment / InstallProfile lane tables, the split plan/apply/destroy run tables, and the App/Environment-keyed installations / deployments / deployment_profiles / state_snapshots, then creates: spaces, install_configs, operator_connection_defaults, the new-shape installations (UNIQUE(space_id, name, environment)), deployments, deployment_profiles (keyed (installation_id, environment)), state_snapshots (keyed (installation_id, environment, generation) UNIQUE), and a SINGLE runs table (rows discriminated by kind plan / apply / source_sync). No data migration: the prior model is pre-GA and is dropped.",
      sql: `drop table if exists takosumi_apps;
drop table if exists takosumi_environments;
drop table if exists takosumi_install_profiles;
drop table if exists takosumi_destroy_runs;
drop table if exists takosumi_plan_runs;
drop table if exists takosumi_apply_runs;
drop table if exists takosumi_deployment_profiles;
drop table if exists takosumi_state_snapshots;
drop table if exists takosumi_opentofu_deployments;
drop table if exists takosumi_opentofu_installations;
create table if not exists takosumi_runs (
  id              text   primary key,
  kind            text   not null
    check (kind in ('plan','destroy_plan','apply','destroy_apply','source_sync')),
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
create table if not exists takosumi_operator_connection_defaults (
  id            text   primary key,
  capability    text   not null unique,
  provider      text   not null,
  connection_id text   not null,
  default_json  jsonb  not null,
  created_at    text   not null,
  updated_at    text   not null
);
create table if not exists takosumi_opentofu_installations (
  id                     text   primary key,
  space_id               text   not null,
  name                   text   not null,
  environment            text   not null,
  source_id              text   not null,
  install_config_id      text   not null,
  current_deployment_id  text,
  status                 text   not null
    check (status in ('installing','active','stale','error','destroying','destroyed')),
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
  state_generation integer not null,
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
create table if not exists takosumi_deployment_profiles (
  id              text   primary key,
  space_id        text   not null,
  installation_id text   not null,
  environment     text   not null,
  profile_json    jsonb  not null,
  created_at      text   not null,
  updated_at      text   not null,
  unique (installation_id, environment)
);
create index if not exists takosumi_deployment_profiles_installation_idx
  on takosumi_deployment_profiles (installation_id, environment);
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
drop index if exists takosumi_deployment_profiles_installation_idx;
drop table if exists takosumi_deployment_profiles;
drop index if exists takosumi_opentofu_deployments_created_at_idx;
drop index if exists takosumi_opentofu_deployments_apply_idx;
drop index if exists takosumi_opentofu_deployments_space_idx;
drop index if exists takosumi_opentofu_deployments_installation_idx;
drop table if exists takosumi_opentofu_deployments;
drop index if exists takosumi_opentofu_installations_created_at_idx;
drop index if exists takosumi_opentofu_installations_current_deployment_idx;
drop index if exists takosumi_opentofu_installations_space_idx;
drop table if exists takosumi_opentofu_installations;
drop table if exists takosumi_operator_connection_defaults;
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
    check (type in ('space_update','installation_install','installation_update','installation_destroy','migration')),
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
        "Create the cross-Space OutputShare ledger (Core Specification §18 output_shares): a grant from a producer Installation's projected spaceOutputs (in from_space_id) to a consumer Space (to_space_id). share_json carries the public OutputShare — entry names + optional aliases only; sensitive sharing is not supported (invariant 12) and resolved output VALUES never land in the share. Searchable columns (from_space_id / to_space_id / producer_installation_id) drive the per-Space listings. No data migration: additive new table.",
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
        "Create the control-backup ledger (Core Specification §33 layer 1 / §26 R2_BACKUPS): one pointer row per sealed control-backup bundle written to the R2_BACKUPS bucket. backup_json carries the public BackupRecord pointer (objectKey / digest / sizeBytes / optional createdByRunId) — the bundle bytes (gzip-compressed, sealed JSON export of the Space's control ledger) live in object storage, never the DB, and the bundle never contains secret material. The space_id column drives the newest-first per-Space listing. No data migration: additive new table.",
      sql: `create table if not exists takosumi_backups (
  id          text   primary key,
  space_id    text   not null,
  backup_json jsonb  not null,
  created_at  text   not null
);
create index if not exists takosumi_backups_space_idx
  on takosumi_backups (space_id, created_at desc);`,
      down: `drop index if exists takosumi_backups_space_idx;
drop table if exists takosumi_backups;`,
    },
  ]);
