-- Additive credentials for existing OAuth accounts. No signup or recovery identity.
CREATE TABLE accounts_v1.password_credentials (
  subject text PRIMARY KEY REFERENCES accounts_v1.accounts(subject) ON DELETE RESTRICT,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'),
  password_hash text NOT NULL CHECK (length(password_hash) > 0),
  version bigint NOT NULL CHECK (version > 0)
);

CREATE TABLE accounts_v1.password_auth_attempts (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 256),
  count integer NOT NULL CHECK (count > 0),
  expires_at bigint NOT NULL
);
CREATE INDEX password_auth_attempts_expiry_idx
  ON accounts_v1.password_auth_attempts(expires_at, key);
