-- Migration: 20260430000017_group_head_history
-- Purpose:   Retain N generations of group_head pointer history so
--            multi-generation rollback (`rollbackGroup --steps=N` or
--            `rollbackGroup --target=<deployment_id>` resolved against the
--            history) can address any prior applied Deployment, not just the
--            single `previous_deployment_id` slot tracked on `group_heads`.
--
-- Phase:     18.3 (M6)
-- Domain:    deploy / group-head retention
--
-- Background. `group_heads.previous_deployment_id` only ever holds ONE
-- generation: when GroupHead advances from D2 -> D3, D2 becomes the previous
-- and D1 is forgotten. Consequently rollback-to-N can only target the
-- immediately previous head; a deploy that turned out to be bad two
-- generations later is unreachable through `rollbackGroup`. Phase 18.3 / M6
-- introduces a per-(space, group) append-only history of head advances so the
-- caller can either (a) name a target Deployment id directly (the existing
-- behaviour, but now validated against the retained history) or (b) ask for
-- the head N steps back.
--
-- Schema notes.
--   * Append-only. Each successful `advanceGroupHead` or
--     `commitAppliedDeployment` writes one row capturing the new head's
--     deployment id, the rollover timestamp, and a per-(space, group)
--     monotonic `sequence`. The `sequence` doubles as the GroupHead
--     `generation`, so callers can correlate history rows with the
--     point-in-time GroupHead snapshot.
--   * The (space_id, group_id, deployment_id) tuple is intentionally NOT
--     unique — a Deployment can legitimately become the head more than once
--     (deploy D1 -> deploy D2 -> rollback to D1 -> deploy D3 -> rollback to
--     D1 again). The history entry for the second rollback to D1 is a
--     distinct row so `--steps=N` semantics stay meaningful.
--   * `previous_deployment_id` mirrors the value computed by
--     `advanceGroupHead` at the time of the rollover. It is redundant with
--     the prior row's `deployment_id` but materialised here so a single
--     SELECT can return the full prior link without a self-join.
--
-- Lookup paths.
--   * Resolve `rollback --steps=N`: SELECT WHERE space_id, group_id ORDER BY
--     sequence DESC LIMIT 1 OFFSET N (skip current head, take the Nth prior).
--   * Resolve `rollback --target=D`: SELECT WHERE space_id, group_id AND
--     deployment_id = D ORDER BY sequence DESC LIMIT 1 (the most recent time
--     D was the head, so a chained rollback resolves to the most recent
--     incarnation rather than its first appearance).
--   * Audit a group's full advance history: SELECT WHERE space_id, group_id
--     ORDER BY sequence ASC.

-- ---------------------------------------------------------------------------
-- 1. History table.
-- ---------------------------------------------------------------------------

create table if not exists group_head_history (
  space_id                  text        not null,
  group_id                  text        not null,
  deployment_id             text        not null references deployments(id),
  previous_deployment_id    text        references deployments(id),
  sequence                  bigint      not null,
  advanced_at               timestamptz not null default now(),
  primary key (space_id, group_id, sequence)
);

-- DESC index: every M6 rollback resolution path orders by `sequence` desc
-- (newest first) and either takes the Nth offset or filters by deployment id.
-- A descending index avoids a sort step in both cases.
create index if not exists group_head_history_recent_idx
  on group_head_history (space_id, group_id, sequence desc);

-- Equality-by-deployment lookup for `--target=<deployment_id>` resolution.
create index if not exists group_head_history_deployment_idx
  on group_head_history (space_id, group_id, deployment_id);

-- ---------------------------------------------------------------------------
-- 2. Backfill from the current group_heads pointers.
--
-- Every existing GroupHead row corresponds to one `advanced_at` moment we
-- still have evidence for: the row's own `current_deployment_id` at its
-- recorded `advanced_at`, plus (when present) the `previous_deployment_id`.
-- Older history was never persisted and is unrecoverable; the backfill is
-- best-effort: it seeds the two most recent generations so a freshly
-- migrated group can still rollback ONE step (matching pre-M6 behaviour) and
-- subsequent advances/rollbacks add new history rows from there.
--
-- Sequence numbers are assigned so the current head sits at
-- `group_heads.generation` (matching the in-memory store's invariant) and
-- the previous (if any) sits at `group_heads.generation - 1`.
-- ---------------------------------------------------------------------------

-- Seed the previous head, if known. Use coalesce to make the insert idempotent
-- when the migration is re-run against a partially populated history table.
insert into group_head_history (
  space_id, group_id, deployment_id, previous_deployment_id,
  sequence, advanced_at
)
select
  gh.space_id,
  gh.group_id,
  gh.previous_deployment_id,
  null,
  greatest(gh.generation - 1, 1) as sequence,
  gh.advanced_at
from group_heads gh
where gh.previous_deployment_id is not null
  and not exists (
    select 1 from group_head_history h
    where h.space_id = gh.space_id
      and h.group_id = gh.group_id
      and h.sequence = greatest(gh.generation - 1, 1)
  );

-- Seed the current head.
insert into group_head_history (
  space_id, group_id, deployment_id, previous_deployment_id,
  sequence, advanced_at
)
select
  gh.space_id,
  gh.group_id,
  gh.current_deployment_id,
  gh.previous_deployment_id,
  gh.generation as sequence,
  gh.advanced_at
from group_heads gh
where not exists (
  select 1 from group_head_history h
  where h.space_id = gh.space_id
    and h.group_id = gh.group_id
    and h.sequence = gh.generation
);
