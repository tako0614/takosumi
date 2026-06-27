-- Persist the Stripe payment method used for automatic USD balance recharge.
--
-- The value is a Stripe object id such as `pm_...`, captured from
-- checkout/subscription webhooks. It is not a card number or secret, but it is
-- still operator/account-plane billing metadata and must not be exposed through
-- public projections.

ALTER TABLE accounts_v1.billing_accounts
  ADD COLUMN IF NOT EXISTS stripe_default_payment_method_id text;
