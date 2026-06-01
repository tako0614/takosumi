// Billing accounts, Stripe webhook event ledger, and metered usage records.
// Free-function module that preserves the SQL and uniqueness checks from
// the original PostgresAccountsStore.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  BillingAccountRecord,
  BillingUsageRecord,
  BillingWebhookEventClaimResult,
  BillingWebhookEventRecord,
} from "../store.ts";
import {
  billingAccountFromRow,
  type BillingAccountRow,
  billingAccountSelect,
  billingUsageFromRow,
  type BillingUsageRow,
  billingUsageSelect,
  billingWebhookEventFromRow,
  type BillingWebhookEventRow,
  json,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  runRows,
  toDate,
} from "./internal.ts";

export async function saveBillingAccount(
  client: PostgresQueryClient,
  record: BillingAccountRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.billing_accounts (
        billing_account_id, subject, provider, stripe_customer_id,
        stripe_subscription_id, stripe_price_id, plan_code,
        current_period_end_unix, last_invoice_id, dunning_started_at,
        next_payment_attempt_unix, dunning_attempt_count, dunning_action,
        dunning_exhausted_at, last_credit_event_id, last_credit_kind,
        last_credit_id, last_credit_amount, last_credit_currency,
        last_plan_transition_event_id, last_plan_from_code, last_plan_to_code,
        last_plan_transitioned_at, last_tax_event_id, tax_policy_ref,
        tax_jurisdiction, tax_automatic_status, status, version,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
      ON CONFLICT (billing_account_id) DO UPDATE SET
        subject = EXCLUDED.subject,
        provider = EXCLUDED.provider,
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        stripe_price_id = EXCLUDED.stripe_price_id,
        plan_code = EXCLUDED.plan_code,
        current_period_end_unix = EXCLUDED.current_period_end_unix,
        last_invoice_id = EXCLUDED.last_invoice_id,
        dunning_started_at = EXCLUDED.dunning_started_at,
        next_payment_attempt_unix = EXCLUDED.next_payment_attempt_unix,
        dunning_attempt_count = EXCLUDED.dunning_attempt_count,
        dunning_action = EXCLUDED.dunning_action,
        dunning_exhausted_at = EXCLUDED.dunning_exhausted_at,
        last_credit_event_id = EXCLUDED.last_credit_event_id,
        last_credit_kind = EXCLUDED.last_credit_kind,
        last_credit_id = EXCLUDED.last_credit_id,
        last_credit_amount = EXCLUDED.last_credit_amount,
        last_credit_currency = EXCLUDED.last_credit_currency,
        last_plan_transition_event_id = EXCLUDED.last_plan_transition_event_id,
        last_plan_from_code = EXCLUDED.last_plan_from_code,
        last_plan_to_code = EXCLUDED.last_plan_to_code,
        last_plan_transitioned_at = EXCLUDED.last_plan_transitioned_at,
        last_tax_event_id = EXCLUDED.last_tax_event_id,
        tax_policy_ref = EXCLUDED.tax_policy_ref,
        tax_jurisdiction = EXCLUDED.tax_jurisdiction,
        tax_automatic_status = EXCLUDED.tax_automatic_status,
        status = EXCLUDED.status,
        version = EXCLUDED.version,
        updated_at = EXCLUDED.updated_at`,
    [
      record.billingAccountId,
      record.subject,
      record.provider,
      record.stripeCustomerId ?? null,
      record.stripeSubscriptionId ?? null,
      record.stripePriceId ?? null,
      record.planCode ?? null,
      record.currentPeriodEndUnix ?? null,
      record.lastInvoiceId ?? null,
      record.dunningStartedAt ? toDate(record.dunningStartedAt) : null,
      record.nextPaymentAttemptUnix ?? null,
      record.dunningAttemptCount ?? null,
      record.dunningAction ?? null,
      record.dunningExhaustedAt ? toDate(record.dunningExhaustedAt) : null,
      record.lastCreditEventId ?? null,
      record.lastCreditKind ?? null,
      record.lastCreditId ?? null,
      record.lastCreditAmount ?? null,
      record.lastCreditCurrency ?? null,
      record.lastPlanTransitionEventId ?? null,
      record.lastPlanFromCode ?? null,
      record.lastPlanToCode ?? null,
      record.lastPlanTransitionedAt
        ? toDate(record.lastPlanTransitionedAt)
        : null,
      record.lastTaxEventId ?? null,
      record.taxPolicyRef ?? null,
      record.taxJurisdiction ?? null,
      record.taxAutomaticStatus ?? null,
      record.status,
      record.version ?? 1,
      toDate(record.createdAt),
      toDate(record.updatedAt),
    ],
  );
}

/**
 * G15 fix: compare-and-swap billing-account write. The `UPDATE ... WHERE
 * billing_account_id = $1 AND version = $expected` only mutates the row when
 * the stored version still matches the version the caller read, so two
 * concurrent webhook applies for the same customer cannot both write over
 * each other (lost update). The winning write advances `version` by one;
 * `COALESCE(version, 0)` treats a pre-migration NULL as version 0. Returns
 * `true` when exactly one row was updated, `false` on a version mismatch.
 */
export async function saveBillingAccountIfVersion(
  client: PostgresQueryClient,
  record: BillingAccountRecord,
  expectedVersion: number,
): Promise<boolean> {
  const updated = await runFirst<{ billing_account_id: string }>(
    client,
    `UPDATE accounts_v1.billing_accounts SET
        subject = $2,
        provider = $3,
        stripe_customer_id = $4,
        stripe_subscription_id = $5,
        stripe_price_id = $6,
        plan_code = $7,
        current_period_end_unix = $8,
        last_invoice_id = $9,
        dunning_started_at = $10,
        next_payment_attempt_unix = $11,
        dunning_attempt_count = $12,
        dunning_action = $13,
        dunning_exhausted_at = $14,
        last_credit_event_id = $15,
        last_credit_kind = $16,
        last_credit_id = $17,
        last_credit_amount = $18,
        last_credit_currency = $19,
        last_plan_transition_event_id = $20,
        last_plan_from_code = $21,
        last_plan_to_code = $22,
        last_plan_transitioned_at = $23,
        last_tax_event_id = $24,
        tax_policy_ref = $25,
        tax_jurisdiction = $26,
        tax_automatic_status = $27,
        status = $28,
        version = $30,
        updated_at = $31
      WHERE billing_account_id = $1 AND COALESCE(version, 0) = $29
      RETURNING billing_account_id`,
    [
      record.billingAccountId,
      record.subject,
      record.provider,
      record.stripeCustomerId ?? null,
      record.stripeSubscriptionId ?? null,
      record.stripePriceId ?? null,
      record.planCode ?? null,
      record.currentPeriodEndUnix ?? null,
      record.lastInvoiceId ?? null,
      record.dunningStartedAt ? toDate(record.dunningStartedAt) : null,
      record.nextPaymentAttemptUnix ?? null,
      record.dunningAttemptCount ?? null,
      record.dunningAction ?? null,
      record.dunningExhaustedAt ? toDate(record.dunningExhaustedAt) : null,
      record.lastCreditEventId ?? null,
      record.lastCreditKind ?? null,
      record.lastCreditId ?? null,
      record.lastCreditAmount ?? null,
      record.lastCreditCurrency ?? null,
      record.lastPlanTransitionEventId ?? null,
      record.lastPlanFromCode ?? null,
      record.lastPlanToCode ?? null,
      record.lastPlanTransitionedAt
        ? toDate(record.lastPlanTransitionedAt)
        : null,
      record.lastTaxEventId ?? null,
      record.taxPolicyRef ?? null,
      record.taxJurisdiction ?? null,
      record.taxAutomaticStatus ?? null,
      record.status,
      expectedVersion,
      expectedVersion + 1,
      toDate(record.updatedAt),
    ],
  );
  return updated !== undefined;
}

export async function findBillingAccount(
  client: PostgresQueryClient,
  billingAccountId: string,
): Promise<BillingAccountRecord | undefined> {
  const row = await runFirst<BillingAccountRow>(
    client,
    billingAccountSelect("billing_account_id = $1"),
    [billingAccountId],
  );
  return row ? billingAccountFromRow(row) : undefined;
}

export async function findBillingAccountForSubject(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<BillingAccountRecord | undefined> {
  const row = await runFirst<BillingAccountRow>(
    client,
    billingAccountSelect("subject = $1"),
    [subject],
  );
  return row ? billingAccountFromRow(row) : undefined;
}

export async function findBillingAccountByStripeCustomerId(
  client: PostgresQueryClient,
  stripeCustomerId: string,
): Promise<BillingAccountRecord | undefined> {
  const row = await runFirst<BillingAccountRow>(
    client,
    billingAccountSelect("stripe_customer_id = $1"),
    [stripeCustomerId],
  );
  return row ? billingAccountFromRow(row) : undefined;
}

export async function saveBillingWebhookEvent(
  client: PostgresQueryClient,
  record: BillingWebhookEventRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.billing_webhook_events (
        event_id, event_type, status, received_at, updated_at, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (event_id) DO UPDATE SET
        event_type = EXCLUDED.event_type,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        error_message = EXCLUDED.error_message`,
    [
      record.eventId,
      record.eventType,
      record.status,
      toDate(record.receivedAt),
      toDate(record.updatedAt),
      record.errorMessage ?? null,
    ],
  );
}

export async function findBillingWebhookEvent(
  client: PostgresQueryClient,
  eventId: string,
): Promise<BillingWebhookEventRecord | undefined> {
  const row = await runFirst<BillingWebhookEventRow>(
    client,
    `SELECT event_id, event_type, status, received_at, updated_at, error_message
       FROM accounts_v1.billing_webhook_events
       WHERE event_id = $1`,
    [eventId],
  );
  return row ? billingWebhookEventFromRow(row) : undefined;
}

/**
 * Atomic webhook event claim.
 *
 * Implemented with a single `INSERT ... ON CONFLICT (event_id) DO NOTHING
 * RETURNING ...` so that two concurrent webhook deliveries cannot both observe
 * "row missing" and double-process the same Stripe event. If the insert wins,
 * we get the row back via RETURNING. If the row already exists, we issue a
 * second SELECT for the existing record so the caller can read its status.
 */
export async function claimBillingWebhookEvent(
  client: PostgresQueryClient,
  record: BillingWebhookEventRecord,
): Promise<BillingWebhookEventClaimResult> {
  const inserted = await runFirst<BillingWebhookEventRow>(
    client,
    `INSERT INTO accounts_v1.billing_webhook_events (
        event_id, event_type, status, received_at, updated_at, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id, event_type, status, received_at, updated_at, error_message`,
    [
      record.eventId,
      record.eventType,
      record.status,
      toDate(record.receivedAt),
      toDate(record.updatedAt),
      record.errorMessage ?? null,
    ],
  );
  if (inserted) {
    return { inserted: true };
  }
  const existing = await findBillingWebhookEvent(client, record.eventId);
  if (!existing) {
    // Should not happen under normal circumstances - the conflict implies the
    // row exists - but a concurrent delete (admin cleanup) is theoretically
    // possible. Treat as a fresh claim so the webhook is processed.
    return { inserted: true };
  }
  return { inserted: false, existing };
}

export async function saveBillingUsageRecord(
  client: PostgresQueryClient,
  record: BillingUsageRecord,
): Promise<void> {
  // Atomic conditional upsert: the previous check-then-act (findBillingUsageRecord
  // then INSERT ... ON CONFLICT) raced — two concurrent reports for the same
  // usageReportId could both pass the read and the second's DO UPDATE would
  // tamper with the first's quantity/meter while the owner columns silently
  // stayed put. The guard now lives in SQL: the DO UPDATE only fires when the
  // EXISTING row's (installation_id, billing_account_id) already match the
  // incoming report. A cross-owner conflict matches the conflict target but
  // not the WHERE, so the statement affects 0 rows and RETURNING yields
  // nothing — which we surface as the ownership error rather than a silent
  // partial overwrite.
  const result = await runFirst<{ usage_report_id: string }>(
    client,
    `INSERT INTO accounts_v1.billing_usage_records (
        usage_report_id, installation_id, billing_account_id, meter, quantity,
        unit, period_start, period_end, idempotency_key, request_digest, metadata,
        reported_by_subject, reported_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (usage_report_id) DO UPDATE SET
        meter = EXCLUDED.meter,
        quantity = EXCLUDED.quantity,
        unit = EXCLUDED.unit,
        period_start = EXCLUDED.period_start,
        period_end = EXCLUDED.period_end,
        idempotency_key = EXCLUDED.idempotency_key,
        request_digest = EXCLUDED.request_digest,
        metadata = EXCLUDED.metadata,
        reported_by_subject = EXCLUDED.reported_by_subject,
        reported_at = EXCLUDED.reported_at
      WHERE accounts_v1.billing_usage_records.installation_id
          = EXCLUDED.installation_id
        AND accounts_v1.billing_usage_records.billing_account_id
          = EXCLUDED.billing_account_id
      RETURNING usage_report_id`,
    [
      record.usageReportId,
      record.installationId,
      record.billingAccountId,
      record.meter,
      record.quantity,
      record.unit,
      record.periodStart === undefined ? null : toDate(record.periodStart),
      record.periodEnd === undefined ? null : toDate(record.periodEnd),
      record.idempotencyKey ?? null,
      record.requestDigest,
      json(record.metadata),
      record.reportedBySubject ?? null,
      toDate(record.reportedAt),
    ],
  );
  if (result === undefined) {
    // 0 rows affected: the row exists but is owned by a different
    // installation / billing account, so the conditional UPDATE did not fire.
    throw new TypeError(
      "billing usage report id is already owned by another installation",
    );
  }
}

export async function findBillingUsageRecord(
  client: PostgresQueryClient,
  usageReportId: string,
): Promise<BillingUsageRecord | undefined> {
  const row = await runFirst<BillingUsageRow>(
    client,
    billingUsageSelect("usage_report_id = $1"),
    [usageReportId],
  );
  return row ? billingUsageFromRow(row) : undefined;
}

export async function listBillingUsageRecordsForInstallation(
  client: PostgresQueryClient,
  installationId: string,
): Promise<readonly BillingUsageRecord[]> {
  const rows = await runRows<BillingUsageRow>(
    client,
    billingUsageSelect("installation_id = $1") +
      " ORDER BY reported_at, usage_report_id",
    [installationId],
  );
  return rows.map(billingUsageFromRow);
}
