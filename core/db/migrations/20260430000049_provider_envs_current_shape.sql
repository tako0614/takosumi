-- Migration: 20260430000049_provider_envs_current_shape
alter table takosumi_provider_catalog
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
  on takosumi_provider_env_binding_sets (installation_id);
