ALTER TABLE installation_v1.app_installations
  ADD COLUMN IF NOT EXISTS service_imports_json jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS app_installations_service_imports_gin_idx
  ON installation_v1.app_installations
  USING gin (service_imports_json);
