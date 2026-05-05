-- Migration: 20260430000024_takosumi_revoke_debts
-- Purpose:   Persist RevokeDebt records created by WAL compensation and
--            post-commit cleanup paths. `source_key` makes enqueue idempotent
--            for a single generated object / WAL tuple.
--
-- Spec:      packages/kernel/src/domains/deploy/revoke_debt_store.ts
-- Phase:     public deploy recovery / RevokeDebt
-- Domain:    deploy

create table if not exists takosumi_revoke_debts (
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
  on takosumi_revoke_debts (created_at);
