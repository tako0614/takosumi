export const D1_PORTABLE_HOST_IDEMPOTENCY_SCHEMA_STATEMENTS = [
  `create table if not exists portable_host_idempotency (
    workspace_id text not null,
    actor_account_id text not null,
    space text not null,
    idempotency_key text not null,
    state text not null check (state in ('reserved', 'succeeded')),
    reservation_id text not null,
    fingerprint_json text not null,
    response_json text,
    primary key (
      workspace_id,
      actor_account_id,
      space,
      idempotency_key
    ),
    check (
      (state = 'reserved' and response_json is null) or
      (state = 'succeeded' and response_json is not null)
    )
  )`,
] as const;
