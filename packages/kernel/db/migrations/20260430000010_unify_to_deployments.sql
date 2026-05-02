-- Migration: 20260430000010_unify_to_deployments
-- Purpose:   Collapse source deploy_plans / deploy_activation_records /
--            deploy_operation_records / deploy_group_activation_pointers
--            (and the structural side of resource_binding_set_revisions)
--            into the current Deployment schema:
--              - deployments
--              - provider_observations
--              - group_heads
--
-- Spec:      /docs/takos-paas/core/01-core-contract-v1.0.md
-- Phase:     deployment schema rewrite
-- Domain:    deploy

-- ---------------------------------------------------------------------------
-- 1. Create new tables.
-- ---------------------------------------------------------------------------

create table if not exists deployments (
  id                       text        primary key,
  group_id                 text        not null,
  space_id                 text        not null,
  input_json               jsonb       not null,
  resolution_json          jsonb       not null,
  desired_json             jsonb       not null,
  status                   text        not null
    check (status in ('preview','resolved','applying','applied','failed','rolled-back')),
  conditions_json          jsonb       not null default '[]'::jsonb,
  policy_decisions_json    jsonb       not null default '[]'::jsonb,
  approval_json            jsonb,
  rollback_target          text        references deployments(id),
  created_at               timestamptz not null default now(),
  applied_at               timestamptz,
  finalized_at             timestamptz
);
create index if not exists deployments_group_created_idx
  on deployments (group_id, created_at desc);
create index if not exists deployments_status_idx
  on deployments (status);
create index if not exists deployments_space_idx
  on deployments (space_id);

create table if not exists provider_observations (
  id                  text        primary key,
  deployment_id       text        not null references deployments(id),
  provider_id         text        not null,
  object_address      text        not null,
  observed_state      text        not null
    check (observed_state in ('present','missing','drifted','unknown')),
  drift_status        text,
  observed_digest     text,
  observed_state_json jsonb       not null default '{}'::jsonb,
  observed_at         timestamptz not null
);
create index if not exists provider_observations_deployment_idx
  on provider_observations (deployment_id);
create index if not exists provider_observations_observed_at_idx
  on provider_observations (observed_at desc);

create table if not exists group_heads (
  space_id                  text        not null,
  group_id                  text        not null,
  current_deployment_id     text        not null references deployments(id),
  previous_deployment_id    text        references deployments(id),
  generation                bigint      not null default 1,
  advanced_at               timestamptz not null default now(),
  primary key (space_id, group_id)
);
create index if not exists group_heads_current_idx
  on group_heads (current_deployment_id);

-- ---------------------------------------------------------------------------
-- 2. Migrate existing rows.
--
-- Source join key: deploy_plans.id <-> deploy_activation_records.plan_id.
-- One Deployment row per (plan, activation_record) pair. Plans without an
-- activation record collapse to status='resolved' or 'failed'. Activations
-- without a referenced plan are unexpected; if they exist they collapse to
-- status='applied' using the activation snapshot's stored core spec.
--
-- ---------------------------------------------------------------------------
-- ID MAPPING SPEC (source -> current, deterministic & rollback-safe)
-- ---------------------------------------------------------------------------
--   Rule 1 (preferred): when a plan has at least one activation_record, the
--                       Deployment retains the activation_record.id.
--                         deployments.id := deploy_activation_records.id
--                       This preserves the id that any retained `rollback_json
--                       -> targetActivationId` references, so source-recorded
--                       rollback targets resolve directly against current rows
--                       without a translation table.
--   Rule 2 (fallback):  plans with no activation_record (status preview /
--                       resolved / failed at plan time) retain the plan id.
--                         deployments.id := deploy_plans.id
--                       The plan id namespace was disjoint from
--                       activation_record id namespace (different prefix
--                       generators), so collisions are not expected.
--   Rule 3 (orphan):    activation_records whose plan was already pruned
--                       retain activation_record.id (Rule 1 still applies).
--   Rule 4 (group head): group_heads.current_deployment_id is taken from the
--                       source deploy_group_activation_pointers.activation_id,
--                       which Rule 1 guarantees survives as the current id.
--   Rule 5 (previous):  group_heads.previous_deployment_id is computed by
--                       selecting the most recent prior applied (or
--                       rolled-back) Deployment for the same group_id whose id
--                       is not the current head. This makes
--                       rollback-to-previous-deployment work against current rows
--                       using the source-derived history.
--   Rule 6 (operations): deploy_operation_records collapse into the parent
--                       Deployment via coalesce(activation_id, plan_id). The
--                       operation row's own id is preserved inside
--                       conditions[].scope.ref so audit traces survive.
--   Rule 7 (rollback):  when source rollback_json names a targetActivationId, that
--                       value is preserved verbatim in the current schema
--                       deployments.rollback_target. Rule 1 ensures the target
--                       still exists.
-- ---------------------------------------------------------------------------

-- 2a. Plans + activation records  ->  deployments
insert into deployments (
  id, group_id, space_id,
  input_json, resolution_json, desired_json,
  status, conditions_json, policy_decisions_json, approval_json,
  rollback_target, created_at, applied_at, finalized_at
)
select
  coalesce(ar.id, p.id) as id,
  p.group_id,
  p.space_id,
  jsonb_build_object(
    'manifest_snapshot', coalesce(ar.manifest_json, p.plan_json -> 'manifest', '{}'::jsonb),
    'source_kind',       coalesce(ar.source_json ->> 'kind', 'manifest'),
    'source_ref',        ar.source_json ->> 'ref'
  ) as input_json,
  jsonb_build_object(
    'descriptor_closure', coalesce(ar.descriptor_closure_json, p.plan_json -> 'descriptorClosure', '{}'::jsonb),
    'resolved_graph',     coalesce(ar.resolved_graph_json,    p.plan_json -> 'resolvedGraph',     '{}'::jsonb)
  ) as resolution_json,
  coalesce(ar.core_activation_json, '{}'::jsonb) as desired_json,
  case
    when ar.id is not null and ar.status in ('succeeded','applied') then 'applied'
    when ar.id is not null and ar.status in ('running','queued')    then 'applying'
    when ar.id is not null and ar.status = 'failed'                  then 'failed'
    when ar.id is not null and ar.status = 'cancelled'               then 'failed'
    when ar.id is null then 'resolved'
    else 'resolved'
  end as status,
  coalesce(p.plan_json -> 'conditions', '[]'::jsonb)             as conditions_json,
  coalesce(p.plan_json -> 'policyDecisions', '[]'::jsonb)        as policy_decisions_json,
  ar.rollback_json                                               as approval_json,
  case
    when ar.rollback_json -> 'targetActivationId' is not null
      then ar.rollback_json ->> 'targetActivationId'
    else null
  end as rollback_target,
  coalesce(ar.created_at, p.created_at)                          as created_at,
  case when ar.id is not null then ar.created_at else null end   as applied_at,
  case
    when ar.id is not null and ar.status in ('succeeded','applied')
      then ar.created_at
    else null
  end as finalized_at
from deploy_plans p
left join deploy_activation_records ar on ar.plan_id = p.id
on conflict (id) do nothing;

-- 2b. Orphan activation records (no plan join) — uncommon in practice but
--     preserved as 'applied' Deployments using the activation snapshot.
insert into deployments (
  id, group_id, space_id,
  input_json, resolution_json, desired_json,
  status, conditions_json, policy_decisions_json, approval_json,
  rollback_target, created_at, applied_at, finalized_at
)
select
  ar.id,
  ar.group_id,
  ar.space_id,
  jsonb_build_object(
    'manifest_snapshot', coalesce(ar.manifest_json, '{}'::jsonb),
    'source_kind',       coalesce(ar.source_json ->> 'kind', 'manifest'),
    'source_ref',        ar.source_json ->> 'ref'
  ),
  jsonb_build_object(
    'descriptor_closure', coalesce(ar.descriptor_closure_json, '{}'::jsonb),
    'resolved_graph',     coalesce(ar.resolved_graph_json,     '{}'::jsonb)
  ),
  coalesce(ar.core_activation_json, '{}'::jsonb),
  case
    when ar.status in ('succeeded','applied') then 'applied'
    when ar.status in ('running','queued')    then 'applying'
    when ar.status = 'failed'                  then 'failed'
    else 'applied'
  end,
  '[]'::jsonb,
  '[]'::jsonb,
  ar.rollback_json,
  ar.rollback_json ->> 'targetActivationId',
  ar.created_at,
  ar.created_at,
  case when ar.status in ('succeeded','applied') then ar.created_at else null end
from deploy_activation_records ar
where not exists (select 1 from deployments d where d.id = ar.id)
on conflict (id) do nothing;

-- 2c. Fold deploy_operation_records  ->  deployments.conditions[]
--     One condition entry per operation row, with scope.kind='operation'.
update deployments d
set conditions_json = coalesce(d.conditions_json, '[]'::jsonb) || op_arr.entries
from (
  select
    coalesce(o.activation_id, o.plan_id) as deployment_id,
    jsonb_agg(
      jsonb_build_object(
        'type',                   concat('Operation:', o.kind),
        'status',                 case
                                    when o.status in ('succeeded','applied') then 'true'
                                    when o.status = 'failed'                  then 'false'
                                    else 'unknown'
                                  end,
        'reason',                 o.error,
        'message',                o.error,
        'observed_generation',    1,
        'last_transition_time',   o.updated_at,
        'scope',                  jsonb_build_object('kind','operation','ref', o.id)
      )
      order by o.created_at
    ) as entries
  from deploy_operation_records o
  where coalesce(o.activation_id, o.plan_id) is not null
  group by coalesce(o.activation_id, o.plan_id)
) op_arr
where op_arr.deployment_id is not null
  and op_arr.deployment_id = d.id;

-- 2d. Fold resource_binding_set_revisions structural side
--     ->  deployments.desired.bindings (replace if present).
update deployments d
set desired_json = jsonb_set(
  coalesce(d.desired_json, '{}'::jsonb),
  '{bindings}',
  br.merged_inputs,
  true
)
from (
  select
    activation_record_id as deployment_id,
    jsonb_agg(coalesce(inputs_json, '[]'::jsonb)) as merged_inputs
  from resource_binding_set_revisions
  where activation_record_id is not null
  group by activation_record_id
) br
where br.deployment_id is not null
  and br.deployment_id = d.id;

-- 2e. Pointers  ->  group_heads
--
-- group_heads.previous_deployment_id is filled in by selecting the most
-- recently applied (or rolled-back) Deployment for the same group_id whose id
-- is *not* the current head. Rule 5 of the ID MAPPING SPEC above guarantees
-- this 1:1 lookup matches the source generation that owned the previous activation
-- record, so current rollback can locate the previous_deployment without a
-- translation table.
insert into group_heads (
  space_id, group_id, current_deployment_id, previous_deployment_id, generation, advanced_at
)
select
  p.space_id,
  p.group_id,
  p.activation_id        as current_deployment_id,
  (
    select prev.id
      from deployments prev
      where prev.space_id = p.space_id
        and prev.group_id = p.group_id
        and prev.id <> p.activation_id
        and prev.status in ('applied', 'rolled-back')
      order by coalesce(prev.applied_at, prev.created_at) desc, prev.id desc
      limit 1
  )                       as previous_deployment_id,
  1                      as generation,
  p.advanced_at
from deploy_group_activation_pointers p
where exists (select 1 from deployments d where d.id = p.activation_id)
on conflict (space_id, group_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Drop source tables. Order: child references first, parents last.
-- ---------------------------------------------------------------------------

drop table if exists deploy_operation_records;
drop table if exists deploy_group_activation_pointers;
drop table if exists deploy_activation_records;
drop table if exists deploy_plans;

-- The structural side of resource_binding_set_revisions is now inlined into
-- `deployments.desired.bindings`. Drop the structural columns; keep the table
-- for the value-resolution side (latest-at-activation resolution audit trail)
-- which Core retains as a per-binding ResolutionRecord lookup.
alter table resource_binding_set_revisions
  drop column if exists activation_record_id,
  drop column if exists resource_binding_ids_json,
  drop column if exists secret_bindings_json,
  drop column if exists publication_bindings_json,
  drop column if exists component_address,
  drop column if exists structure_digest,
  drop column if exists inputs_json,
  drop column if exists conditions_json;
-- (binding_value_resolutions_json column is kept; it remains the canonical
-- per-binding resolution audit trail referenced by Deployment.desired.bindings.)
