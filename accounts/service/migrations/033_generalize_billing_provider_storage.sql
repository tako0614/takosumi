-- Billing providers are installed by the operator/extension composition. The
-- OSS Accounts schema stores their identifiers opaquely and must not encode a
-- Stripe-only enum, column vocabulary, or provider-specific required-field
-- rule.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'accounts_v1'
      AND rel.relname = 'billing_accounts'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%stripe_customer_id%'
  LOOP
    EXECUTE format(
      'ALTER TABLE accounts_v1.billing_accounts DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$$;

ALTER TABLE accounts_v1.billing_accounts
  ALTER COLUMN provider TYPE text USING provider::text;

ALTER TABLE accounts_v1.billing_accounts
  RENAME COLUMN stripe_customer_id TO provider_customer_id;
ALTER TABLE accounts_v1.billing_accounts
  RENAME COLUMN stripe_subscription_id TO provider_subscription_id;
ALTER TABLE accounts_v1.billing_accounts
  RENAME COLUMN stripe_price_id TO provider_price_id;
ALTER TABLE accounts_v1.billing_accounts
  RENAME COLUMN stripe_default_payment_method_id TO provider_default_payment_method_id;

DROP TYPE IF EXISTS accounts_v1.billing_provider_v1;
