/** Additive transfer ledger required before per-app mutation endpoints are enabled. */
export const D1_APP_OWNERSHIP_TRANSFER_SCHEMA = [
  `create table if not exists capsule_ownership_transfers (
    id text primary key,
    capsule_id text not null,
    from_account_id text not null,
    to_account_id text not null,
    ownership_epoch integer not null constraint capsule_ownership_transfers_epoch_check check (ownership_epoch >= 0),
    drain_management_epoch integer,
    state text not null constraint capsule_ownership_transfers_state_check check (state in ('pending','accepted','cancelled')),
    created_at text not null,
    updated_at text not null
  )`,
  `create unique index if not exists capsule_ownership_transfers_one_pending
    on capsule_ownership_transfers (capsule_id) where state = 'pending'`,
  `create index if not exists capsule_ownership_transfers_recipient
    on capsule_ownership_transfers (to_account_id, state)`,
] as const;

export const PG_APP_OWNERSHIP_TRANSFER_SCHEMA = `
create table if not exists takosumi_capsule_ownership_transfers (
  id text primary key,
  capsule_id text not null,
  from_account_id text not null,
  to_account_id text not null,
  ownership_epoch integer not null constraint takosumi_capsule_ownership_transfers_epoch_check check (ownership_epoch >= 0),
  drain_management_epoch integer,
  state text not null constraint takosumi_capsule_ownership_transfers_state_check check (state in ('pending','accepted','cancelled')),
  created_at text not null,
  updated_at text not null
);
create unique index if not exists takosumi_capsule_ownership_transfers_one_pending
  on takosumi_capsule_ownership_transfers (capsule_id) where state = 'pending';
create index if not exists takosumi_capsule_ownership_transfers_recipient
  on takosumi_capsule_ownership_transfers (to_account_id, state);
`;

/** Private issuance leases remain visible to drain even after a Run settles. */
export const D1_APP_CREDENTIAL_MINT_LEASE_SCHEMA = [
  `create table if not exists app_credential_mint_leases (
    id text primary key,
    capsule_id text not null,
    run_id text not null,
    owner_account_id text not null,
    ownership_epoch integer not null,
    management_epoch integer not null,
    actor_account_ids_json text not null,
    expires_at integer not null,
    created_at text not null
  )`,
  `create index if not exists app_credential_mint_leases_capsule_expiry
    on app_credential_mint_leases (capsule_id, expires_at)`,
] as const;

export const PG_APP_CREDENTIAL_MINT_LEASE_SCHEMA = `
create table if not exists takosumi_app_credential_mint_leases (
  id text primary key,
  capsule_id text not null,
  run_id text not null,
  owner_account_id text not null,
  ownership_epoch integer not null,
  management_epoch integer not null,
  actor_account_ids_json text not null,
  expires_at bigint not null,
  created_at text not null
);
create index if not exists takosumi_app_credential_mint_leases_capsule_expiry
  on takosumi_app_credential_mint_leases (capsule_id, expires_at);
`;
