-- Capsule OIDC clients are provisioned by the control plane for any Capsule
-- (workspaces.ts capsule create → ensureTakosumiAccountsOidcForCapsule), not
-- only for app-installation-ledger imports. The accounts-side
-- installation_v1.app_installations mirror row only exists on the
-- app-installation import path, so the foreign key made every direct
-- capsule create with an oidc_client install projection fail with
-- oidc_clients_installation_id_fkey (D1 deployments have no such
-- constraint and already accept these rows). Keep the column and its
-- UNIQUE constraint; drop only the foreign key.
ALTER TABLE installation_v1.oidc_clients
  DROP CONSTRAINT IF EXISTS oidc_clients_installation_id_fkey;
