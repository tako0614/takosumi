-- Remove retired descriptor/import storage and harden the AppInstallation
-- ledger schema without reintroducing service import vocabulary.

DROP INDEX IF EXISTS installation_v1.app_installations_service_imports_gin_idx;

ALTER TABLE installation_v1.app_installations
  DROP COLUMN IF EXISTS service_imports_json;

DROP TABLE IF EXISTS accounts_v1.service_descriptors;

-- app_installations.runtime_binding_id is a denormalized pointer used by the
-- Accounts API. runtime_bindings.installation_id remains the owning FK; keeping
-- the reverse FK makes first writes circular for Postgres-backed installs.
ALTER TABLE installation_v1.app_installations
  DROP CONSTRAINT IF EXISTS app_installations_runtime_binding_id_fkey;

COMMENT ON COLUMN installation_v1.app_installations.runtime_binding_id IS
  'Denormalized pointer to the active runtime binding; runtime_bindings.installation_id owns referential integrity.';

CREATE SEQUENCE IF NOT EXISTS installation_v1.installation_events_event_sequence_seq;

ALTER TABLE installation_v1.installation_events
  ADD COLUMN IF NOT EXISTS event_sequence bigint;

WITH base AS (
  SELECT COALESCE(MAX(event_sequence), 0) AS value
  FROM installation_v1.installation_events
),
ordered AS (
  SELECT
    event_id,
    base.value + row_number() OVER (
      ORDER BY installation_id, created_at, event_id
    ) AS next_sequence
  FROM installation_v1.installation_events, base
  WHERE event_sequence IS NULL
)
UPDATE installation_v1.installation_events AS events
  SET event_sequence = ordered.next_sequence
  FROM ordered
  WHERE events.event_id = ordered.event_id;

SELECT setval(
  'installation_v1.installation_events_event_sequence_seq'::regclass,
  GREATEST(COALESCE(MAX(event_sequence), 0), 1),
  COALESCE(MAX(event_sequence), 0) > 0
)
FROM installation_v1.installation_events;

ALTER TABLE installation_v1.installation_events
  ALTER COLUMN event_sequence SET DEFAULT nextval(
    'installation_v1.installation_events_event_sequence_seq'::regclass
  ),
  ALTER COLUMN event_sequence SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS installation_events_event_sequence_idx
  ON installation_v1.installation_events(event_sequence);

CREATE INDEX IF NOT EXISTS installation_events_installation_id_sequence_idx
  ON installation_v1.installation_events(installation_id, event_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS installation_events_one_root_per_installation_idx
  ON installation_v1.installation_events(installation_id)
  WHERE previous_event_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS installation_events_one_successor_per_hash_idx
  ON installation_v1.installation_events(installation_id, previous_event_hash)
  WHERE previous_event_hash IS NOT NULL;
