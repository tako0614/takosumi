-- Wave 6 / v1 contract reset: drop the legacy AppBinding, AppGrant, and
-- RuntimeBinding tables. These three concepts have been removed from the
-- public Takosumi Accounts contract; PlatformService binding selections and
-- account-plane permission checks declare the equivalent intent at install time.
--
-- This migration is intentionally BACKWARD-INCOMPATIBLE. Per the v1 contract
-- reset mandate ("no legacy / no migration guidance / clean cut"), operators
-- must export installation state with the v0 surface before applying this
-- migration if they need to retain binding/grant/runtime-binding rows.
--
-- Foreign keys on installation_v1.app_installations.runtime_binding_id must
-- be dropped before the referenced table can be removed.

ALTER TABLE IF EXISTS installation_v1.app_installations
  DROP CONSTRAINT IF EXISTS app_installations_runtime_binding_id_fkey;

ALTER TABLE IF EXISTS installation_v1.app_installations
  DROP COLUMN IF EXISTS runtime_binding_id;

DROP INDEX IF EXISTS installation_v1.app_bindings_installation_id_idx;
DROP INDEX IF EXISTS installation_v1.app_grants_installation_id_idx;

DROP TABLE IF EXISTS installation_v1.app_grants;
DROP TABLE IF EXISTS installation_v1.app_bindings;
DROP TABLE IF EXISTS installation_v1.runtime_bindings;

DROP TYPE IF EXISTS installation_v1.app_binding_kind_v1;
