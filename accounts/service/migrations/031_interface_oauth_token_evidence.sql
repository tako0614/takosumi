-- Short-lived Interface OAuth access tokens are opaque Accounts credentials.
-- Persist only their hash (the existing token_hash column) plus non-secret,
-- audience-bound authorization evidence. No refresh token is issued for this
-- role; matching nullable columns are kept on both OAuth token tables so the
-- shared Postgres TokenRecord codec remains lossless and schema-symmetric.

ALTER TABLE accounts_v1.oauth_access_tokens
  ADD COLUMN IF NOT EXISTS audience text,
  ADD COLUMN IF NOT EXISTS interface_id text,
  ADD COLUMN IF NOT EXISTS interface_binding_id text,
  ADD COLUMN IF NOT EXISTS interface_resolved_revision bigint;

ALTER TABLE accounts_v1.oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS audience text,
  ADD COLUMN IF NOT EXISTS interface_id text,
  ADD COLUMN IF NOT EXISTS interface_binding_id text,
  ADD COLUMN IF NOT EXISTS interface_resolved_revision bigint;

ALTER TABLE accounts_v1.oauth_access_tokens
  DROP CONSTRAINT IF EXISTS oauth_access_tokens_interface_oauth_evidence_v1;

ALTER TABLE accounts_v1.oauth_access_tokens
  ADD CONSTRAINT oauth_access_tokens_interface_oauth_evidence_v1 CHECK (
    role IS DISTINCT FROM 'interface-runtime' OR (
      audience IS NOT NULL AND length(btrim(audience)) > 0 AND
      space_id IS NOT NULL AND length(btrim(space_id)) > 0 AND
      interface_id IS NOT NULL AND length(btrim(interface_id)) > 0 AND
      interface_binding_id IS NOT NULL AND length(btrim(interface_binding_id)) > 0 AND
      interface_resolved_revision IS NOT NULL AND
      interface_resolved_revision > 0
    )
  );

ALTER TABLE accounts_v1.oauth_refresh_tokens
  DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_no_interface_oauth_v1;

ALTER TABLE accounts_v1.oauth_refresh_tokens
  ADD CONSTRAINT oauth_refresh_tokens_no_interface_oauth_v1 CHECK (
    role IS DISTINCT FROM 'interface-runtime'
  );
