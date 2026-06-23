CREATE SCHEMA IF NOT EXISTS accounts_v1;

CREATE TABLE IF NOT EXISTS accounts_v1.privacy_requests (
  request_id text PRIMARY KEY,
  subject text NOT NULL REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT privacy_requests_kind_catalog_v1 CHECK (
    kind IN ('export', 'delete')
  ),
  status text NOT NULL CONSTRAINT privacy_requests_status_catalog_v1 CHECK (
    status IN (
      'received',
      'processing',
      'exported',
      'login_disabled',
      'deleted',
      'rejected'
    )
  ),
  retention_record_id text NOT NULL,
  policy_ref text NOT NULL,
  request_summary text,
  export_ref text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS privacy_requests_subject_idx
  ON accounts_v1.privacy_requests(subject, created_at DESC, request_id);

CREATE INDEX IF NOT EXISTS privacy_requests_status_idx
  ON accounts_v1.privacy_requests(status, updated_at DESC, request_id);
