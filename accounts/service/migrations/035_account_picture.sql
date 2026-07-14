-- Preserve the upstream profile image used by OIDC UserInfo. The field is
-- optional and remains NULL for existing accounts; no image URL is inferred or
-- backfilled from email or provider-specific identifiers.
ALTER TABLE accounts_v1.accounts
  ADD COLUMN IF NOT EXISTS picture text;
