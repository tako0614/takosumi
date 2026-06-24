ALTER TABLE installation_v1.app_installations
  ADD COLUMN IF NOT EXISTS source_path text;

COMMENT ON COLUMN installation_v1.app_installations.source_path IS
  'Relative module path inside the Git source used for OpenTofu Capsule restore/import fidelity.';
