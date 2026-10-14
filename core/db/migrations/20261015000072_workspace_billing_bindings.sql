-- Migration: 20261015000072_workspace_billing_bindings
-- Additive protected-data migration; Postgres catalog v119, Control D1 v72.
-- Independent retained references: no Workspace/Account FK or cascade.
create table if not exists takosumi_workspace_billing_intents (
  workspace_id text primary key,
  intent_id text not null,
  billing_authority text not null,
  workspace_ref text not null,
  record_json jsonb not null,
  created_at text not null
);
create unique index if not exists takosumi_workspace_billing_intents_intent_unique on takosumi_workspace_billing_intents (intent_id);
create unique index if not exists takosumi_workspace_billing_intents_authority_ref_unique on takosumi_workspace_billing_intents (billing_authority, workspace_ref);
create table if not exists takosumi_workspace_billing_bindings (
  workspace_id text primary key,
  intent_id text not null,
  billing_authority text not null,
  workspace_ref text not null,
  organization_ref text not null,
  record_json jsonb not null,
  bound_at text not null
);
create unique index if not exists takosumi_workspace_billing_bindings_intent_unique on takosumi_workspace_billing_bindings (intent_id);
create unique index if not exists takosumi_workspace_billing_bindings_authority_ref_unique on takosumi_workspace_billing_bindings (billing_authority, workspace_ref);
create unique index if not exists takosumi_workspace_billing_bindings_authority_org_unique on takosumi_workspace_billing_bindings (billing_authority, organization_ref);
