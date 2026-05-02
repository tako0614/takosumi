import type { StorageDomain } from "./statements.ts";

export interface StorageTableDefinition {
  readonly name: string;
  readonly domain: StorageDomain;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly uniqueConstraints?: readonly (readonly string[])[];
  readonly indexes?: readonly (readonly string[])[];
}

export interface StorageMigrationStatement {
  readonly id: string;
  readonly version: number;
  readonly domain: StorageDomain | "system";
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
      name: "core_spaces",
      domain: "core",
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
      name: "core_groups",
      domain: "core",
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
      name: "core_space_memberships",
      domain: "core",
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
      name: "deployments",
      domain: "deploy",
      columns: [
        "id",
        "group_id",
        "space_id",
        "input_json",
        "resolution_json",
        "desired_json",
        "status",
        "conditions_json",
        "policy_decisions_json",
        "approval_json",
        "rollback_target",
        "created_at",
        "applied_at",
        "finalized_at",
      ],
      primaryKey: ["id"],
      indexes: [["group_id", "created_at"], ["status"], ["space_id"]],
    },
    {
      name: "provider_observations",
      domain: "deploy",
      columns: [
        "id",
        "deployment_id",
        "provider_id",
        "object_address",
        "observed_state",
        "drift_status",
        "observed_digest",
        "observed_state_json",
        "observed_at",
        "archived",
      ],
      primaryKey: ["id"],
      indexes: [["deployment_id"], ["observed_at"], ["archived"]],
    },
    {
      name: "group_heads",
      domain: "deploy",
      columns: [
        "space_id",
        "group_id",
        "current_deployment_id",
        "previous_deployment_id",
        "generation",
        "advanced_at",
      ],
      primaryKey: ["space_id", "group_id"],
      indexes: [["current_deployment_id"]],
    },
    {
      name: "group_head_history",
      domain: "deploy",
      columns: [
        "space_id",
        "group_id",
        "deployment_id",
        "previous_deployment_id",
        "sequence",
        "advanced_at",
      ],
      primaryKey: ["space_id", "group_id", "sequence"],
      indexes: [
        ["space_id", "group_id", "sequence"],
        ["space_id", "group_id", "deployment_id"],
      ],
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
        "archived",
      ],
      primaryKey: ["id"],
      indexes: [["materialization_id"], ["observed_at"], ["archived"]],
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
      name: "usage_aggregates",
      domain: "usage",
      columns: [
        "id",
        "space_id",
        "group_id",
        "owner_kind",
        "metric",
        "unit",
        "quantity",
        "event_count",
        "first_occurred_at",
        "last_occurred_at",
        "updated_at",
      ],
      primaryKey: ["id"],
      indexes: [["space_id"], ["group_id"], ["owner_kind", "metric"]],
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
      description: "Create core spaces, groups, and memberships tables.",
      sql:
        `create table if not exists core_spaces (id text primary key, name text not null, metadata_json jsonb not null, created_by_account_id text not null, created_at timestamptz not null, updated_at timestamptz not null);
create table if not exists core_groups (id text primary key, space_id text not null references core_spaces(id), slug text not null, display_name text not null, metadata_json jsonb not null, created_by_account_id text not null, created_at timestamptz not null, updated_at timestamptz not null, unique (space_id, slug));
create table if not exists core_space_memberships (id text primary key, space_id text not null references core_spaces(id), account_id text not null, roles_json jsonb not null, status text not null, created_at timestamptz not null, updated_at timestamptz not null, unique (space_id, account_id));`,
      down: `drop table if exists core_space_memberships;
drop table if exists core_groups;
drop table if exists core_spaces;`,
    },
    {
      id: "deploy.tables.create",
      version: 3,
      domain: "deploy",
      description:
        "Create deploy plan, activation, pointer, and operation tables.",
      sql:
        `create table if not exists deploy_plans (id text primary key, space_id text not null, group_id text not null, plan_json jsonb not null, created_at timestamptz not null);
create table if not exists deploy_activation_records (id text primary key, space_id text not null, group_id text not null, plan_id text not null, manifest_json jsonb not null, app_spec_json jsonb not null, core_app_spec_json jsonb, core_env_spec_json jsonb, core_policy_spec_json jsonb, descriptor_closure_json jsonb, resolved_graph_json jsonb, core_plan_json jsonb, core_activation_json jsonb not null default '{}'::jsonb, descriptor_closure_id text not null default '', descriptor_closure_digest text not null default '', resolved_graph_digest text not null default '', source_json jsonb not null, status text not null, retained_artifacts_json jsonb, rollback_json jsonb, created_at timestamptz not null, created_by text, actor_json jsonb);
create table if not exists deploy_group_activation_pointers (space_id text not null, group_id text not null, activation_id text not null references deploy_activation_records(id), advanced_at timestamptz not null, primary key (space_id, group_id));
create table if not exists deploy_operation_records (id text primary key, kind text not null, status text not null, space_id text not null, group_id text not null, activation_id text, plan_id text, created_at timestamptz not null, updated_at timestamptz not null, error text);`,
      down: `drop table if exists deploy_operation_records;
drop table if exists deploy_group_activation_pointers;
drop table if exists deploy_activation_records;
drop table if exists deploy_plans;`,
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
create table if not exists resource_binding_set_revisions (id text primary key, space_id text not null, group_id text not null, component_address text, structure_digest text, inputs_json jsonb not null default '[]'::jsonb, binding_value_resolutions_json jsonb not null default '[]'::jsonb, conditions_json jsonb not null default '[]'::jsonb, activation_record_id text, resource_binding_ids_json jsonb not null, secret_bindings_json jsonb not null, publication_bindings_json jsonb not null, created_at timestamptz not null);
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
      id: "deploy.activation_core_snapshots.add",
      version: 7,
      domain: "deploy",
      description:
        "Persist Core activation snapshots and rollback retention metadata.",
      sql:
        `alter table deploy_activation_records add column if not exists core_app_spec_json jsonb;
alter table deploy_activation_records add column if not exists core_env_spec_json jsonb;
alter table deploy_activation_records add column if not exists core_policy_spec_json jsonb;
alter table deploy_activation_records add column if not exists descriptor_closure_json jsonb;
alter table deploy_activation_records add column if not exists resolved_graph_json jsonb;
alter table deploy_activation_records add column if not exists core_plan_json jsonb;
alter table deploy_activation_records add column if not exists retained_artifacts_json jsonb;
alter table deploy_activation_records add column if not exists rollback_json jsonb;`,
      // Note: `deploy_activation_records` itself is dropped by the deployment collapse
      // migration (version 10). The down side here only reverts the columns
      // added by version 7 — and only runs if version 10 is rolled back first.
      down:
        `alter table deploy_activation_records drop column if exists rollback_json;
alter table deploy_activation_records drop column if exists retained_artifacts_json;
alter table deploy_activation_records drop column if exists core_plan_json;
alter table deploy_activation_records drop column if exists resolved_graph_json;
alter table deploy_activation_records drop column if exists descriptor_closure_json;
alter table deploy_activation_records drop column if exists core_policy_spec_json;
alter table deploy_activation_records drop column if exists core_env_spec_json;
alter table deploy_activation_records drop column if exists core_app_spec_json;`,
    },
    {
      id: "resources.bindings.allow_historical_claim_rebind",
      version: 8,
      domain: "resources",
      description:
        "Allow historical resource bindings to retain claim addresses after unbind.",
      sql:
        `alter table resource_bindings drop constraint if exists resource_bindings_group_id_claim_address_key;
create index if not exists resource_bindings_group_claim_address_idx on resource_bindings (group_id, claim_address);`,
      // Down only drops the index this migration added. The unique constraint
      // it dropped is *not* re-added by rollback because doing so could fail
      // against historical bindings rows that the source schema would now reject.
      down: `drop index if exists resource_bindings_group_claim_address_idx;`,
    },
    {
      id: "resources.binding_set_revisions.core_columns.add",
      version: 9,
      domain: "resources",
      description:
        "Persist Core BindingSetRevision structure, value resolutions, and conditions.",
      sql:
        `alter table resource_binding_set_revisions add column if not exists component_address text;
alter table resource_binding_set_revisions add column if not exists structure_digest text;
alter table resource_binding_set_revisions add column if not exists inputs_json jsonb not null default '[]'::jsonb;
alter table resource_binding_set_revisions add column if not exists binding_value_resolutions_json jsonb not null default '[]'::jsonb;
alter table resource_binding_set_revisions add column if not exists conditions_json jsonb not null default '[]'::jsonb;`,
      down:
        `alter table resource_binding_set_revisions drop column if exists conditions_json;
alter table resource_binding_set_revisions drop column if exists binding_value_resolutions_json;
alter table resource_binding_set_revisions drop column if exists inputs_json;
alter table resource_binding_set_revisions drop column if exists structure_digest;
alter table resource_binding_set_revisions drop column if exists component_address;`,
    },
    {
      id: "deploy.unify_to_deployments",
      version: 10,
      domain: "deploy",
      description:
        "Collapse deploy records into deployments / provider_observations / group_heads.",
      sql:
        `create table if not exists deployments (id text primary key, group_id text not null, space_id text not null, input_json jsonb not null, resolution_json jsonb not null, desired_json jsonb not null, status text not null check (status in ('preview','resolved','applying','applied','failed','rolled-back')), conditions_json jsonb not null default '[]'::jsonb, policy_decisions_json jsonb not null default '[]'::jsonb, approval_json jsonb, rollback_target text references deployments(id), created_at timestamptz not null default now(), applied_at timestamptz, finalized_at timestamptz);
create index if not exists deployments_group_created_idx on deployments (group_id, created_at desc);
create index if not exists deployments_status_idx on deployments (status);
create index if not exists deployments_space_idx on deployments (space_id);
create table if not exists provider_observations (id text primary key, deployment_id text not null references deployments(id), provider_id text not null, object_address text not null, observed_state text not null check (observed_state in ('present','missing','drifted','unknown')), drift_status text, observed_digest text, observed_state_json jsonb not null default '{}'::jsonb, observed_at timestamptz not null);
create index if not exists provider_observations_deployment_idx on provider_observations (deployment_id);
create index if not exists provider_observations_observed_at_idx on provider_observations (observed_at desc);
create table if not exists group_heads (space_id text not null, group_id text not null, current_deployment_id text not null references deployments(id), previous_deployment_id text references deployments(id), generation bigint not null default 1, advanced_at timestamptz not null default now(), primary key (space_id, group_id));
create index if not exists group_heads_current_idx on group_heads (current_deployment_id);
insert into deployments (id, group_id, space_id, input_json, resolution_json, desired_json, status, conditions_json, policy_decisions_json, approval_json, rollback_target, created_at, applied_at, finalized_at)
  select coalesce(ar.id, p.id), p.group_id, p.space_id,
         jsonb_build_object('manifest_snapshot', coalesce(ar.manifest_json, p.plan_json -> 'manifest', '{}'::jsonb), 'source_kind', coalesce(ar.source_json ->> 'kind', 'manifest'), 'source_ref', ar.source_json ->> 'ref'),
         jsonb_build_object('descriptor_closure', coalesce(ar.descriptor_closure_json, p.plan_json -> 'descriptorClosure', '{}'::jsonb), 'resolved_graph', coalesce(ar.resolved_graph_json, p.plan_json -> 'resolvedGraph', '{}'::jsonb)),
         coalesce(ar.core_activation_json, '{}'::jsonb),
         case when ar.id is not null and ar.status in ('succeeded','applied') then 'applied'
              when ar.id is not null and ar.status in ('running','queued')    then 'applying'
              when ar.id is not null and ar.status in ('failed','cancelled')  then 'failed'
              else 'resolved' end,
         coalesce(p.plan_json -> 'conditions', '[]'::jsonb),
         coalesce(p.plan_json -> 'policyDecisions', '[]'::jsonb),
         ar.rollback_json,
         ar.rollback_json ->> 'targetActivationId',
         coalesce(ar.created_at, p.created_at),
         case when ar.id is not null then ar.created_at end,
         case when ar.id is not null and ar.status in ('succeeded','applied') then ar.created_at end
    from deploy_plans p left join deploy_activation_records ar on ar.plan_id = p.id
  on conflict (id) do nothing;
insert into deployments (id, group_id, space_id, input_json, resolution_json, desired_json, status, conditions_json, policy_decisions_json, approval_json, rollback_target, created_at, applied_at, finalized_at)
  select ar.id, ar.group_id, ar.space_id,
         jsonb_build_object('manifest_snapshot', coalesce(ar.manifest_json, '{}'::jsonb), 'source_kind', coalesce(ar.source_json ->> 'kind', 'manifest'), 'source_ref', ar.source_json ->> 'ref'),
         jsonb_build_object('descriptor_closure', coalesce(ar.descriptor_closure_json, '{}'::jsonb), 'resolved_graph', coalesce(ar.resolved_graph_json, '{}'::jsonb)),
         coalesce(ar.core_activation_json, '{}'::jsonb),
         case when ar.status in ('succeeded','applied') then 'applied'
              when ar.status in ('running','queued')    then 'applying'
              when ar.status = 'failed'                  then 'failed'
              else 'applied' end,
         '[]'::jsonb, '[]'::jsonb, ar.rollback_json,
         ar.rollback_json ->> 'targetActivationId',
         ar.created_at, ar.created_at,
         case when ar.status in ('succeeded','applied') then ar.created_at end
    from deploy_activation_records ar
    where not exists (select 1 from deployments d where d.id = ar.id)
  on conflict (id) do nothing;
update deployments d set conditions_json = coalesce(d.conditions_json,'[]'::jsonb) || op_arr.entries
  from (select coalesce(o.activation_id, o.plan_id) as deployment_id,
               jsonb_agg(jsonb_build_object('type', concat('Operation:', o.kind),
                                            'status', case when o.status in ('succeeded','applied') then 'true' when o.status='failed' then 'false' else 'unknown' end,
                                            'reason', o.error, 'message', o.error,
                                            'observed_generation', 1,
                                            'last_transition_time', o.updated_at,
                                            'scope', jsonb_build_object('kind','operation','ref', o.id))
                         order by o.created_at) as entries
        from deploy_operation_records o
        where coalesce(o.activation_id, o.plan_id) is not null
        group by coalesce(o.activation_id, o.plan_id)) op_arr
  where op_arr.deployment_id = d.id;
update deployments d set desired_json = jsonb_set(coalesce(d.desired_json,'{}'::jsonb), '{bindings}', br.merged_inputs, true)
  from (select activation_record_id as deployment_id, jsonb_agg(coalesce(inputs_json,'[]'::jsonb)) as merged_inputs
        from resource_binding_set_revisions where activation_record_id is not null
        group by activation_record_id) br
  where br.deployment_id = d.id;
insert into group_heads (space_id, group_id, current_deployment_id, previous_deployment_id, generation, advanced_at)
  select p.space_id, p.group_id, p.activation_id,
         (select prev.id from deployments prev
            where prev.space_id = p.space_id
              and prev.group_id = p.group_id
              and prev.id <> p.activation_id
              and prev.status in ('applied','rolled-back')
            order by coalesce(prev.applied_at, prev.created_at) desc, prev.id desc
            limit 1),
         1, p.advanced_at
    from deploy_group_activation_pointers p
    where exists (select 1 from deployments d where d.id = p.activation_id)
  on conflict (space_id, group_id) do nothing;
drop table if exists deploy_operation_records;
drop table if exists deploy_group_activation_pointers;
drop table if exists deploy_activation_records;
drop table if exists deploy_plans;
alter table resource_binding_set_revisions
  drop column if exists activation_record_id,
  drop column if exists resource_binding_ids_json,
  drop column if exists secret_bindings_json,
  drop column if exists publication_bindings_json,
  drop column if exists component_address,
  drop column if exists structure_digest,
  drop column if exists inputs_json,
  drop column if exists conditions_json;`,
      // Forward-only: this migration drops source deploy tables after folding
      // their data into the current Deployment schema. Dropping current deployment tables in a down
      // migration would leave the storage_migrations ledger claiming v9 while
      // the source schema/data no longer exists, so the runner must refuse rollback
      // past this point.
    },
    {
      id: "runtime.agent_work_ledger.create",
      version: 11,
      domain: "runtime",
      description:
        "Create persistent runtime agent registry + work ledger so leases survive kernel restarts (Phase 18 / C5).",
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
      id: "usage.aggregates.create",
      version: 14,
      domain: "usage",
      description:
        "Create usage aggregate projection table referenced by the usage storage catalog.",
      sql: `create table if not exists usage_aggregates (
  id                 text        primary key,
  space_id           text        not null,
  group_id           text,
  owner_kind         text        not null,
  metric             text        not null,
  unit               text        not null,
  quantity           numeric     not null,
  event_count        integer     not null,
  first_occurred_at  timestamptz not null,
  last_occurred_at   timestamptz not null,
  updated_at         timestamptz not null
);
create index if not exists usage_aggregates_space_idx on usage_aggregates (space_id);
create index if not exists usage_aggregates_group_idx on usage_aggregates (group_id);
create index if not exists usage_aggregates_owner_metric_idx
  on usage_aggregates (owner_kind, metric);`,
      down: "drop table if exists usage_aggregates;",
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
        "Create kernel-side custom domain reservations table for cross-tenant collision detection.",
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
      id: "deploy.group_head_history.create",
      version: 17,
      domain: "deploy",
      description:
        "Retain N generations of group_head pointer history so multi-generation rollback (`rollbackGroup --steps=N` or `rollbackGroup --target=<deployment_id>`) can address any prior applied Deployment, not just the single previous_deployment_id slot tracked on group_heads (Phase 18.3 / M6).",
      sql: `create table if not exists group_head_history (
  space_id                  text        not null,
  group_id                  text        not null,
  deployment_id             text        not null references deployments(id),
  previous_deployment_id    text        references deployments(id),
  sequence                  bigint      not null,
  advanced_at               timestamptz not null default now(),
  primary key (space_id, group_id, sequence)
);
create index if not exists group_head_history_recent_idx
  on group_head_history (space_id, group_id, sequence desc);
create index if not exists group_head_history_deployment_idx
  on group_head_history (space_id, group_id, deployment_id);
insert into group_head_history (
  space_id, group_id, deployment_id, previous_deployment_id,
  sequence, advanced_at
)
select
  gh.space_id,
  gh.group_id,
  gh.previous_deployment_id,
  null,
  greatest(gh.generation - 1, 1) as sequence,
  gh.advanced_at
from group_heads gh
where gh.previous_deployment_id is not null
  and not exists (
    select 1 from group_head_history h
    where h.space_id = gh.space_id
      and h.group_id = gh.group_id
      and h.sequence = greatest(gh.generation - 1, 1)
  );
insert into group_head_history (
  space_id, group_id, deployment_id, previous_deployment_id,
  sequence, advanced_at
)
select
  gh.space_id,
  gh.group_id,
  gh.current_deployment_id,
  gh.previous_deployment_id,
  gh.generation as sequence,
  gh.advanced_at
from group_heads gh
where not exists (
  select 1 from group_head_history h
  where h.space_id = gh.space_id
    and h.group_id = gh.group_id
    and h.sequence = gh.generation
);`,
      down: `drop index if exists group_head_history_deployment_idx;
drop index if exists group_head_history_recent_idx;
drop table if exists group_head_history;`,
    },
    {
      id: "deploy.provider_observations.archived",
      version: 18,
      domain: "deploy",
      description:
        "Add archived flag + supporting indexes to provider_observations / runtime_provider_observations for the Phase 18.3 retention GC.",
      sql:
        `alter table provider_observations add column if not exists archived boolean not null default false;
create index if not exists provider_observations_archived_idx on provider_observations (archived);
alter table runtime_provider_observations add column if not exists archived boolean not null default false;
create index if not exists runtime_provider_observations_archived_idx on runtime_provider_observations (archived);`,
      down: `drop index if exists runtime_provider_observations_archived_idx;
alter table runtime_provider_observations drop column if exists archived;
drop index if exists provider_observations_archived_idx;
alter table provider_observations drop column if exists archived;`,
    },
    {
      id: "internal_auth.replay_protection_log.create",
      version: 19,
      domain: "internal-auth",
      description:
        "Create distributed replay protection log so multiple PaaS replicas share one source of truth for observed signed internal RPC request-ids (Phase 18.3 / M4).",
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
  ]);
