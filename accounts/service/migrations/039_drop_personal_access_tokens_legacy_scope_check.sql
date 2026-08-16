-- Remove the superseded PAT scope check only after migration 038 committed
-- validation of the widened v2 check.
ALTER TABLE accounts_v1.personal_access_tokens
  DROP CONSTRAINT personal_access_tokens_scopes_check;
