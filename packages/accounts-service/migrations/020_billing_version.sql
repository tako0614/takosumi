-- G15 fix (billing webhook lost-update): add an optimistic-concurrency
-- version column to billing accounts.
--
-- Background: every branch of applyStripeBillingEvent
-- (packages/accounts-service/src/billing-apply.ts) used to read a
-- BillingAccount, spread-modify it, and unconditionally write it back. The
-- webhook idempotency layer (claimBillingWebhookEvent) only dedupes the SAME
-- Stripe event id, so two DIFFERENT concurrent events for the same customer
-- (e.g. customer.subscription.updated + invoice.payment_failed) each claimed
-- their own id and then both ran read-modify-write. The second writer
-- clobbered the first writer's field updates (lost update on dunning /
-- dispute / plan fields).
--
-- The fix uses optimistic concurrency: the store now exposes
-- saveBillingAccountIfVersion(record, expectedVersion), which writes only when
-- the stored row still carries the version the caller read, advancing it by
-- one. billing-apply.ts wraps each apply in a bounded read -> mutate ->
-- conditional-save loop so a CAS miss (a concurrent different-event write)
-- triggers a re-read and re-apply of the SAME event's mutation against the
-- fresh record instead of overwriting it. This column backs that guard.
--
-- Existing rows default to version 1; the conditional UPDATE treats a NULL
-- via COALESCE(version, 0) for defense-in-depth, but DEFAULT 1 + NOT NULL
-- means no row should be NULL after this migration.

ALTER TABLE accounts_v1.billing_accounts
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
