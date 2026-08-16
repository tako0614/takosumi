-- Add the Workspace-bound Cloud AI authorities to a new check without taking
-- the validation lock in this migration. The v2 check remains active until
-- migration 041 validates this one and migration 042 removes v2.
ALTER TABLE accounts_v1.personal_access_tokens
  ADD CONSTRAINT personal_access_tokens_scopes_v3_check CHECK (
    array_length(scopes, 1) > 0
    AND scopes <@ ARRAY[
      'read',
      'write',
      'admin',
      'resources:read',
      'ai.models.read',
      'ai.chat',
      'ai.embeddings'
    ]::text[]
  ) NOT VALID;
