-- CLOUD-OIDC fix (id_token email_verified): persist the upstream identity
-- provider's `email_verified` assertion on the account so it survives the
-- re-read performed at OIDC token issuance. Before this column the Postgres
-- store dropped the value on save and `readAccountEmailVerified` always
-- resolved to false, so a Google sign-in asserting email_verified:true still
-- produced `email_verified:false`/omitted in the issued id_token.
--
-- Tri-state on purpose: the column is NULLable with NO DEFAULT. Existing rows
-- predating this migration read back as NULL = unknown (mapped to `undefined`
-- by accountFromRow), NOT a coerced `false`. The OIDC token endpoint only
-- emits `email_verified: true` when the stored value is exactly TRUE, so a
-- backfill is deliberately avoided to prevent wrongly asserting verification
-- for accounts whose upstream assertion was never captured.
ALTER TABLE accounts_v1.accounts
  ADD COLUMN IF NOT EXISTS email_verified boolean;
