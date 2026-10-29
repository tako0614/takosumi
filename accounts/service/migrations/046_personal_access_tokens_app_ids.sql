-- Optional app restriction. A null array preserves existing PAT behavior;
-- Workspace-bound PAT conversion needs a Control-owned app snapshot and is
-- deliberately not guessed from Accounts tables.
ALTER TABLE accounts_v1.personal_access_tokens
  ADD COLUMN app_ids text[];
