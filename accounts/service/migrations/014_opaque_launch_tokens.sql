CREATE TABLE IF NOT EXISTS installation_v1.launch_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash LIKE 'sha256:%'),
  jti text NOT NULL UNIQUE,
  installation_id text NOT NULL REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  account_id text NOT NULL,
  space_id text NOT NULL,
  app_id text NOT NULL,
  subject text NOT NULL CHECK (subject LIKE 'tsub_%'),
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['openid', 'email', 'profile'],
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS launch_tokens_installation_active_idx
  ON installation_v1.launch_tokens(installation_id, expires_at)
  WHERE used_at IS NULL;
