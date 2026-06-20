-- Migration: 20260430000051_postgres_named_index_parity
alter table takosumi_spaces
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
  on takosumi_usage_events (idempotency_key);
