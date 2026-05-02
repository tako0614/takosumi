-- Migration: 20260430000013_runtime_materialization_state
-- Purpose:   Create runtime desired/observed state tables referenced by the
--            runtime storage statement catalog.
-- Domain:    runtime

create table if not exists runtime_desired_states (
  id              text        primary key,
  space_id        text        not null,
  group_id        text        not null,
  activation_id   text        not null,
  state_json      jsonb       not null,
  materialized_at timestamptz not null
);
create index if not exists runtime_desired_states_group_idx
  on runtime_desired_states (space_id, group_id);
create index if not exists runtime_desired_states_activation_idx
  on runtime_desired_states (activation_id);

create table if not exists runtime_observed_states (
  id            text        primary key,
  space_id      text        not null,
  group_id      text        not null,
  snapshot_json jsonb       not null,
  observed_at   timestamptz not null
);
create index if not exists runtime_observed_states_group_idx
  on runtime_observed_states (space_id, group_id);
create index if not exists runtime_observed_states_observed_at_idx
  on runtime_observed_states (observed_at desc);

create table if not exists runtime_provider_observations (
  id                 text        primary key default md5(random()::text || clock_timestamp()::text),
  materialization_id text        not null,
  observation_json   jsonb       not null,
  observed_at        timestamptz not null
);
create index if not exists runtime_provider_observations_materialization_idx
  on runtime_provider_observations (materialization_id);
create index if not exists runtime_provider_observations_observed_at_idx
  on runtime_provider_observations (observed_at desc);
