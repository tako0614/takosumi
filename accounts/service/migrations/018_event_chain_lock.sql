-- F7 fix (installation event chain race): create a synthetic
-- per-installation row-lock table used to serialize concurrent appends
-- to installation_v1.installation_events. Without this lock, two
-- concurrent writers can both observe the same chain tail
-- (previous_event_hash) and INSERT two successor events, forking the
-- hash chain.
--
-- The table holds one row per installation_id. The single column is the
-- installation_id PRIMARY KEY; no other state is stored. Writers take
-- SELECT ... FOR UPDATE NOWAIT inside a transaction. The NOWAIT clause
-- raises SQLSTATE 55P03 (lock_not_available) when contention is
-- detected; the application-layer appendLedgerEvent helper catches the
-- error and retries with a capped exponential backoff.
--
-- Rows are materialized lazily by the first append for an installation
-- (INSERT ... ON CONFLICT (installation_id) DO NOTHING). We do not
-- ENFORCE referential integrity on the FK because the lifecycle of an
-- installation row vs its event chain is tightly bound: installations
-- are not deleted in v1, and orphan lock rows are harmless (a tiny
-- footprint per installation). The FK is included as documentation of
-- the intended relationship and to keep `ON DELETE CASCADE` behavior
-- consistent should installations ever become deletable.

CREATE TABLE IF NOT EXISTS installation_v1.installation_event_chain_locks (
  installation_id text PRIMARY KEY
    REFERENCES installation_v1.app_installations(installation_id)
    ON DELETE CASCADE
);
