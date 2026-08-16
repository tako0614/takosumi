-- Remove the superseded PAT scope check only after migration 041 committed
-- validation of the widened v3 check.
ALTER TABLE accounts_v1.personal_access_tokens
  DROP CONSTRAINT personal_access_tokens_scopes_v2_check;
