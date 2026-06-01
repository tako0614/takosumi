DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'app_bindings_no_service_import_kind'
  ) THEN
    ALTER TABLE installation_v1.app_bindings
      ADD CONSTRAINT app_bindings_no_service_import_kind
      CHECK (kind::text <> 'service.import@v1') NOT VALID;
  END IF;
END
$$;
