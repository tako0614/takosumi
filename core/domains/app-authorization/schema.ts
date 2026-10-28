/** Additive transfer ledger required before per-app mutation endpoints are enabled. */
export const D1_APP_OWNERSHIP_TRANSFER_SCHEMA = [
  `create table if not exists capsule_ownership_transfers (
    id text primary key,
    capsule_id text not null,
    from_account_id text not null,
    to_account_id text not null,
    ownership_epoch integer not null check (ownership_epoch >= 0),
    drain_management_epoch integer,
    state text not null check (state in ('pending','accepted','cancelled')),
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
  ownership_epoch integer not null check (ownership_epoch >= 0),
  drain_management_epoch integer,
  state text not null check (state in ('pending','accepted','cancelled')),
  created_at text not null,
  updated_at text not null
);
create unique index if not exists takosumi_capsule_ownership_transfers_one_pending
  on takosumi_capsule_ownership_transfers (capsule_id) where state = 'pending';
create index if not exists takosumi_capsule_ownership_transfers_recipient
  on takosumi_capsule_ownership_transfers (to_account_id, state);
`;
