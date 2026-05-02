-- Migration: 20260430000014_usage_aggregates
-- Purpose:   Create usage aggregate projection table referenced by the usage
--            storage statement catalog.
-- Domain:    usage

create table if not exists usage_aggregates (
  id                 text        primary key,
  space_id           text        not null,
  group_id           text,
  owner_kind         text        not null,
  metric             text        not null,
  unit               text        not null,
  quantity           numeric     not null,
  event_count        integer     not null,
  first_occurred_at  timestamptz not null,
  last_occurred_at   timestamptz not null,
  updated_at         timestamptz not null
);
create index if not exists usage_aggregates_space_idx
  on usage_aggregates (space_id);
create index if not exists usage_aggregates_group_idx
  on usage_aggregates (group_id);
create index if not exists usage_aggregates_owner_metric_idx
  on usage_aggregates (owner_kind, metric);
