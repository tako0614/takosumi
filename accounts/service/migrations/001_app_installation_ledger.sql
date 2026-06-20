CREATE SCHEMA IF NOT EXISTS installation_v1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'space_kind_v1') THEN
    CREATE TYPE installation_v1.space_kind_v1 AS ENUM ('personal', 'team', 'org');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_installation_mode_v1') THEN
    CREATE TYPE installation_v1.app_installation_mode_v1 AS ENUM ('shared-cell', 'dedicated', 'self-hosted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_installation_status_v1') THEN
    CREATE TYPE installation_v1.app_installation_status_v1 AS ENUM ('installing', 'ready', 'failed', 'suspended', 'exported');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_binding_kind_v1') THEN
    CREATE TYPE installation_v1.app_binding_kind_v1 AS ENUM (
      'identity.oidc',
      'storage.sql',
      'storage.object',
      'protocol.http.api',
      'auth.bootstrap_token'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS installation_v1.ledger_accounts (
  account_id text PRIMARY KEY,
  legal_owner_subject text NOT NULL CHECK (legal_owner_subject LIKE 'tsub_%'),
  billing_account_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installation_v1.spaces (
  space_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES installation_v1.ledger_accounts(account_id),
  kind installation_v1.space_kind_v1 NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installation_v1.app_installations (
  installation_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES installation_v1.ledger_accounts(account_id),
  space_id text NOT NULL REFERENCES installation_v1.spaces(space_id),
  app_id text NOT NULL,
  source_git_url text NOT NULL,
  source_ref text NOT NULL,
  source_commit text NOT NULL,
  plan_digest text NOT NULL CHECK (plan_digest LIKE 'sha256:%'),
  artifact_digest text CHECK (artifact_digest IS NULL OR artifact_digest LIKE 'sha256:%'),
  mode installation_v1.app_installation_mode_v1 NOT NULL,
  runtime_binding_id text,
  status installation_v1.app_installation_status_v1 NOT NULL,
  created_by_subject text NOT NULL CHECK (created_by_subject LIKE 'tsub_%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installation_v1.runtime_bindings (
  runtime_binding_id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  mode installation_v1.app_installation_mode_v1 NOT NULL,
  target_type installation_v1.app_installation_mode_v1 NOT NULL,
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE installation_v1.app_installations
  DROP CONSTRAINT IF EXISTS app_installations_runtime_binding_id_fkey;

ALTER TABLE installation_v1.app_installations
  ADD CONSTRAINT app_installations_runtime_binding_id_fkey
  FOREIGN KEY (runtime_binding_id)
  REFERENCES installation_v1.runtime_bindings(runtime_binding_id);

CREATE TABLE IF NOT EXISTS installation_v1.app_bindings (
  binding_id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  kind installation_v1.app_binding_kind_v1 NOT NULL,
  config_ref text NOT NULL,
  secret_refs text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, name),
  CHECK (kind <> 'auth.bootstrap_token' OR array_length(secret_refs, 1) IS NULL)
);

CREATE TABLE IF NOT EXISTS installation_v1.app_grants (
  grant_id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  capability text NOT NULL CONSTRAINT app_grants_capability_catalog_v1 CHECK (
    capability IN (
      'app.profile.write',
      'app.memory.write',
      'deploy.intent.write',
      'logs.read.own',
      'billing.usage.report',
      'spaces:read',
      'spaces:write',
      'files:read',
      'files:write',
      'memories:read',
      'memories:write',
      'threads:read',
      'threads:write',
      'runs:read',
      'runs:write',
      'agents:execute',
      'repos:read',
      'repos:write',
      'mcp:invoke',
      'events:subscribe'
    )
  ),
  scope jsonb NOT NULL DEFAULT '{}',
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS installation_v1.installation_events (
  event_id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  previous_event_hash text,
  event_hash text NOT NULL CHECK (event_hash LIKE 'sha256:%'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installation_v1.launch_token_consumptions (
  jti text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (subject LIKE 'tsub_%'),
  audience text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installation_v1.oidc_clients (
  client_id text PRIMARY KEY,
  installation_id text NOT NULL UNIQUE REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  redirect_uris text[] NOT NULL,
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

CREATE INDEX IF NOT EXISTS spaces_account_id_idx
  ON installation_v1.spaces(account_id);

CREATE INDEX IF NOT EXISTS app_installations_space_id_idx
  ON installation_v1.app_installations(space_id);

CREATE INDEX IF NOT EXISTS app_bindings_installation_id_idx
  ON installation_v1.app_bindings(installation_id);

CREATE INDEX IF NOT EXISTS app_grants_installation_id_idx
  ON installation_v1.app_grants(installation_id);

CREATE INDEX IF NOT EXISTS installation_events_installation_id_created_at_idx
  ON installation_v1.installation_events(installation_id, created_at);

CREATE INDEX IF NOT EXISTS launch_token_consumptions_installation_id_idx
  ON installation_v1.launch_token_consumptions(installation_id);

CREATE INDEX IF NOT EXISTS oidc_clients_installation_id_idx
  ON installation_v1.oidc_clients(installation_id);
