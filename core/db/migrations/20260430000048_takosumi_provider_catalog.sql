-- Migration: 20260430000048_takosumi_provider_catalog
create table if not exists takosumi_provider_catalog (
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
drop table if exists takosumi_provider_templates;
