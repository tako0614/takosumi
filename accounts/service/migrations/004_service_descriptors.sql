CREATE SCHEMA IF NOT EXISTS accounts_v1;

CREATE TABLE IF NOT EXISTS accounts_v1.service_descriptors (
  contract text PRIMARY KEY CHECK (
    contract ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*@v[0-9]+(-[a-z][a-z0-9-]*)?$'
  ),
  id text NOT NULL CHECK (
    id ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'
  ),
  version text NOT NULL CHECK (
    version ~ '^v[0-9]+(-[a-z][a-z0-9-]*)?$'
  ),
  endpoints jsonb NOT NULL CHECK (
    jsonb_typeof(endpoints) = 'array' AND jsonb_array_length(endpoints) > 0
  ),
  metadata jsonb NOT NULL DEFAULT '{}',
  signature text NOT NULL,
  published_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  provider_instance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (contract = id || '@' || version),
  CHECK (expires_at > published_at)
);

CREATE INDEX IF NOT EXISTS service_descriptors_expires_at_idx
  ON accounts_v1.service_descriptors(expires_at);
