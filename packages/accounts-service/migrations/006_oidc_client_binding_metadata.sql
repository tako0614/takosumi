ALTER TABLE installation_v1.oidc_clients
  ADD COLUMN IF NOT EXISTS service_id text;

UPDATE installation_v1.oidc_clients
  SET service_id = 'identity.primary.oidc'
  WHERE service_id IS NULL;

ALTER TABLE installation_v1.oidc_clients
  ALTER COLUMN service_id SET NOT NULL;

ALTER TABLE installation_v1.oidc_clients
  ADD CONSTRAINT oidc_clients_service_id_check CHECK (
    service_id ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,7}$'
  );

ALTER TABLE installation_v1.oidc_clients
  ADD COLUMN IF NOT EXISTS issuer_url text;

UPDATE installation_v1.oidc_clients
  SET issuer_url = 'https://accounts.takosumi.com'
  WHERE issuer_url IS NULL;

ALTER TABLE installation_v1.oidc_clients
  ALTER COLUMN issuer_url SET NOT NULL;

ALTER TABLE installation_v1.oidc_clients
  ADD CONSTRAINT oidc_clients_issuer_url_check CHECK (
    issuer_url ~ '^https?://'
  );

ALTER TABLE installation_v1.oidc_clients
  ADD COLUMN IF NOT EXISTS allowed_scopes text[] NOT NULL DEFAULT ARRAY['openid']::text[];

ALTER TABLE installation_v1.oidc_clients
  ADD CONSTRAINT oidc_clients_allowed_scopes_check CHECK (
    array_length(allowed_scopes, 1) >= 1 AND 'openid' = ANY (allowed_scopes)
  );

ALTER TABLE installation_v1.oidc_clients
  ADD COLUMN IF NOT EXISTS subject_mode text NOT NULL DEFAULT 'pairwise';

ALTER TABLE installation_v1.oidc_clients
  ADD CONSTRAINT oidc_clients_subject_mode_check CHECK (
    subject_mode = 'pairwise'
  );
