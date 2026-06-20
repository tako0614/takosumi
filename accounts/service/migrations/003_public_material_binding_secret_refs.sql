DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'app_bindings_public_material_has_no_secret_refs'
  ) THEN
    ALTER TABLE installation_v1.app_bindings
      ADD CONSTRAINT app_bindings_public_material_has_no_secret_refs
      CHECK (
        kind <> 'auth.bootstrap_token' OR
        array_length(secret_refs, 1) IS NULL
      );
  END IF;
END
$$;
