-- Migration: 20261016000073_identity_reconciliation
-- Additive protected-data migration; Postgres catalog v120, Control D1 v73.
-- Retained operation custody and events have no Workspace/Account FK or cascade.
create table if not exists takosumi_identity_reconciliation_operations (
  operation_id text primary key,
  kind text not null,
  immutable_key text not null,
  revision integer not null,
  status text not null,
  mutation_id text not null,
  record_json jsonb not null,
  created_at text not null,
  updated_at text not null
);
create unique index if not exists takosumi_identity_reconciliation_operations_mutation_unique on takosumi_identity_reconciliation_operations (mutation_id);
create table if not exists takosumi_identity_reconciliation_events (
  operation_id text not null,
  revision integer not null,
  mutation_id text not null,
  record_json jsonb not null,
  recorded_at text not null,
  primary key (operation_id, revision)
);
create unique index if not exists takosumi_identity_reconciliation_events_mutation_unique on takosumi_identity_reconciliation_events (mutation_id);
