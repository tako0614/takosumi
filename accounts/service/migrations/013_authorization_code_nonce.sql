ALTER TABLE accounts_v1.authorization_codes
  ADD COLUMN IF NOT EXISTS nonce text;
