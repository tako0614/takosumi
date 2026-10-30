-- The notification dispatcher's state: its position in the Activity ledger
-- (same shape as takosumi_scheduled_sweep_cursors: lane, generation,
-- cursor_created_at, cursor_id) and one delivery row per (event, pusher).
-- Additive: new tables only.
CREATE TABLE IF NOT EXISTS accounts_v1.notification_dispatch_cursors (
  lane text PRIMARY KEY CONSTRAINT notification_dispatch_cursors_lane_catalog_v1 CHECK (
    lane IN ('activity')
  ),
  generation bigint NOT NULL CHECK (generation >= 0),
  cursor_created_at text NOT NULL,
  cursor_id text NOT NULL,
  -- Events behind the cursor whose recipients could not be read yet:
  -- [{eventId, createdAt, attempts}], retried by id on later runs.
  parked jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS accounts_v1.notification_deliveries (
  delivery_id text PRIMARY KEY,
  event_id text NOT NULL,
  -- No foreign key: a delivery whose pusher was deleted settles as removed.
  pusher_id text NOT NULL,
  subject text NOT NULL,
  payload text NOT NULL,
  urgency text NOT NULL CONSTRAINT notification_deliveries_urgency_catalog_v1 CHECK (
    urgency IN ('high', 'normal')
  ),
  topic text,
  enqueued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  state text NOT NULL CONSTRAINT notification_deliveries_state_catalog_v1 CHECK (
    state IN ('pending', 'settled')
  ),
  lease_token text,
  lease_expires_at timestamptz,
  outcome text CONSTRAINT notification_deliveries_outcome_catalog_v1 CHECK (
    outcome IN ('delivered', 'pusher_removed', 'failed', 'expired')
  ),
  last_status integer,
  settled_at timestamptz,
  CONSTRAINT notification_deliveries_event_pusher_v1 UNIQUE (event_id, pusher_id)
);

CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx
  ON accounts_v1.notification_deliveries (next_attempt_at, delivery_id)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS notification_deliveries_expiry_idx
  ON accounts_v1.notification_deliveries (expires_at, delivery_id);
