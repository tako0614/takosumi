-- Migration: 20260430000012_audit_hash_chain_and_retention
-- Purpose:   Add tamper-evident hash-chain fields and archived retention
--            state to immutable audit events.
--
-- Phase:     18 (audit hash chain + retention)
-- Domain:    audit

alter table audit_events add column if not exists sequence bigint;
alter table audit_events add column if not exists previous_hash text;
alter table audit_events add column if not exists current_hash text;
alter table audit_events add column if not exists archived boolean not null default false;

create unique index if not exists audit_events_sequence_idx
  on audit_events (sequence);
create index if not exists audit_events_archived_idx
  on audit_events (archived);
create index if not exists audit_events_occurred_at_idx
  on audit_events (occurred_at);
