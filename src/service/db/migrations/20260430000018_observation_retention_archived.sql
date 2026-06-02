-- Migration: 20260430000018_observation_retention_archived
-- Purpose:   Add archived flag to provider_observations and
--            runtime_provider_observations to support the Phase 18.3
--            observation retention GC (30d recent / 90d archived cap).
-- Domain:    deploy / runtime

alter table provider_observations
  add column if not exists archived boolean not null default false;
create index if not exists provider_observations_archived_idx
  on provider_observations (archived);

alter table runtime_provider_observations
  add column if not exists archived boolean not null default false;
create index if not exists runtime_provider_observations_archived_idx
  on runtime_provider_observations (archived);
