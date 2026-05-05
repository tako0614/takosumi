-- Migration: 20260430000021_takosumi_deploy_idempotency_keys
create table if not exists takosumi_deploy_idempotency_keys (
  id                 text        primary key,
  tenant_id          text        not null,
  idempotency_key    text        not null,
  request_digest     text        not null,
  response_status    integer     not null,
  response_body_json jsonb       not null,
  created_at         timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index if not exists takosumi_deploy_idempotency_keys_tenant_idx
  on takosumi_deploy_idempotency_keys (tenant_id);
create index if not exists takosumi_deploy_idempotency_keys_created_at_idx
  on takosumi_deploy_idempotency_keys (created_at);
