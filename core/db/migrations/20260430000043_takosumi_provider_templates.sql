-- Migration: 20260430000043_takosumi_provider_templates
create table if not exists takosumi_provider_templates_entries (
  id               text    primary key,
  provider_source  text    not null unique,
  primary_credential_source     text    not null
    check (primary_credential_source in ('takosumi_managed','user_env_set','user_env_set','user_env_set')),
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

create table if not exists takosumi_provider_env_sets (
  id               text  primary key,
  space_id         text  not null,
  provider_pack_id text  not null,
  provider_source  text  not null,
  selected_version text  not null,
  pin_json         jsonb not null,
  created_at       text  not null
);
create index if not exists takosumi_provider_env_sets_space_idx
  on takosumi_provider_env_sets (space_id);
create index if not exists takosumi_provider_env_sets_pack_idx
  on takosumi_provider_env_sets (provider_pack_id);
create index if not exists takosumi_provider_env_sets_provider_source_idx
  on takosumi_provider_env_sets (provider_source);
