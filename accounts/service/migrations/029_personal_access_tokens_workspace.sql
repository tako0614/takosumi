ALTER TABLE accounts_v1.personal_access_tokens
  ADD COLUMN IF NOT EXISTS space_id text
  REFERENCES accounts_v1.spaces(space_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS personal_access_tokens_space_idx
  ON accounts_v1.personal_access_tokens(space_id, subject)
  WHERE space_id IS NOT NULL;
