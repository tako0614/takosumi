CREATE TABLE IF NOT EXISTS accounts_v1.personal_access_tokens (
  token_id text PRIMARY KEY CHECK (token_id LIKE 'pat_%'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash LIKE 'sha256:%'),
  token_prefix text NOT NULL CHECK (token_prefix LIKE 'takpat_%'),
  subject text NOT NULL REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  scopes text[] NOT NULL CHECK (
    array_length(scopes, 1) > 0
    AND scopes <@ ARRAY['read', 'write', 'admin']::text[]
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at)
);

CREATE INDEX IF NOT EXISTS personal_access_tokens_subject_idx
  ON accounts_v1.personal_access_tokens(subject, created_at, token_id);

CREATE INDEX IF NOT EXISTS personal_access_tokens_active_idx
  ON accounts_v1.personal_access_tokens(subject, expires_at)
  WHERE revoked_at IS NULL;
