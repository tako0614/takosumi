PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE takosumi_cf_opentofu_ledger (
      namespace text not null,
      key text not null,
      space_id text,
      installation_id text,
      status text,
      record_json text not null,
      created_at integer not null,
      updated_at integer not null,
      primary key (namespace, key)
    );
CREATE TABLE IF NOT EXISTS "workspaces" (
      id text primary key,
      handle text not null unique,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE sources (
      id text primary key,
      space_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE connections (
      id text primary key,
      space_id text,
      provider text not null,
      status text not null,
      connection_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE secret_blobs (
      id text primary key,
      connection_id text not null,
      space_id text,
      kind text not null,
      ciphertext text not null,
      encrypted_dek text not null,
      nonce text not null,
      aad text not null,
      key_version integer not null,
      created_at text not null,
      rotated_at text,
      blob_json text not null
    );
CREATE TABLE operator_connection_defaults (
      id text primary key,
      capability text not null,
      provider text not null,
      connection_id text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE install_configs (
      id text primary key,
      space_id text,
      install_type text not null,
      trust_level text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE capsule_compatibility_reports (
      id text primary key,
      source_id text,
      installation_id text,
      source_snapshot_id text not null,
      level text not null,
      findings_json text not null,
      providers_json text not null,
      resources_json text not null,
      data_sources_json text not null,
      provisioners_json text not null,
      normalized_object_key text,
      normalized_digest text,
      created_at text not null
    , root_module_variables_json text not null default '[]', root_module_outputs_json text not null default '[]');
CREATE TABLE provider_catalog_entries (
      id text primary key,
      provider_source text not null,
      support_type text not null,
      default_eligible integer not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE custom_provider_packs (
      id text primary key,
      space_id text not null,
      provider_source text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE provider_pins (
      id text primary key,
      space_id text not null,
      provider_pack_id text not null,
      provider_source text not null,
      selected_version text not null,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE deployment_profiles (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE runs (
      id text primary key,
      run_group_id text,
      space_id text not null,
      source_id text,
      installation_id text,
      environment text,
      type text not null,
      status text not null,
      run_json text not null,
      created_at text not null default ""
    , lease_token text, heartbeat_at integer);
CREATE TABLE runs_inputs (
      plan_run_id text primary key,
      inputs_json text not null
    );
CREATE TABLE IF NOT EXISTS "state_versions" (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      generation integer not null,
      object_key text not null,
      digest text not null,
      created_by_run_id text not null,
      created_at text not null,
      unique (installation_id, environment, generation)
    );
CREATE TABLE deployments (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      apply_run_id text not null,
      source_snapshot_id text not null,
      dependency_snapshot_id text,
      state_generation integer not null,
      output_snapshot_id text not null,
      outputs_public_json text not null,
      status text not null,
      created_at text not null
    );
CREATE TABLE artifacts (
      id text primary key,
      run_id text not null,
      kind text not null,
      object_key text not null,
      digest text not null,
      size_bytes integer not null,
      created_at text not null
    );
CREATE TABLE runner_profiles (
      id text primary key,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE installation_dependencies (
      id text primary key,
      space_id text not null,
      producer_installation_id text not null,
      consumer_installation_id text not null,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE dependency_snapshots (
      id text primary key,
      run_id text not null,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE IF NOT EXISTS "outputs" (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      state_generation integer not null,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE output_shares (
      id text primary key,
      from_space_id text not null,
      to_space_id text not null,
      producer_installation_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE run_groups (
      id text primary key,
      space_id text not null,
      type text not null,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE audit_events (
      id text primary key,
      space_id text not null,
      actor_id text,
      action text not null,
      target_type text not null,
      target_id text not null,
      run_id text,
      created_at text not null,
      record_json text not null
    );
CREATE TABLE credential_mint_events (
      id text primary key,
      run_id text not null,
      space_id text not null,
      installation_id text,
      source_id text,
      connection_id text not null,
      phase text not null,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE security_findings (
      id text primary key,
      space_id text not null,
      installation_id text,
      run_id text,
      severity text not null,
      type text not null,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE billing_accounts (
      id text primary key,
      owner_type text not null,
      owner_id text not null,
      provider text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE plans (
      id text primary key,
      name text not null,
      monthly_base_price integer not null,
      included_credits integer not null,
      limits_json text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    , included_usd_micros integer);
CREATE TABLE space_subscriptions (
      id text primary key,
      space_id text not null,
      billing_account_id text not null,
      plan_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE credit_balances (
      space_id text primary key,
      available_credits integer not null,
      reserved_credits integer not null,
      monthly_included_credits integer not null,
      purchased_credits integer not null,
      updated_at text not null
    , available_usd_micros integer, reserved_usd_micros integer, monthly_included_usd_micros integer, purchased_usd_micros integer);
CREATE TABLE usage_events (
      id text primary key,
      space_id text not null,
      installation_id text,
      run_id text,
      kind text not null,
      quantity real not null,
      credits integer not null,
      source text not null,
      idempotency_key text not null,
      created_at text not null
    , meter_id text, resource_family text, resource_id text, operation text, resource_metadata_json text, usd_micros integer);
CREATE TABLE credit_reservations (
      id text primary key,
      space_id text not null,
      run_id text not null,
      estimated_credits integer not null,
      status text not null,
      mode text not null,
      record_json text not null,
      created_at text not null,
      expires_at text not null
    , estimated_usd_micros integer);
CREATE TABLE backups (
      id text primary key,
      space_id text not null,
      installation_id text,
      environment text,
      created_by_run_id text,
      record_json text not null,
      created_at text not null
    );
CREATE TABLE provider_env_binding_sets (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at text not null
    );
CREATE TABLE IF NOT EXISTS "provider_catalog_retired" (
        id text primary key,
        provider_source text not null,
        primary_materialization text not null check (primary_materialization in ('oauth','secret')),
        gateway_eligible integer not null check (gateway_eligible in (0,1)),
        record_json text not null,
        created_at text not null,
        updated_at text not null
      );
CREATE TABLE IF NOT EXISTS "provider_envs_retired" (
        id text primary key,
        space_id text not null,
        provider_source text not null,
        materialization text not null check (materialization in ('oauth','secret')),
        status text not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      );
CREATE TABLE IF NOT EXISTS "source_snapshots" (
      id text primary key,
      source_id text,
      record_json text not null,
      fetched_at text not null
    );
CREATE TABLE IF NOT EXISTS "capsules" (
      id text primary key,
      space_id text not null,
      name text not null,
      slug text not null,
      source_id text,
      install_type text not null,
      install_config_id text not null,
      environment text not null,
      current_state_version_id text,
      current_state_generation integer not null default 0,
      current_output_snapshot_id text,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    , project_id text);
CREATE TABLE takosumi_cf_storage_snapshots (
      id text primary key,
      snapshot_json text not null,
      updated_at text not null
    );
CREATE TABLE IF NOT EXISTS "takosumi_service_graph_exports_retired" (
        id text primary key,
        space_id text not null,
        producer_installation_id text not null,
        name text not null,
        capabilities_json text not null,
        visibility text not null,
        status text not null,
        deployment_id text,
        output_snapshot_id text,
        record_json text not null,
        updated_at text not null
      );
CREATE TABLE IF NOT EXISTS "takosumi_service_graph_bindings_retired" (
        id text primary key,
        space_id text not null,
        consumer_installation_id text not null,
        selected_service_export_id text,
        selector_json text not null,
        status text not null,
        dependency_snapshot_id text,
        record_json text not null,
        updated_at text not null
      );
CREATE TABLE IF NOT EXISTS "takosumi_service_graph_grants_retired" (
        id text primary key,
        space_id text not null,
        binding_id text not null,
        service_export_id text not null,
        consumer_installation_id text not null,
        status text not null,
        expires_at text,
        record_json text not null,
        created_at text not null
      );
CREATE TABLE takosumi_observability_metrics (
        id text primary key,
        name text not null,
        kind text not null,
        value real not null,
        unit text,
        tags_json text,
        space_id text,
        group_id text,
        actor_json text,
        payload_json text,
        observed_at text not null,
        request_id text,
        correlation_id text,
        created_at text not null default current_timestamp
      );
CREATE TABLE billing_auto_recharge_attempts (
      id text primary key,
      space_id text not null,
      run_id text not null,
      billing_account_id text not null,
      idempotency_key text not null,
      period_start text not null,
      period_end text,
      requested_usd_micros integer not null,
      monthly_limit_usd_micros integer,
      charged_usd_micros integer,
      status text not null,
      stripe_payment_intent_id text,
      provider_status text,
      failure_reason text,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE projects (
      id text primary key,
      workspace_id text not null,
      name text not null,
      slug text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE resource_shapes (
      id text primary key,
      space_id text not null,
      project text,
      environment text,
      kind text not null,
      name text not null,
      managed_by text not null,
      spec_json text not null,
      phase text not null,
      generation integer not null,
      observed_generation integer not null,
      outputs_json text,
      conditions_json text,
      labels_json text,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE resolution_locks (
      resource_id text primary key,
      selected_implementation text not null,
      target text not null,
      locked integer not null,
      reason_json text not null,
      portability text,
      native_resources_json text,
      locked_at text not null,
      updated_at text not null
    );
CREATE TABLE target_pools (
      id text primary key,
      space_id text not null,
      name text not null,
      spec_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE space_policies (
      id text primary key,
      space_id text not null,
      name text not null,
      spec_json text not null,
      created_at text not null,
      updated_at text not null
    );
CREATE TABLE IF NOT EXISTS "public_host_reservations" (
            hostname text primary key,
            owner_user_id text not null,
            workspace_id text not null,
            installation_id text not null,
            installation_name text not null,
            allocation_kind text not null
              check (allocation_kind in ('scoped','vanity')),
            status text not null
              check (status in ('reserved','released')),
            reserved_at text not null,
            updated_at text not null,
            released_at text
          );
CREATE INDEX takosumi_cf_opentofu_ledger_space_idx
      on takosumi_cf_opentofu_ledger (namespace, space_id, created_at);
CREATE INDEX takosumi_cf_opentofu_ledger_installation_idx
      on takosumi_cf_opentofu_ledger (namespace, installation_id, created_at);
CREATE INDEX takosumi_cf_opentofu_ledger_status_idx
      on takosumi_cf_opentofu_ledger (namespace, status, updated_at);
CREATE UNIQUE INDEX operator_connection_defaults_capability_idx
      on operator_connection_defaults (capability);
CREATE UNIQUE INDEX provider_catalog_entries_source_unique
      on provider_catalog_entries (provider_source);
CREATE UNIQUE INDEX deployment_profiles_installation_env_idx
      on deployment_profiles (installation_id, environment);
CREATE INDEX provider_catalog_entries_support_type_idx
      on provider_catalog_entries (support_type);
CREATE INDEX provider_catalog_entries_default_eligible_idx
      on provider_catalog_entries (default_eligible);
CREATE INDEX custom_provider_packs_space_idx
      on custom_provider_packs (space_id);
CREATE INDEX custom_provider_packs_provider_source_idx
      on custom_provider_packs (provider_source);
CREATE INDEX custom_provider_packs_status_idx
      on custom_provider_packs (status);
CREATE INDEX provider_pins_space_idx
      on provider_pins (space_id);
CREATE INDEX provider_pins_pack_idx
      on provider_pins (provider_pack_id);
CREATE INDEX provider_pins_provider_source_idx
      on provider_pins (provider_source);
CREATE UNIQUE INDEX operator_connection_defaults_provider_idx
      on operator_connection_defaults (provider);
CREATE INDEX sources_space_idx
      on sources (space_id);
CREATE INDEX sources_status_idx
      on sources (status);
CREATE INDEX connections_space_idx
      on connections (space_id);
CREATE INDEX connections_provider_idx
      on connections (provider);
CREATE INDEX connections_status_idx
      on connections (status);
CREATE UNIQUE INDEX secret_blobs_connection_idx
      on secret_blobs (connection_id);
CREATE INDEX provider_envs_space_idx
      on "provider_envs_retired" (space_id);
CREATE INDEX provider_envs_provider_source_idx
      on "provider_envs_retired" (provider_source);
CREATE INDEX provider_envs_materialization_idx
      on "provider_envs_retired" (materialization);
CREATE INDEX provider_envs_status_idx
      on "provider_envs_retired" (status);
CREATE UNIQUE INDEX provider_catalog_source_unique
      on "provider_catalog_retired" (provider_source);
CREATE INDEX provider_catalog_primary_materialization_idx
      on "provider_catalog_retired" (primary_materialization);
CREATE INDEX provider_catalog_gateway_eligible_idx
      on "provider_catalog_retired" (gateway_eligible);
CREATE INDEX install_configs_space_idx
      on install_configs (space_id);
CREATE INDEX install_configs_install_type_idx
      on install_configs (install_type);
CREATE INDEX capsule_compatibility_reports_source_snapshot_idx
      on capsule_compatibility_reports (source_snapshot_id);
CREATE INDEX capsule_compatibility_reports_source_idx
      on capsule_compatibility_reports (source_id);
CREATE INDEX capsule_compatibility_reports_installation_idx
      on capsule_compatibility_reports (installation_id);
CREATE INDEX capsule_compatibility_reports_level_idx
      on capsule_compatibility_reports (level);
CREATE UNIQUE INDEX provider_env_binding_sets_installation_environment_unique
      on provider_env_binding_sets (installation_id, environment);
CREATE INDEX provider_env_binding_sets_installation_idx
      on provider_env_binding_sets (installation_id);
CREATE INDEX runs_space_idx
      on runs (space_id);
CREATE INDEX runs_source_idx
      on runs (source_id);
CREATE INDEX runs_installation_idx
      on runs (installation_id);
CREATE INDEX runs_type_idx
      on runs (type);
CREATE INDEX runs_created_at_idx
      on runs (created_at);
CREATE INDEX deployments_space_idx
      on deployments (space_id);
CREATE INDEX deployments_installation_idx
      on deployments (installation_id);
CREATE INDEX deployments_apply_idx
      on deployments (apply_run_id);
CREATE INDEX artifacts_run_idx
      on artifacts (run_id);
CREATE INDEX installation_dependencies_space_idx
      on installation_dependencies (space_id);
CREATE INDEX installation_dependencies_consumer_idx
      on installation_dependencies (consumer_installation_id);
CREATE INDEX installation_dependencies_producer_idx
      on installation_dependencies (producer_installation_id);
CREATE INDEX dependency_snapshots_run_idx
      on dependency_snapshots (run_id);
CREATE INDEX output_shares_from_space_idx
      on output_shares (from_space_id);
CREATE INDEX output_shares_to_space_idx
      on output_shares (to_space_id);
CREATE INDEX output_shares_producer_idx
      on output_shares (producer_installation_id);
CREATE INDEX run_groups_space_idx
      on run_groups (space_id);
CREATE INDEX audit_events_space_idx
      on audit_events (space_id);
CREATE INDEX credential_mint_events_run_idx
      on credential_mint_events (run_id);
CREATE INDEX credential_mint_events_space_idx
      on credential_mint_events (space_id);
CREATE INDEX credential_mint_events_source_idx
      on credential_mint_events (source_id);
CREATE INDEX security_findings_space_idx
      on security_findings (space_id);
CREATE INDEX security_findings_run_idx
      on security_findings (run_id);
CREATE INDEX security_findings_severity_idx
      on security_findings (severity);
CREATE INDEX billing_accounts_owner_idx
      on billing_accounts (owner_type, owner_id);
CREATE INDEX billing_accounts_status_idx
      on billing_accounts (status);
CREATE INDEX space_subscriptions_space_idx
      on space_subscriptions (space_id);
CREATE INDEX space_subscriptions_billing_account_idx
      on space_subscriptions (billing_account_id);
CREATE INDEX usage_events_space_idx
      on usage_events (space_id);
CREATE INDEX usage_events_run_idx
      on usage_events (run_id);
CREATE UNIQUE INDEX usage_events_idempotency_key_unique
      on usage_events (idempotency_key);
CREATE INDEX credit_reservations_space_idx
      on credit_reservations (space_id);
CREATE INDEX credit_reservations_run_idx
      on credit_reservations (run_id);
CREATE INDEX credit_reservations_status_idx
      on credit_reservations (status);
CREATE INDEX backups_space_idx
      on backups (space_id);
CREATE INDEX backups_installation_idx
      on backups (installation_id);
CREATE INDEX source_snapshots_source_idx
      on source_snapshots (source_id);
CREATE INDEX takosumi_service_graph_exports_space_idx
        on "takosumi_service_graph_exports_retired" (space_id);
CREATE INDEX takosumi_service_graph_exports_producer_idx
        on "takosumi_service_graph_exports_retired" (producer_installation_id);
CREATE INDEX takosumi_service_graph_exports_status_idx
        on "takosumi_service_graph_exports_retired" (space_id, status);
CREATE INDEX takosumi_service_graph_bindings_space_idx
        on "takosumi_service_graph_bindings_retired" (space_id);
CREATE INDEX takosumi_service_graph_bindings_consumer_idx
        on "takosumi_service_graph_bindings_retired" (consumer_installation_id);
CREATE INDEX takosumi_service_graph_bindings_export_idx
        on "takosumi_service_graph_bindings_retired" (selected_service_export_id);
CREATE INDEX takosumi_service_graph_grants_binding_idx
        on "takosumi_service_graph_grants_retired" (binding_id);
CREATE INDEX takosumi_service_graph_grants_export_idx
        on "takosumi_service_graph_grants_retired" (service_export_id);
CREATE INDEX takosumi_service_graph_grants_consumer_idx
        on "takosumi_service_graph_grants_retired" (consumer_installation_id, status);
CREATE INDEX takosumi_observability_metrics_name_idx
         on takosumi_observability_metrics (name, observed_at);
CREATE INDEX takosumi_observability_metrics_space_idx
         on takosumi_observability_metrics (space_id, observed_at);
CREATE UNIQUE INDEX billing_auto_recharge_attempts_idempotency_unique
            on billing_auto_recharge_attempts (idempotency_key);
CREATE INDEX billing_auto_recharge_attempts_space_period_status_idx
            on billing_auto_recharge_attempts (space_id, period_start, status);
CREATE INDEX billing_auto_recharge_attempts_run_idx
            on billing_auto_recharge_attempts (run_id);
CREATE UNIQUE INDEX workspaces_handle_unique
      on workspaces (handle);
CREATE UNIQUE INDEX projects_workspace_slug_unique
      on projects (workspace_id, slug);
CREATE INDEX projects_workspace_idx
      on projects (workspace_id);
CREATE INDEX capsules_space_idx
      on capsules (space_id);
CREATE INDEX capsules_project_idx
      on capsules (project_id);
CREATE INDEX capsules_current_state_version_idx
      on capsules (current_state_version_id);
CREATE UNIQUE INDEX state_versions_installation_environment_generation_unique
      on state_versions (installation_id, environment, generation);
CREATE INDEX state_versions_installation_idx
      on state_versions (installation_id);
CREATE INDEX outputs_installation_idx
      on outputs (installation_id);
CREATE UNIQUE INDEX resource_shapes_space_kind_name_unique
      on resource_shapes (space_id, kind, name);
CREATE INDEX resource_shapes_space_idx
      on resource_shapes (space_id);
CREATE UNIQUE INDEX target_pools_space_name_unique
      on target_pools (space_id, name);
CREATE INDEX target_pools_space_idx
      on target_pools (space_id);
CREATE UNIQUE INDEX space_policies_space_name_unique
      on space_policies (space_id, name);
CREATE INDEX space_policies_space_idx
      on space_policies (space_id);
CREATE UNIQUE INDEX capsules_space_name_environment_active_unique
          on capsules (space_id, name, environment)
          where status != 'destroyed';
CREATE INDEX public_host_reservations_workspace_idx
           on public_host_reservations (workspace_id);
CREATE INDEX public_host_reservations_installation_idx
           on public_host_reservations (installation_id);
CREATE INDEX public_host_reservations_status_idx
           on public_host_reservations (status);
CREATE INDEX public_host_reservations_owner_kind_idx
           on public_host_reservations (owner_user_id, allocation_kind, status);
