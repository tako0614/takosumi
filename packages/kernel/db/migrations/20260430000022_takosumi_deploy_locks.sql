-- Migration: 20260430000022_takosumi_deploy_locks
-- Purpose:   Cross-process lease locks for the public deploy route.
--            `POST /v1/deployments` holds one lock per `(tenant_id, name)`
--            while it runs apply / destroy and renews `locked_until` until
--            the operation exits. If the kernel pod dies, a later caller can
--            take the lock after the lease expires.
--
-- Spec:      packages/kernel/src/domains/deploy/takosumi_deployment_record_store_sql.ts
-- Phase:     takosumi public deploy cross-process lock
-- Domain:    deploy

create table if not exists takosumi_deploy_locks (
  tenant_id    text        not null,
  name         text        not null,
  owner_token  text        not null,
  locked_until timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, name)
);

create index if not exists takosumi_deploy_locks_locked_until_idx
  on takosumi_deploy_locks (locked_until);
