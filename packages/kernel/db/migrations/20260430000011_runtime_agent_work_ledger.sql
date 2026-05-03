-- Migration: 20260430000011_runtime_agent_work_ledger
-- Purpose:   Persist Takos runtime agent registry + work-item ledger so the
--            kernel can resume in-flight long-running operations after a
--            restart (Phase 18 / C5). The in-memory registry hydrates from
--            this ledger on boot; stale leases (whose `lease_expires_at` has
--            elapsed) are reset to `queued` so a fresh agent lease can pick
--            them up without duplicating side-effects.
--
--            Also forms the durable backing for the C4 host-key impersonation
--            guard: when an enrollment under an existing `agentId` arrives
--            with a different `host_key_digest`, the registry revokes the
--            agent — which requeues every leased work_item this ledger holds
--            for that agent — so a forged operator can never strand work in
--            `leased` state.
--
-- Spec:      /docs/takosumi/core/01-core-contract-v1.0.md  (§ 13-15, § 18)
-- Phase:     18 (C4 host-key impersonation guard + C5 lease resumability)
-- Domain:    runtime

create table if not exists runtime_agents (
  id                  text        primary key,
  provider            text        not null,
  endpoint            text,
  capabilities_json   jsonb       not null default '{}'::jsonb,
  status              text        not null
    check (status in ('registered','ready','draining','revoked','expired')),
  registered_at       timestamptz not null,
  last_heartbeat_at   timestamptz not null,
  drain_requested_at  timestamptz,
  revoked_at          timestamptz,
  expired_at          timestamptz,
  host_key_digest     text,
  metadata_json       jsonb       not null default '{}'::jsonb
);
create index if not exists runtime_agents_status_idx
  on runtime_agents (status);
create index if not exists runtime_agents_last_heartbeat_idx
  on runtime_agents (last_heartbeat_at);

create table if not exists runtime_agent_work_items (
  id                  text        primary key,
  agent_id            text        references runtime_agents(id),
  kind                text        not null,
  status              text        not null
    check (status in ('queued','leased','completed','failed','cancelled')),
  operation_id        text,
  provider            text,
  priority            integer     not null default 0,
  payload_json        jsonb       not null default '{}'::jsonb,
  metadata_json       jsonb       not null default '{}'::jsonb,
  queued_at           timestamptz not null,
  leased_at           timestamptz,
  lease_id            text,
  lease_expires_at    timestamptz,
  completed_at        timestamptz,
  failed_at           timestamptz,
  failure_reason      text,
  attempts            integer     not null default 0,
  idempotency_key     text,
  last_progress_json  jsonb,
  last_progress_at    timestamptz,
  result_json         jsonb
);
create unique index if not exists runtime_agent_work_items_idempotency_key_idx
  on runtime_agent_work_items (idempotency_key)
  where idempotency_key is not null and status in ('queued','leased');
create index if not exists runtime_agent_work_items_status_idx
  on runtime_agent_work_items (status);
create index if not exists runtime_agent_work_items_agent_idx
  on runtime_agent_work_items (agent_id);
create index if not exists runtime_agent_work_items_lease_expires_idx
  on runtime_agent_work_items (lease_expires_at);
create index if not exists runtime_agent_work_items_operation_idx
  on runtime_agent_work_items (operation_id);
