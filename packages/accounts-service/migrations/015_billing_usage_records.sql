CREATE TABLE IF NOT EXISTS accounts_v1.billing_usage_records (
  usage_report_id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES installation_v1.app_installations(installation_id),
  billing_account_id text NOT NULL REFERENCES accounts_v1.billing_accounts(billing_account_id),
  meter text NOT NULL,
  quantity double precision NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  idempotency_key text,
  request_digest text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_by_subject text REFERENCES accounts_v1.accounts(subject),
  reported_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_usage_records_installation_idempotency_idx
  ON accounts_v1.billing_usage_records(installation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_usage_records_installation_reported_at_idx
  ON accounts_v1.billing_usage_records(installation_id, reported_at);

CREATE INDEX IF NOT EXISTS billing_usage_records_billing_account_reported_at_idx
  ON accounts_v1.billing_usage_records(billing_account_id, reported_at);
