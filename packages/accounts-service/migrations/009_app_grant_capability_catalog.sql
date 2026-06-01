DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'app_grants_capability_catalog_v1'
  ) THEN
    ALTER TABLE installation_v1.app_grants
      ADD CONSTRAINT app_grants_capability_catalog_v1
      CHECK (
        capability IN (
          'app.profile.write',
          'app.memory.write',
          'deploy.intent.write',
          'logs.read.own',
          'billing.usage.report',
          'spaces:read',
          'spaces:write',
          'files:read',
          'files:write',
          'memories:read',
          'memories:write',
          'threads:read',
          'threads:write',
          'runs:read',
          'runs:write',
          'agents:execute',
          'repos:read',
          'repos:write',
          'mcp:invoke',
          'events:subscribe'
        )
      ) NOT VALID;
  END IF;
END
$$;
