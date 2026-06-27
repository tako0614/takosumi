// Billing accounts, Stripe webhook event ledger, and metered usage records.
// Free-function module that preserves the SQL and uniqueness checks from
// the original PostgresAccountsStore.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  doublePrecision,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  BillingAccountRecord,
  BillingUsageExportMark,
  BillingUsageRecord,
  BillingWebhookEventClaimResult,
  BillingWebhookEventRecord,
} from "../store.ts";
import {
  billingAccountFromRow,
  type BillingAccountRow,
  billingUsageFromRow,
  type BillingUsageRow,
  billingWebhookEventFromRow,
  type BillingWebhookEventRow,
  postgresDrizzle,
  type PostgresQueryClient,
  toDate,
} from "./internal.ts";

const accounts = pgSchema("accounts_v1");

const billingAccounts = accounts.table("billing_accounts", {
  billingAccountId: text("billing_account_id").primaryKey(),
  subject: text("subject").notNull(),
  provider: text("provider").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  planCode: text("plan_code"),
  currentPeriodEndUnix: integer("current_period_end_unix"),
  lastInvoiceId: text("last_invoice_id"),
  dunningStartedAt: timestamp("dunning_started_at", { mode: "date" }),
  nextPaymentAttemptUnix: integer("next_payment_attempt_unix"),
  dunningAttemptCount: integer("dunning_attempt_count"),
  dunningAction: text("dunning_action"),
  dunningExhaustedAt: timestamp("dunning_exhausted_at", { mode: "date" }),
  lastCreditEventId: text("last_credit_event_id"),
  lastCreditKind: text("last_credit_kind"),
  lastCreditId: text("last_credit_id"),
  lastCreditAmount: integer("last_credit_amount"),
  lastCreditCurrency: text("last_credit_currency"),
  lastPlanTransitionEventId: text("last_plan_transition_event_id"),
  lastPlanFromCode: text("last_plan_from_code"),
  lastPlanToCode: text("last_plan_to_code"),
  lastPlanTransitionedAt: timestamp("last_plan_transitioned_at", {
    mode: "date",
  }),
  lastTaxEventId: text("last_tax_event_id"),
  taxPolicyRef: text("tax_policy_ref"),
  taxJurisdiction: text("tax_jurisdiction"),
  taxAutomaticStatus: text("tax_automatic_status"),
  status: text("status").notNull(),
  version: integer("version"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

const billingWebhookEvents = accounts.table("billing_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  status: text("status").notNull(),
  receivedAt: timestamp("received_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  errorMessage: text("error_message"),
});

const billingUsageRecords = accounts.table("billing_usage_records", {
  usageReportId: text("usage_report_id").primaryKey(),
  installationId: text("installation_id").notNull(),
  billingAccountId: text("billing_account_id").notNull(),
  meter: text("meter").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit").notNull(),
  periodStart: timestamp("period_start", { mode: "date" }),
  periodEnd: timestamp("period_end", { mode: "date" }),
  idempotencyKey: text("idempotency_key"),
  requestDigest: text("request_digest").notNull(),
  metadata: jsonb("metadata").notNull(),
  reportedBySubject: text("reported_by_subject"),
  reportedAt: timestamp("reported_at", { mode: "date" }).notNull(),
  billingExportProvider: text("billing_export_provider"),
  billingExportId: text("billing_export_id"),
  billingExportReference: text("billing_export_reference"),
  billingExportedAt: timestamp("billing_exported_at", { mode: "date" }),
});

const billingSchema = {
  billingAccounts,
  billingWebhookEvents,
  billingUsageRecords,
};

export async function saveBillingAccount(
  client: PostgresQueryClient,
  record: BillingAccountRecord,
): Promise<void> {
  const values = billingAccountValues(record);
  await postgresDrizzle(client, billingSchema)
    .insert(billingAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: billingAccounts.billingAccountId,
      set: billingAccountUpdateSet(values),
    });
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
  const values = billingAccountValues(record);
  const updated = await postgresDrizzle(client, billingSchema)
    .update(billingAccounts)
    .set({
      ...billingAccountUpdateSet(values),
      version: expectedVersion + 1,
    })
    .where(
      and(
        eq(billingAccounts.billingAccountId, record.billingAccountId),
        eq(sql`COALESCE(${billingAccounts.version}, 0)`, expectedVersion),
      ),
    )
    .returning({ billing_account_id: billingAccounts.billingAccountId });
  return updated[0] !== undefined;
}

export async function findBillingAccount(
  client: PostgresQueryClient,
  billingAccountId: string,
): Promise<BillingAccountRecord | undefined> {
  const row = await billingAccountFirst(
    client,
    eq(billingAccounts.billingAccountId, billingAccountId),
  );
  return row ? billingAccountFromRow(row) : undefined;
}

export async function findBillingAccountForSubject(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<BillingAccountRecord | undefined> {
  const row = await billingAccountFirst(
    client,
    eq(billingAccounts.subject, subject),
  );
  return row ? billingAccountFromRow(row) : undefined;
}

export async function findBillingAccountByStripeCustomerId(
  client: PostgresQueryClient,
  stripeCustomerId: string,
): Promise<BillingAccountRecord | undefined> {
  const row = await billingAccountFirst(
    client,
    eq(billingAccounts.stripeCustomerId, stripeCustomerId),
  );
  return row ? billingAccountFromRow(row) : undefined;
}

export async function saveBillingWebhookEvent(
  client: PostgresQueryClient,
  record: BillingWebhookEventRecord,
): Promise<void> {
  const values = billingWebhookEventValues(record);
  await postgresDrizzle(client, billingSchema)
    .insert(billingWebhookEvents)
    .values(values)
    .onConflictDoUpdate({
      target: billingWebhookEvents.eventId,
      set: {
        eventType: values.eventType,
        status: values.status,
        updatedAt: values.updatedAt,
        errorMessage: values.errorMessage,
      },
    });
}

export async function findBillingWebhookEvent(
  client: PostgresQueryClient,
  eventId: string,
): Promise<BillingWebhookEventRecord | undefined> {
  const row = await postgresDrizzle(client, billingSchema)
    .select(billingWebhookEventColumns)
    .from(billingWebhookEvents)
    .where(eq(billingWebhookEvents.eventId, eventId))
    .limit(1)
    .then((rows) => rows[0] as BillingWebhookEventRow | undefined);
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
  const inserted = await postgresDrizzle(client, billingSchema)
    .insert(billingWebhookEvents)
    .values(billingWebhookEventValues(record))
    .onConflictDoNothing({ target: billingWebhookEvents.eventId })
    .returning(billingWebhookEventColumns)
    .then((rows) => rows[0] as BillingWebhookEventRow | undefined);
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
  const values = billingUsageValues(record);
  const result = await postgresDrizzle(client, billingSchema)
    .insert(billingUsageRecords)
    .values(values)
    .onConflictDoUpdate({
      target: billingUsageRecords.usageReportId,
      set: {
        meter: values.meter,
        quantity: values.quantity,
        unit: values.unit,
        periodStart: values.periodStart,
        periodEnd: values.periodEnd,
        idempotencyKey: values.idempotencyKey,
        requestDigest: values.requestDigest,
        metadata: values.metadata,
        reportedBySubject: values.reportedBySubject,
        reportedAt: values.reportedAt,
      },
      where: and(
        eq(billingUsageRecords.installationId, values.installationId),
        eq(billingUsageRecords.billingAccountId, values.billingAccountId),
      ),
    })
    .returning({ usage_report_id: billingUsageRecords.usageReportId });
  if (result[0] === undefined) {
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
  const row = await postgresDrizzle(client, billingSchema)
    .select(billingUsageColumns)
    .from(billingUsageRecords)
    .where(eq(billingUsageRecords.usageReportId, usageReportId))
    .limit(1)
    .then((rows) => rows[0] as BillingUsageRow | undefined);
  return row ? billingUsageFromRow(row) : undefined;
}

export async function listBillingUsageRecordsForInstallation(
  client: PostgresQueryClient,
  installationId: string,
): Promise<readonly BillingUsageRecord[]> {
  const rows = (await postgresDrizzle(client, billingSchema)
    .select(billingUsageColumns)
    .from(billingUsageRecords)
    .where(eq(billingUsageRecords.installationId, installationId))
    .orderBy(
      asc(billingUsageRecords.reportedAt),
      asc(billingUsageRecords.usageReportId),
    )) as BillingUsageRow[];
  return rows.map(billingUsageFromRow);
}

export async function listBillingUsageRecordsForBillingAccount(
  client: PostgresQueryClient,
  billingAccountId: string,
): Promise<readonly BillingUsageRecord[]> {
  const rows = (await postgresDrizzle(client, billingSchema)
    .select(billingUsageColumns)
    .from(billingUsageRecords)
    .where(eq(billingUsageRecords.billingAccountId, billingAccountId))
    .orderBy(
      asc(billingUsageRecords.reportedAt),
      asc(billingUsageRecords.usageReportId),
    )) as BillingUsageRow[];
  return rows.map(billingUsageFromRow);
}

export async function markBillingUsageRecordsExported(
  client: PostgresQueryClient,
  mark: BillingUsageExportMark,
): Promise<void> {
  if (mark.usageReportIds.length === 0) return;
  const rows = (await postgresDrizzle(client, billingSchema)
    .select(billingUsageColumns)
    .from(billingUsageRecords)
    .where(inArray(billingUsageRecords.usageReportId, [...mark.usageReportIds]))
    .orderBy(
      asc(billingUsageRecords.reportedAt),
      asc(billingUsageRecords.usageReportId),
    )) as BillingUsageRow[];
  const records = rows.map(billingUsageFromRow);
  const recordsById = new Map(
    records.map((record) => [record.usageReportId, record]),
  );
  for (const usageReportId of mark.usageReportIds) {
    const record = recordsById.get(usageReportId);
    if (!record) {
      throw new TypeError("billing usage report was not found");
    }
    if (record.billingAccountId !== mark.billingAccountId) {
      throw new TypeError(
        "billing usage report is owned by another billing account",
      );
    }
    if (
      record.billingExportId &&
      (record.billingExportProvider !== mark.provider ||
        record.billingExportId !== mark.exportId ||
        record.billingExportReference !== mark.exportReference)
    ) {
      throw new TypeError("billing usage report was already exported");
    }
  }
  await postgresDrizzle(client, billingSchema)
    .update(billingUsageRecords)
    .set({
      billingExportProvider: mark.provider,
      billingExportId: mark.exportId,
      billingExportReference: mark.exportReference,
      billingExportedAt: toDate(mark.exportedAt),
    })
    .where(
      and(
        eq(billingUsageRecords.billingAccountId, mark.billingAccountId),
        inArray(billingUsageRecords.usageReportId, [...mark.usageReportIds]),
      ),
    );
}

const billingAccountColumns = {
  billing_account_id: billingAccounts.billingAccountId,
  subject: billingAccounts.subject,
  provider: billingAccounts.provider,
  stripe_customer_id: billingAccounts.stripeCustomerId,
  stripe_subscription_id: billingAccounts.stripeSubscriptionId,
  stripe_price_id: billingAccounts.stripePriceId,
  plan_code: billingAccounts.planCode,
  current_period_end_unix: billingAccounts.currentPeriodEndUnix,
  last_invoice_id: billingAccounts.lastInvoiceId,
  dunning_started_at: billingAccounts.dunningStartedAt,
  next_payment_attempt_unix: billingAccounts.nextPaymentAttemptUnix,
  dunning_attempt_count: billingAccounts.dunningAttemptCount,
  dunning_action: billingAccounts.dunningAction,
  dunning_exhausted_at: billingAccounts.dunningExhaustedAt,
  last_credit_event_id: billingAccounts.lastCreditEventId,
  last_credit_kind: billingAccounts.lastCreditKind,
  last_credit_id: billingAccounts.lastCreditId,
  last_credit_amount: billingAccounts.lastCreditAmount,
  last_credit_currency: billingAccounts.lastCreditCurrency,
  last_plan_transition_event_id: billingAccounts.lastPlanTransitionEventId,
  last_plan_from_code: billingAccounts.lastPlanFromCode,
  last_plan_to_code: billingAccounts.lastPlanToCode,
  last_plan_transitioned_at: billingAccounts.lastPlanTransitionedAt,
  last_tax_event_id: billingAccounts.lastTaxEventId,
  tax_policy_ref: billingAccounts.taxPolicyRef,
  tax_jurisdiction: billingAccounts.taxJurisdiction,
  tax_automatic_status: billingAccounts.taxAutomaticStatus,
  status: billingAccounts.status,
  version: billingAccounts.version,
  created_at: billingAccounts.createdAt,
  updated_at: billingAccounts.updatedAt,
};

const billingWebhookEventColumns = {
  event_id: billingWebhookEvents.eventId,
  event_type: billingWebhookEvents.eventType,
  status: billingWebhookEvents.status,
  received_at: billingWebhookEvents.receivedAt,
  updated_at: billingWebhookEvents.updatedAt,
  error_message: billingWebhookEvents.errorMessage,
};

const billingUsageColumns = {
  usage_report_id: billingUsageRecords.usageReportId,
  installation_id: billingUsageRecords.installationId,
  billing_account_id: billingUsageRecords.billingAccountId,
  meter: billingUsageRecords.meter,
  quantity: billingUsageRecords.quantity,
  unit: billingUsageRecords.unit,
  period_start: billingUsageRecords.periodStart,
  period_end: billingUsageRecords.periodEnd,
  idempotency_key: billingUsageRecords.idempotencyKey,
  request_digest: billingUsageRecords.requestDigest,
  metadata: billingUsageRecords.metadata,
  reported_by_subject: billingUsageRecords.reportedBySubject,
  reported_at: billingUsageRecords.reportedAt,
  billing_export_provider: billingUsageRecords.billingExportProvider,
  billing_export_id: billingUsageRecords.billingExportId,
  billing_export_reference: billingUsageRecords.billingExportReference,
  billing_exported_at: billingUsageRecords.billingExportedAt,
};

async function billingAccountFirst(
  client: PostgresQueryClient,
  where: unknown,
): Promise<BillingAccountRow | undefined> {
  return await postgresDrizzle(client, billingSchema)
    .select(billingAccountColumns)
    .from(billingAccounts)
    .where(where as never)
    .limit(1)
    .then((rows) => rows[0] as BillingAccountRow | undefined);
}

function billingAccountValues(record: BillingAccountRecord) {
  return {
    billingAccountId: record.billingAccountId,
    subject: record.subject,
    provider: record.provider,
    stripeCustomerId: record.stripeCustomerId ?? null,
    stripeSubscriptionId: record.stripeSubscriptionId ?? null,
    stripePriceId: record.stripePriceId ?? null,
    planCode: record.planCode ?? null,
    currentPeriodEndUnix: record.currentPeriodEndUnix ?? null,
    lastInvoiceId: record.lastInvoiceId ?? null,
    dunningStartedAt: record.dunningStartedAt
      ? toDate(record.dunningStartedAt)
      : null,
    nextPaymentAttemptUnix: record.nextPaymentAttemptUnix ?? null,
    dunningAttemptCount: record.dunningAttemptCount ?? null,
    dunningAction: record.dunningAction ?? null,
    dunningExhaustedAt: record.dunningExhaustedAt
      ? toDate(record.dunningExhaustedAt)
      : null,
    lastCreditEventId: record.lastCreditEventId ?? null,
    lastCreditKind: record.lastCreditKind ?? null,
    lastCreditId: record.lastCreditId ?? null,
    lastCreditAmount: record.lastCreditAmount ?? null,
    lastCreditCurrency: record.lastCreditCurrency ?? null,
    lastPlanTransitionEventId: record.lastPlanTransitionEventId ?? null,
    lastPlanFromCode: record.lastPlanFromCode ?? null,
    lastPlanToCode: record.lastPlanToCode ?? null,
    lastPlanTransitionedAt: record.lastPlanTransitionedAt
      ? toDate(record.lastPlanTransitionedAt)
      : null,
    lastTaxEventId: record.lastTaxEventId ?? null,
    taxPolicyRef: record.taxPolicyRef ?? null,
    taxJurisdiction: record.taxJurisdiction ?? null,
    taxAutomaticStatus: record.taxAutomaticStatus ?? null,
    status: record.status,
    version: record.version ?? 1,
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}

function billingAccountUpdateSet(
  values: ReturnType<typeof billingAccountValues>,
) {
  return {
    subject: values.subject,
    provider: values.provider,
    stripeCustomerId: values.stripeCustomerId,
    stripeSubscriptionId: values.stripeSubscriptionId,
    stripePriceId: values.stripePriceId,
    planCode: values.planCode,
    currentPeriodEndUnix: values.currentPeriodEndUnix,
    lastInvoiceId: values.lastInvoiceId,
    dunningStartedAt: values.dunningStartedAt,
    nextPaymentAttemptUnix: values.nextPaymentAttemptUnix,
    dunningAttemptCount: values.dunningAttemptCount,
    dunningAction: values.dunningAction,
    dunningExhaustedAt: values.dunningExhaustedAt,
    lastCreditEventId: values.lastCreditEventId,
    lastCreditKind: values.lastCreditKind,
    lastCreditId: values.lastCreditId,
    lastCreditAmount: values.lastCreditAmount,
    lastCreditCurrency: values.lastCreditCurrency,
    lastPlanTransitionEventId: values.lastPlanTransitionEventId,
    lastPlanFromCode: values.lastPlanFromCode,
    lastPlanToCode: values.lastPlanToCode,
    lastPlanTransitionedAt: values.lastPlanTransitionedAt,
    lastTaxEventId: values.lastTaxEventId,
    taxPolicyRef: values.taxPolicyRef,
    taxJurisdiction: values.taxJurisdiction,
    taxAutomaticStatus: values.taxAutomaticStatus,
    status: values.status,
    version: values.version,
    updatedAt: values.updatedAt,
  };
}

function billingWebhookEventValues(record: BillingWebhookEventRecord) {
  return {
    eventId: record.eventId,
    eventType: record.eventType,
    status: record.status,
    receivedAt: toDate(record.receivedAt),
    updatedAt: toDate(record.updatedAt),
    errorMessage: record.errorMessage ?? null,
  };
}

function billingUsageValues(record: BillingUsageRecord) {
  return {
    usageReportId: record.usageReportId,
    installationId: record.installationId,
    billingAccountId: record.billingAccountId,
    meter: record.meter,
    quantity: record.quantity,
    unit: record.unit,
    periodStart:
      record.periodStart === undefined ? null : toDate(record.periodStart),
    periodEnd: record.periodEnd === undefined ? null : toDate(record.periodEnd),
    idempotencyKey: record.idempotencyKey ?? null,
    requestDigest: record.requestDigest,
    metadata: record.metadata,
    reportedBySubject: record.reportedBySubject ?? null,
    reportedAt: toDate(record.reportedAt),
    billingExportProvider: record.billingExportProvider ?? null,
    billingExportId: record.billingExportId ?? null,
    billingExportReference: record.billingExportReference ?? null,
    billingExportedAt:
      record.billingExportedAt === undefined
        ? null
        : toDate(record.billingExportedAt),
  };
}
