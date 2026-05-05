-- Migration: 20260430000023_takosumi_operation_journal_entries
-- Purpose:   Persist public deploy OperationPlan WAL stage entries.
--            Each row is one stage record keyed by
--            (space_id, operation_plan_digest, journal_entry_id, stage).
--            Replays with the same tuple and effect_digest are idempotent;
--            the kernel rejects mismatching effect digests before advancing
--            a side-effecting stage.
--
-- Spec:      packages/kernel/src/domains/deploy/operation_journal.ts
-- Phase:     public deploy OperationPlan WAL
-- Domain:    deploy

create table if not exists takosumi_operation_journal_entries (
  id                    text        primary key,
  space_id              text        not null,
  deployment_name       text,
  operation_plan_digest text        not null,
  journal_entry_id      text        not null,
  operation_id          text        not null,
  phase                 text        not null
    check (phase in ('apply','activate','destroy','rollback','recovery','observe')),
  stage                 text        not null
    check (stage in ('prepare','pre-commit','commit','post-commit','observe','finalize','abort','skip')),
  operation_kind        text        not null,
  resource_name         text,
  provider_id           text,
  effect_digest         text        not null,
  effect_json           jsonb       not null,
  status                text        not null
    check (status in ('recorded','succeeded','failed','skipped')),
  created_at            timestamptz not null default now(),
  unique (space_id, operation_plan_digest, journal_entry_id, stage)
);

create index if not exists takosumi_operation_journal_entries_plan_idx
  on takosumi_operation_journal_entries (space_id, operation_plan_digest);
create index if not exists takosumi_operation_journal_entries_deployment_idx
  on takosumi_operation_journal_entries (space_id, deployment_name);
create index if not exists takosumi_operation_journal_entries_created_at_idx
  on takosumi_operation_journal_entries (created_at);
