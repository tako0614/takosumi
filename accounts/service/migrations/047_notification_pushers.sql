-- Takosumi Mobile pushers: devices that receive this instance's own
-- notifications as standard Web Push through a push relay. Additive: a new
-- table only; no existing row or reader changes.
CREATE TABLE IF NOT EXISTS accounts_v1.notification_pushers (
  pusher_id text PRIMARY KEY,
  subject text NOT NULL REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT notification_pushers_kind_catalog_v1 CHECK (
    kind IN ('webpush')
  ),
  app_id text NOT NULL,
  pushkey text NOT NULL,
  endpoint text NOT NULL,
  auth text NOT NULL,
  device_display_name text NOT NULL,
  lang text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_status integer,
  CONSTRAINT notification_pushers_identity_v1 UNIQUE (subject, app_id, pushkey)
);
