/**
 * Existing Git install-plan blocker predicates shared by quiescence observers
 * and future Workspace management commands.  The surrounding query supplies
 * the Workspace filter and dialect-specific parameter placeholder.
 *
 * `awaiting_input` is an idle attempt waiting for its actor: it holds no
 * lease and no execution authority, and every advance out of it re-checks the
 * original active admission in the same write, so a drain makes it inert
 * rather than racing it. It blocks only while a lease column is set.
 * `discarded` is terminal like `failed`.
 *
 * An unleased install attempt past its `expiresAt` in a pre-Capsule
 * coordinator phase can never advance either (reconcile refuses it and any
 * claim re-checks the original admission), so it stops blocking instead of
 * waiting for its creator's discard. Timestamps are ISO-8601 UTC strings
 * compared against the database clock; a leased or inconsistent row, or one
 * missing its mode or expiry (null-safe `coalesce`), always blocks.
 */
export const PG_GIT_INSTALL_PLAN_MANAGEMENT_BLOCKER_SQL = `
  (
    reconcile_lease_token is not null
    or reconcile_lease_expires_at is not null
    or jsonb_typeof(record_json -> 'workspaceId') is distinct from 'string'
    or record_json ->> 'workspaceId' is distinct from workspace_id
    or jsonb_typeof(record_json -> 'phase') is distinct from 'string'
    or record_json ->> 'phase' is distinct from phase
    or jsonb_typeof(record_json -> 'generation') is distinct from 'number'
    or record_json ->> 'generation' is distinct from generation::text
    or (
      (phase is null
        or phase not in ('failed', 'reviewable', 'discarded', 'awaiting_input'))
      and not (
        phase is not null
        and phase in ('syncing_source', 'compiling_install', 'analyzing_compatibility')
        and coalesce(
          record_json ->> 'mode' = 'attempt'
          and jsonb_typeof(record_json -> 'expiresAt') = 'string'
          and record_json ->> 'expiresAt'
            <= to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          false
        )
      )
    )
  )
`;

export const SQLITE_GIT_INSTALL_PLAN_MANAGEMENT_BLOCKER_SQL = `
  (
    reconcile_lease_token is not null
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
    or (
      (phase is null
        or phase not in ('failed', 'reviewable', 'discarded', 'awaiting_input'))
      and not (
        phase is not null
        and phase in ('syncing_source', 'compiling_install', 'analyzing_compatibility')
        and case when json_valid(record_json) = 1 then
            case when
              json_extract(record_json, '$.mode') is 'attempt'
              and json_type(record_json, '$.expiresAt') is 'text'
              and json_extract(record_json, '$.expiresAt')
                <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            then 1 else 0 end
          else 0 end = 1
      )
    )
  )
`;
