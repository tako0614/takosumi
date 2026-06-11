ALTER TABLE installation_v1.app_installations
  ADD COLUMN IF NOT EXISTS billing_account_id text;

COMMENT ON COLUMN installation_v1.app_installations.billing_account_id IS
  'Per-installation billing owner reference used to keep shared-cell installs isolated even when they share an account or warm cell.';
