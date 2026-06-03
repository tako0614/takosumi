-- Migration: 20260430000022_takosumi_deployment_record_locks
-- Purpose:   Cross-process lease locks for deployment record updates.
--            Each operation holds one lock per `(tenant_id, name)` while it
--            updates cleanup evidence and renews `locked_until` until the
--            operation exits. If the service process dies, a later caller can take
--            the lock after the lease expires.
--
-- Spec:      src/service/domains/deploy-records/deployment_record_store_sql.ts
-- Phase:     takosumi deployment record cross-process lock
-- Domain:    deploy

create table if not exists takosumi_deployment_record_locks (
  tenant_id    text        not null,
  name         text        not null,
  owner_token  text        not null,
  locked_until timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, name)
);

create index if not exists takosumi_deployment_record_locks_locked_until_idx
  on takosumi_deployment_record_locks (locked_until);
