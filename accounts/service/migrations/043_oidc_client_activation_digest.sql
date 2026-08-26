ALTER TABLE accounts_v1.oidc_clients
  ADD COLUMN IF NOT EXISTS activation_digest text;

ALTER TABLE accounts_v1.oidc_clients
  ADD CONSTRAINT oidc_clients_activation_digest_check CHECK (
    activation_digest IS NULL
    OR activation_digest ~ '^sha256:[0-9a-f]{64}$'
  ) NOT VALID;
