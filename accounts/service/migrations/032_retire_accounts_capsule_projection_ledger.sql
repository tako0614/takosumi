-- Accounts owns identity/session/OIDC/PAT support data only. Move the OIDC
-- client registration needed by Capsule identity into accounts_v1, rename the
-- remaining canonical references, then remove the pre-v1 projection ledger.

CREATE TABLE IF NOT EXISTS accounts_v1.oidc_clients (
  client_id text PRIMARY KEY,
  capsule_id text NOT NULL UNIQUE,
  namespace_path text NOT NULL CHECK (
    namespace_path ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,7}$'
  ),
  issuer_url text NOT NULL CHECK (issuer_url ~ '^https?://'),
  redirect_uris text[] NOT NULL,
  allowed_scopes text[] NOT NULL CHECK (
    array_length(allowed_scopes, 1) >= 1 AND 'openid' = ANY (allowed_scopes)
  ),
  subject_mode text NOT NULL CHECK (subject_mode = 'pairwise'),
  token_endpoint_auth_method text NOT NULL CHECK (
    token_endpoint_auth_method IN ('client_secret_basic', 'client_secret_post', 'none')
  ),
  client_secret_hash text CHECK (
    client_secret_hash IS NULL OR client_secret_hash LIKE 'sha256:%'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    token_endpoint_auth_method = 'none' OR client_secret_hash IS NOT NULL
  )
);

INSERT INTO accounts_v1.oidc_clients (
  client_id,
  capsule_id,
  namespace_path,
  issuer_url,
  redirect_uris,
  allowed_scopes,
  subject_mode,
  token_endpoint_auth_method,
  client_secret_hash,
  created_at,
  updated_at
)
SELECT
  client_id,
  installation_id,
  service_id,
  issuer_url,
  redirect_uris,
  allowed_scopes,
  subject_mode,
  token_endpoint_auth_method,
  client_secret_hash,
  created_at,
  updated_at
FROM installation_v1.oidc_clients
ON CONFLICT (client_id) DO UPDATE SET
  capsule_id = EXCLUDED.capsule_id,
  namespace_path = EXCLUDED.namespace_path,
  issuer_url = EXCLUDED.issuer_url,
  redirect_uris = EXCLUDED.redirect_uris,
  allowed_scopes = EXCLUDED.allowed_scopes,
  subject_mode = EXCLUDED.subject_mode,
  token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
  client_secret_hash = EXCLUDED.client_secret_hash,
  updated_at = EXCLUDED.updated_at;

ALTER TABLE accounts_v1.authorization_codes
  RENAME COLUMN installation_id TO capsule_id;
ALTER TABLE accounts_v1.authorization_codes
  RENAME COLUMN space_id TO workspace_id;
ALTER TABLE accounts_v1.authorization_codes
  DROP COLUMN app_id;

ALTER TABLE accounts_v1.oauth_access_tokens
  RENAME COLUMN installation_id TO capsule_id;
ALTER TABLE accounts_v1.oauth_access_tokens
  RENAME COLUMN space_id TO workspace_id;
ALTER TABLE accounts_v1.oauth_access_tokens
  DROP COLUMN app_id;

ALTER TABLE accounts_v1.oauth_refresh_tokens
  RENAME COLUMN installation_id TO capsule_id;
ALTER TABLE accounts_v1.oauth_refresh_tokens
  RENAME COLUMN space_id TO workspace_id;
ALTER TABLE accounts_v1.oauth_refresh_tokens
  DROP COLUMN app_id;

ALTER TABLE accounts_v1.personal_access_tokens
  RENAME COLUMN space_id TO workspace_id;
ALTER INDEX accounts_v1.personal_access_tokens_space_idx
  RENAME TO personal_access_tokens_workspace_idx;

ALTER TABLE accounts_v1.billing_usage_records
  RENAME COLUMN installation_id TO capsule_id;
ALTER INDEX accounts_v1.billing_usage_records_installation_idempotency_idx
  RENAME TO billing_usage_records_capsule_idempotency_idx;
ALTER INDEX accounts_v1.billing_usage_records_installation_reported_at_idx
  RENAME TO billing_usage_records_capsule_reported_at_idx;

DROP SCHEMA installation_v1 CASCADE;
