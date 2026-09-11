/**
 * Existing Git install-plan blocker predicates shared by quiescence observers
 * and future Workspace management commands.  The surrounding query supplies
 * the Workspace filter and dialect-specific parameter placeholder.
 */
export const PG_GIT_INSTALL_PLAN_MANAGEMENT_BLOCKER_SQL = `
  (
    phase is null
    or phase not in ('failed', 'reviewable')
    or reconcile_lease_token is not null
    or reconcile_lease_expires_at is not null
    or jsonb_typeof(record_json -> 'workspaceId') is distinct from 'string'
    or record_json ->> 'workspaceId' is distinct from workspace_id
    or jsonb_typeof(record_json -> 'phase') is distinct from 'string'
    or record_json ->> 'phase' is distinct from phase
    or jsonb_typeof(record_json -> 'generation') is distinct from 'number'
    or record_json ->> 'generation' is distinct from generation::text
  )
`;

export const SQLITE_GIT_INSTALL_PLAN_MANAGEMENT_BLOCKER_SQL = `
  (
    phase is null
    or phase not in ('failed', 'reviewable')
    or reconcile_lease_token is not null
    or reconcile_lease_expires_at is not null
    or case when json_valid(record_json) = 1 then
        case when
          json_type(record_json, '$.workspaceId') = 'text'
          and json_extract(record_json, '$.workspaceId') is workspace_id
          and json_type(record_json, '$.phase') = 'text'
          and json_extract(record_json, '$.phase') is phase
          and json_type(record_json, '$.generation') = 'integer'
          and json_extract(record_json, '$.generation') is generation
        then 0 else 1 end
      else 1 end = 1
  )
`;
