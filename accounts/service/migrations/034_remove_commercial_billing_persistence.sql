-- Accounts owns identity, sessions, OIDC, personal access tokens, and privacy
-- requests. Provider customer/subscription state, payment events, and rated
-- usage export are commercial host-extension data and must not persist in OSS
-- Accounts.

DROP TABLE IF EXISTS accounts_v1.billing_usage_records;
DROP TABLE IF EXISTS accounts_v1.billing_webhook_events;
DROP TABLE IF EXISTS accounts_v1.billing_accounts;

DROP TYPE IF EXISTS accounts_v1.billing_webhook_event_status_v1;
DROP TYPE IF EXISTS accounts_v1.billing_account_status_v1;
