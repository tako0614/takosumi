CREATE SCHEMA IF NOT EXISTS accounts_v1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_provider_v1') THEN
    CREATE TYPE accounts_v1.billing_provider_v1 AS ENUM ('stripe', 'manual');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_account_status_v1') THEN
    CREATE TYPE accounts_v1.billing_account_status_v1 AS ENUM (
      'active',
      'trialing',
      'incomplete',
      'incomplete_expired',
      'past_due',
      'unpaid',
      'canceled',
      'paused'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_webhook_event_status_v1') THEN
    CREATE TYPE accounts_v1.billing_webhook_event_status_v1 AS ENUM (
      'received',
      'processed',
      'skipped',
      'failed'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS accounts_v1.accounts (
  subject text PRIMARY KEY CHECK (subject LIKE 'tsub_%'),
  email text,
  display_name text,
  terms_version text,
  terms_accepted_at timestamptz,
  terms_accepted_source text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (terms_version IS NULL AND terms_accepted_at IS NULL AND terms_accepted_source IS NULL) OR
    (terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL AND terms_accepted_source IS NOT NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS accounts_v1.upstream_identities (
  provider_id text NOT NULL,
  upstream_issuer text NOT NULL,
  upstream_subject text NOT NULL,
  subject text NOT NULL REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_id, upstream_issuer, upstream_subject),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS upstream_identities_subject_idx
  ON accounts_v1.upstream_identities(subject);

CREATE TABLE IF NOT EXISTS accounts_v1.passkey_credentials (
  credential_id text PRIMARY KEY,
  subject text NOT NULL REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  public_key_jwk jsonb NOT NULL CHECK (jsonb_typeof(public_key_jwk) = 'object'),
  sign_count bigint NOT NULL CHECK (sign_count >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS passkey_credentials_subject_idx
  ON accounts_v1.passkey_credentials(subject);

CREATE TABLE IF NOT EXISTS accounts_v1.account_sessions (
  session_id text PRIMARY KEY,
  subject text NOT NULL REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS account_sessions_subject_idx
  ON accounts_v1.account_sessions(subject);

CREATE INDEX IF NOT EXISTS account_sessions_expires_at_idx
  ON accounts_v1.account_sessions(expires_at);

CREATE TABLE IF NOT EXISTS accounts_v1.authorization_codes (
  code_hash text PRIMARY KEY CHECK (code_hash LIKE 'sha256:%'),
  client_id text NOT NULL,
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^https?://'),
  scope text NOT NULL,
  subject text NOT NULL,
 takosumi_subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  installation_id text REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  app_id text,
  space_id text REFERENCES installation_v1.spaces(space_id) ON DELETE CASCADE,
  role text,
  code_challenge text,
  code_challenge_method text CHECK (
    code_challenge_method IS NULL OR code_challenge_method IN ('plain', 'S256')
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS authorization_codes_client_id_idx
  ON accounts_v1.authorization_codes(client_id);

CREATE INDEX IF NOT EXISTS authorization_codes_expires_at_idx
  ON accounts_v1.authorization_codes(expires_at);

CREATE TABLE IF NOT EXISTS accounts_v1.oauth_access_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash LIKE 'sha256:%'),
  client_id text NOT NULL,
  scope text NOT NULL,
  subject text NOT NULL,
 takosumi_subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  installation_id text REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  app_id text,
  space_id text REFERENCES installation_v1.spaces(space_id) ON DELETE CASCADE,
  role text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS oauth_access_tokens_client_id_idx
  ON accounts_v1.oauth_access_tokens(client_id);

CREATE INDEX IF NOT EXISTS oauth_access_tokens_expires_at_idx
  ON accounts_v1.oauth_access_tokens(expires_at);

CREATE TABLE IF NOT EXISTS accounts_v1.oauth_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash LIKE 'sha256:%'),
  client_id text NOT NULL,
  scope text NOT NULL,
  subject text NOT NULL,
 takosumi_subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  installation_id text REFERENCES installation_v1.app_installations(installation_id) ON DELETE CASCADE,
  app_id text,
  space_id text REFERENCES installation_v1.spaces(space_id) ON DELETE CASCADE,
  role text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_client_id_idx
  ON accounts_v1.oauth_refresh_tokens(client_id);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_at_idx
  ON accounts_v1.oauth_refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS accounts_v1.billing_accounts (
  billing_account_id text PRIMARY KEY,
  subject text NOT NULL UNIQUE REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  provider accounts_v1.billing_provider_v1 NOT NULL,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text,
  stripe_price_id text,
  plan_code text,
  current_period_end_unix bigint,
  last_invoice_id text,
  dunning_started_at timestamptz,
  next_payment_attempt_unix bigint,
  dunning_attempt_count integer CHECK (dunning_attempt_count IS NULL OR dunning_attempt_count >= 0),
  dunning_action text CHECK (dunning_action IS NULL OR dunning_action IN ('retry_scheduled', 'marked_uncollectible')),
  dunning_exhausted_at timestamptz,
  last_credit_event_id text,
  last_credit_kind text CHECK (last_credit_kind IS NULL OR last_credit_kind IN ('refund', 'credit_note')),
  last_credit_id text,
  last_credit_amount bigint CHECK (last_credit_amount IS NULL OR last_credit_amount >= 0),
  last_credit_currency text,
  last_plan_transition_event_id text,
  last_plan_from_code text,
  last_plan_to_code text,
  last_plan_transitioned_at timestamptz,
  last_tax_event_id text,
  tax_policy_ref text,
  tax_jurisdiction text,
  tax_automatic_status text,
  status accounts_v1.billing_account_status_v1 NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    provider <> 'stripe' OR stripe_customer_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS billing_accounts_status_idx
  ON accounts_v1.billing_accounts(status);

CREATE TABLE IF NOT EXISTS accounts_v1.billing_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  status accounts_v1.billing_webhook_event_status_v1 NOT NULL,
  received_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  error_message text,
  CHECK (updated_at >= received_at)
);

CREATE INDEX IF NOT EXISTS billing_webhook_events_status_idx
  ON accounts_v1.billing_webhook_events(status);
