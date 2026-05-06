-- Migration: 20260430000026_takosumi_deploy_idempotency_locks
-- Purpose:   Cross-process lease locks for public deploy idempotency keys.
--            `POST /v1/deployments` holds one lock per
--            `(tenant_id, idempotency_key)` while it checks and persists
--            the first response. If the kernel pod dies, a later caller can
--            take the lock after the lease expires.
--
-- Spec:      packages/kernel/src/domains/deploy/deploy_public_idempotency_store_sql.ts
-- Phase:     takosumi public deploy idempotency cross-process lock
-- Domain:    deploy

create table if not exists takosumi_deploy_idempotency_locks (
  tenant_id       text        not null,
  idempotency_key text        not null,
  owner_token     text        not null,
  locked_until    timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);

create index if not exists takosumi_deploy_idempotency_locks_locked_until_idx
  on takosumi_deploy_idempotency_locks (locked_until);
