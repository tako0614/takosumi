ALTER TABLE accounts_v1.billing_usage_records
  ADD COLUMN IF NOT EXISTS billing_export_provider TEXT;

ALTER TABLE accounts_v1.billing_usage_records
  ADD COLUMN IF NOT EXISTS billing_export_id TEXT;

ALTER TABLE accounts_v1.billing_usage_records
  ADD COLUMN IF NOT EXISTS billing_export_reference TEXT;

ALTER TABLE accounts_v1.billing_usage_records
  ADD COLUMN IF NOT EXISTS billing_exported_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS billing_usage_records_export_status_idx
  ON accounts_v1.billing_usage_records(billing_account_id, billing_exported_at, reported_at);
