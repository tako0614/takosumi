-- Add the workspace-bound hosted-resource inventory read authority to a new
-- check without taking the long validation lock in this migration. The old
-- check remains active until migration 038 validates this one and migration
-- 039 removes it.
ALTER TABLE accounts_v1.personal_access_tokens
  ADD CONSTRAINT personal_access_tokens_scopes_v2_check CHECK (
    array_length(scopes, 1) > 0
    AND scopes <@ ARRAY['read', 'write', 'admin', 'resources:read']::text[]
  ) NOT VALID;
