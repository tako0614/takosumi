-- Service Graph reset follow-up: keep account-plane materialized binding
-- records durable without restoring the retired public app_bindings table.
-- These rows are an internal continuity ledger for materialize/export/OIDC
-- helper flows. The public contract remains ServiceExport / ServiceBinding /
-- ServiceGrant.

CREATE TABLE IF NOT EXISTS installation_v1.service_binding_materials (
  binding_id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CONSTRAINT service_binding_materials_kind_catalog_v1 CHECK (
    kind IN (
      'identity.oidc',
      'storage.sql',
      'storage.object',
      'protocol.http.api',
      'auth.bootstrap_token'
    )
  ),
  config_ref text NOT NULL,
  secret_refs text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS service_binding_materials_installation_id_idx
  ON installation_v1.service_binding_materials(installation_id, created_at, binding_id);
