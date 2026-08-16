-- Validate the widened PAT scope check in its own transaction. The v2 check
-- remains active until migration 042 completes.
ALTER TABLE accounts_v1.personal_access_tokens
  VALIDATE CONSTRAINT personal_access_tokens_scopes_v3_check;
