import type {
  AccountsStore,
  BillingAccountRecord,
  BillingAccountStatus,
} from "./store.ts";
import {
  buildInstallationEvent,
  type InstallationEventRecord,
  transitionAppInstallationStatus,
} from "./ledger.ts";
import {
  normalizeStripeBillingEvent,
  type StripeBillingEvent,
  type StripeWebhookEvent,
} from "./billing-events.ts";
import { sha256HexText } from "./encoding.ts";

/**
 * Derive a BillingAccount id deterministically from the owning subject so
 * concurrent creators for the same subject converge on a single id (see the
 * create path in `applyBillingMutation`). Stable, collision-resistant, and
 * never reuses a random id per webhook delivery.
 */
async function deriveBillingAccountId(subject: string): Promise<string> {
  const digest = await sha256HexText(`takosumi-billing-account:${subject}`);
  // `sha256HexText` returns a `sha256:<hex>` prefix; keep only the hex.
  return `bill_${digest.slice("sha256:".length)}`;
}

/**
 * Resolves the Stripe customer id behind a dispute when the webhook payload did
 * not inline one. Real `charge.dispute.*` events carry `charge` /
 * `payment_intent` only as string ids, so the owner must be recovered by
 * dereferencing one of them (e.g. a Stripe `charges.retrieve` /
 * `payment_intents.retrieve` with the customer expanded). Returns `undefined`
 * when the link cannot be resolved; the caller then fails the event closed
 * (Stripe retries) rather than silently dropping the chargeback freeze.
 */
export type StripeDisputeCustomerResolver = (input: {
  disputeId: string;
  chargeId?: string;
  paymentIntentId?: string;
}) => string | undefined | Promise<string | undefined>;

export interface ApplyStripeBillingEventInput {
  store: AccountsStore;
  event: StripeWebhookEvent;
  now?: number;
  /**
   * Resolves the dispute owner's Stripe customer id when the webhook lacks a
   * top-level `customer`. Required for production dispute handling; when absent
   * a dispute that cannot be linked inline fails closed.
   */
  resolveDisputeCustomerId?: StripeDisputeCustomerResolver;
}

export type ApplyStripeBillingEventResult =
  | {
      applied: true;
      billingAccount: BillingAccountRecord;
      entitlementReconciliation: BillingEntitlementReconciliationResult;
    }
  | {
      applied: false;
      reason: string;
    };

export interface BillingEntitlementReconciliationResult {
  billingAccountId: string;
  billingStatus: BillingAccountStatus;
  suspendedInstallationIds: readonly string[];
  restoredInstallationIds: readonly string[];
  unchangedInstallationIds: readonly string[];
}

/**
 * G15 fix: bound on the optimistic-concurrency retry. Each attempt re-reads
 * the BillingAccount and re-applies the SAME webhook event's mutation against
 * the fresh record, then conditionally writes it with a version guard. A
 * version mismatch means a different concurrent webhook event advanced the
 * row between our read and write, so we retry. The retry count only needs to
 * exceed the realistic concurrent-applies-per-customer fan-out (Stripe
 * delivers a handful of related events at once), so a small bound is safe.
 */
const BILLING_APPLY_MAX_ATTEMPTS = 5;

/**
 * A pure mutation that derives the next BillingAccount state from the freshly
 * re-read record. It MUST be idempotent over re-reads: re-running it against a
 * record that already incorporates a concurrent writer's field updates must
 * still produce this event's intended change without depending on whether the
 * previous attempt's write landed.
 */
type BillingAccountMutation = (
  existing: BillingAccountRecord,
) => BillingAccountRecord;

export async function applyStripeBillingEvent(
  input: ApplyStripeBillingEventInput,
): Promise<ApplyStripeBillingEventResult> {
  const normalized = normalizeStripeBillingEvent(input.event);
  const now = input.now ?? Date.now();

  if (normalized.kind === "unhandled") {
    return { applied: false, reason: "unhandled_event" };
  }

  if (normalized.kind === "checkout_completed") {
    if (!normalized.subject || !normalized.customerId) {
      return { applied: false, reason: "missing_checkout_owner" };
    }
    const account = await input.store.findAccount(normalized.subject);
    if (!account) return { applied: false, reason: "unknown_account" };
    const customerId = normalized.customerId;
    const subject = normalized.subject;
    // Derive the BillingAccount id deterministically from the subject so two
    // concurrent `checkout.session.completed` events for the same subject mint
    // the SAME id. Combined with the version-CAS create below, this turns the
    // create into an insert-if-not-exists keyed by subject instead of a
    // read-then-write race that could orphan a duplicate `bill_<uuid>`.
    const billingAccountId = await deriveBillingAccountId(subject);

    return await applyBillingMutation({
      store: input.store,
      now,
      read: () => input.store.findBillingAccountForSubject(subject),
      // checkout_completed may create the BillingAccount, so a missing record
      // is not an error here: synthesize a fresh one keyed by the
      // subject-derived id.
      onMissing: "create",
      newRecord: (): BillingAccountRecord => ({
        billingAccountId,
        subject,
        provider: "stripe",
        stripeCustomerId: customerId,
        stripeSubscriptionId: normalized.subscriptionId,
        stripePriceId: normalized.stripePriceId,
        planCode: normalized.planCode,
        status: checkoutStatus(normalized),
        createdAt: now,
        updatedAt: now,
      }),
      mutate: (existing): BillingAccountRecord => ({
        ...existing,
        stripeCustomerId: customerId,
        stripeSubscriptionId:
          normalized.subscriptionId ?? existing.stripeSubscriptionId,
        stripePriceId: normalized.stripePriceId ?? existing.stripePriceId,
        planCode: normalized.planCode ?? existing.planCode,
        status: checkoutStatus(normalized),
        updatedAt: now,
      }),
    });
  }

  // Dispute events (`charge.dispute.created` / `.closed`) usually arrive
  // without a top-level `customer`; the owner must be resolved from the
  // `charge` / `payment_intent` string id before we can key the mutation.
  let customerId: string | undefined = normalized.customerId;
  if (
    !customerId &&
    (normalized.kind === "dispute_opened" ||
      normalized.kind === "dispute_closed")
  ) {
    customerId = await input.resolveDisputeCustomerId?.({
      disputeId: normalized.disputeId,
      chargeId: normalized.chargeId,
      paymentIntentId: normalized.paymentIntentId,
    });
    if (!customerId) {
      // Fail closed: we could not link this chargeback to a BillingAccount, so
      // we must NOT silently drop it (that would skip the entitlement freeze).
      // Returning a non-`unhandled` reason records the event as `failed`, which
      // keeps Stripe retrying until the dispute can be resolved.
      return { applied: false, reason: "unresolved_dispute_customer" };
    }
  }

  if (!customerId) {
    // Every non-dispute customer-keyed event normalizes with a concrete
    // `customerId`; reaching here would be a normalization defect.
    return { applied: false, reason: "unknown_customer" };
  }

  const resolvedCustomerId = customerId;
  const mutation = customerKeyedMutation(normalized, now);
  return await applyBillingMutation({
    store: input.store,
    now,
    read: () =>
      input.store.findBillingAccountByStripeCustomerId(resolvedCustomerId),
    onMissing: "unknown_customer",
    mutate: mutation,
  });
}

/**
 * Builds the mutation for the customer-keyed events (every kind except
 * `checkout_completed` / `unhandled`). The mutation closes over `normalized`
 * and `now` and is replayed against the freshly re-read record on each retry.
 */
function customerKeyedMutation(
  normalized: Exclude<
    StripeBillingEvent,
    { kind: "checkout_completed" } | { kind: "unhandled" }
  >,
  now: number,
): BillingAccountMutation {
  if (normalized.kind === "credit_recorded") {
    return (existing) => ({
      ...existing,
      lastCreditEventId: normalized.eventId,
      lastCreditKind: normalized.creditKind,
      lastCreditId: normalized.creditId,
      lastCreditAmount: normalized.amount ?? existing.lastCreditAmount,
      lastCreditCurrency: normalized.currency ?? existing.lastCreditCurrency,
      updatedAt: now,
    });
  }

  if (normalized.kind === "tax_policy_recorded") {
    return (existing) => ({
      ...existing,
      lastInvoiceId: normalized.invoiceId ?? existing.lastInvoiceId,
      lastTaxEventId: normalized.eventId,
      taxPolicyRef: normalized.taxPolicyRef ?? existing.taxPolicyRef,
      taxJurisdiction: normalized.taxJurisdiction ?? existing.taxJurisdiction,
      taxAutomaticStatus:
        normalized.taxAutomaticStatus ?? existing.taxAutomaticStatus,
      updatedAt: now,
    });
  }

  if (normalized.kind === "invoice_dunning_updated") {
    return (existing) => ({
      ...existing,
      lastInvoiceId: normalized.invoiceId ?? existing.lastInvoiceId,
      dunningStartedAt: existing.dunningStartedAt ?? now,
      nextPaymentAttemptUnix:
        normalized.nextPaymentAttemptUnix ?? existing.nextPaymentAttemptUnix,
      dunningAttemptCount:
        normalized.attemptCount ?? existing.dunningAttemptCount,
      dunningAction: "retry_scheduled",
      updatedAt: now,
    });
  }

  if (normalized.kind === "dispute_opened") {
    // A chargeback opens an entitlement freeze. We snapshot the pre-dispute
    // status so the eventual `charge.dispute.closed` (won) can restore it,
    // and route the BillingAccount into the local `disputed` status. The
    // `disputed` status is treated as suspend-worthy by `shouldSuspendForBilling`.
    return (existing) => ({
      ...existing,
      preDisputeStatus:
        existing.status === "disputed"
          ? existing.preDisputeStatus
          : existing.status,
      activeDispute: {
        disputeId: normalized.disputeId,
        chargeId: normalized.chargeId,
        reason: normalized.reason,
        status: normalized.status,
        openedAt: normalized.openedAtUnix
          ? normalized.openedAtUnix * 1000
          : now,
      },
      status: "disputed",
      updatedAt: now,
    });
  }

  if (normalized.kind === "dispute_closed") {
    // Stripe `dispute.status` after close is one of `won`, `lost`,
    // `warning_closed`. Restore the pre-dispute status only when the dispute
    // resolves in the merchant's favour (or merely as a warning) - otherwise
    // we keep the account in a recoverable state without auto-reactivating
    // entitlements. Operators can override via the dashboard.
    const outcome = normalized.status;
    const restorable = outcome === "won" || outcome === "warning_closed";
    return (existing) => ({
      ...existing,
      activeDispute: existing.activeDispute
        ? {
            ...existing.activeDispute,
            status: outcome ?? existing.activeDispute.status,
            closedAt: normalized.closedAtUnix
              ? normalized.closedAtUnix * 1000
              : now,
          }
        : undefined,
      status:
        restorable && existing.preDisputeStatus
          ? existing.preDisputeStatus
          : existing.status,
      preDisputeStatus: restorable ? undefined : existing.preDisputeStatus,
      updatedAt: now,
    });
  }

  const subscriptionLike = normalized;
  return (existing) => {
    const nextStatus = eventStatus(subscriptionLike);
    // Dunning is cleared when money arrives (`invoice_paid`) AND when a
    // `subscription_updated` recovers to a healthy status. Stripe Smart Retries
    // can move a past_due subscription back to `active` via
    // `customer.subscription.updated` without us applying a separate
    // `invoice.paid`; without this an account would show `active` while still
    // carrying stale `dunningAction: 'retry_scheduled'` / `dunningStartedAt`.
    const clearsDunning =
      subscriptionLike.kind === "invoice_paid" ||
      (subscriptionLike.kind === "subscription_updated" &&
        (nextStatus === "active" || nextStatus === "trialing"));
    const planTransition =
      subscriptionLike.kind === "subscription_updated" &&
      subscriptionLike.planCode &&
      existing.planCode &&
      subscriptionLike.planCode !== existing.planCode
        ? {
            lastPlanTransitionEventId: subscriptionLike.eventId,
            lastPlanFromCode: existing.planCode,
            lastPlanToCode: subscriptionLike.planCode,
            lastPlanTransitionedAt: now,
          }
        : {};
    return {
      ...existing,
      ...planTransition,
      status: nextStatus,
      currentPeriodEndUnix:
        subscriptionLike.kind === "invoice_paid" ||
        subscriptionLike.kind === "subscription_updated"
          ? (subscriptionLike.currentPeriodEndUnix ??
            existing.currentPeriodEndUnix)
          : subscriptionLike.kind === "subscription_canceled"
            ? undefined
            : existing.currentPeriodEndUnix,
      lastInvoiceId:
        subscriptionLike.kind === "invoice_paid" ||
        subscriptionLike.kind === "invoice_payment_failed" ||
        subscriptionLike.kind === "invoice_marked_uncollectible"
          ? (subscriptionLike.invoiceId ?? existing.lastInvoiceId)
          : existing.lastInvoiceId,
      dunningStartedAt:
        subscriptionLike.kind === "invoice_payment_failed"
          ? (existing.dunningStartedAt ?? now)
          : subscriptionLike.kind === "invoice_marked_uncollectible"
            ? (existing.dunningStartedAt ?? now)
            : clearsDunning
              ? undefined
              : existing.dunningStartedAt,
      nextPaymentAttemptUnix:
        subscriptionLike.kind === "invoice_payment_failed"
          ? (subscriptionLike.nextPaymentAttemptUnix ??
            existing.nextPaymentAttemptUnix)
          : subscriptionLike.kind === "invoice_marked_uncollectible"
            ? undefined
            : clearsDunning
              ? undefined
              : existing.nextPaymentAttemptUnix,
      dunningAttemptCount:
        subscriptionLike.kind === "invoice_payment_failed"
          ? (subscriptionLike.attemptCount ?? existing.dunningAttemptCount)
          : clearsDunning
            ? undefined
            : existing.dunningAttemptCount,
      dunningAction:
        subscriptionLike.kind === "invoice_payment_failed"
          ? "retry_scheduled"
          : subscriptionLike.kind === "invoice_marked_uncollectible"
            ? "marked_uncollectible"
            : clearsDunning
              ? undefined
              : existing.dunningAction,
      dunningExhaustedAt:
        subscriptionLike.kind === "invoice_marked_uncollectible"
          ? now
          : clearsDunning
            ? undefined
            : existing.dunningExhaustedAt,
      stripeSubscriptionId:
        subscriptionLike.kind === "subscription_canceled"
          ? undefined
          : existing.stripeSubscriptionId,
      stripePriceId:
        subscriptionLike.kind === "subscription_updated"
          ? (subscriptionLike.stripePriceId ?? existing.stripePriceId)
          : subscriptionLike.kind === "subscription_canceled"
            ? undefined
            : existing.stripePriceId,
      planCode:
        subscriptionLike.kind === "subscription_updated"
          ? (subscriptionLike.planCode ?? existing.planCode)
          : subscriptionLike.kind === "subscription_canceled"
            ? undefined
            : existing.planCode,
      lastCancellation:
        subscriptionLike.kind === "subscription_canceled"
          ? (subscriptionLike.cancellation ?? {
              canceledAt: now,
            })
          : existing.lastCancellation,
      updatedAt: now,
    };
  };
}

/**
 * G15 fix: read → mutate → conditional-save retry loop. Reads the
 * BillingAccount, applies the event's mutation, and persists it with a
 * `version` compare-and-swap. If a concurrent webhook event advanced the row
 * (CAS returns `false`), the loop re-reads the fresh record and re-applies the
 * SAME mutation so neither writer's field updates are lost.
 */
type ApplyBillingMutationInput = {
  store: AccountsStore;
  now: number;
  read: () =>
    | Promise<BillingAccountRecord | undefined>
    | (BillingAccountRecord | undefined);
  mutate: BillingAccountMutation;
} & (
  | { onMissing: "create"; newRecord: () => BillingAccountRecord }
  | { onMissing: "unknown_customer"; newRecord?: undefined }
);

async function applyBillingMutation(
  input: ApplyBillingMutationInput,
): Promise<ApplyStripeBillingEventResult> {
  for (let attempt = 0; attempt < BILLING_APPLY_MAX_ATTEMPTS; attempt++) {
    const existing = await input.read();

    if (!existing) {
      if (input.onMissing === "unknown_customer") {
        return { applied: false, reason: "unknown_customer" };
      }
      // create path (checkout_completed): seed the record via the SAME
      // version-CAS write used by the update path. The id is derived from the
      // subject, so a concurrent creator targets the same row; the CAS at
      // `expectedVersion: 0` lets only the first writer insert (version -> 1).
      // If a concurrent creator won the race, the CAS returns `false` and we
      // re-read on the next iteration, which finds the now-existing record and
      // takes the update branch instead of orphaning a duplicate account.
      const created = input.newRecord();
      const inserted = await input.store.saveBillingAccountIfVersion(
        created,
        0,
      );
      if (!inserted) continue;
      const createdRecord: BillingAccountRecord = { ...created, version: 1 };
      const entitlementReconciliation = await reconcileBillingEntitlements({
        store: input.store,
        billingAccount: createdRecord,
        now: input.now,
      });
      return {
        applied: true,
        billingAccount: createdRecord,
        entitlementReconciliation,
      };
    }

    const expectedVersion = existing.version ?? 0;
    const next = input.mutate(existing);
    const saved = await input.store.saveBillingAccountIfVersion(
      next,
      expectedVersion,
    );
    if (!saved) {
      // A concurrent different-event apply advanced the row between our read
      // and write. Re-read and re-apply this event's mutation on the fresh
      // record so its fields are not clobbered.
      continue;
    }
    const billingAccount: BillingAccountRecord = {
      ...next,
      version: expectedVersion + 1,
    };
    const entitlementReconciliation = await reconcileBillingEntitlements({
      store: input.store,
      billingAccount,
      now: input.now,
    });
    return { applied: true, billingAccount, entitlementReconciliation };
  }
  return { applied: false, reason: "billing_account_write_conflict" };
}

export async function reconcileBillingEntitlements(input: {
  store: AccountsStore;
  billingAccount: BillingAccountRecord;
  now?: number;
}): Promise<BillingEntitlementReconciliationResult> {
  const now = input.now ?? Date.now();
  const installations = await input.store.listAppInstallationsForBillingAccount(
    input.billingAccount.billingAccountId,
  );
  const suspendedInstallationIds: string[] = [];
  const restoredInstallationIds: string[] = [];
  const unchangedInstallationIds: string[] = [];

  for (const installation of installations) {
    if (
      shouldSuspendForBilling(input.billingAccount.status) &&
      installation.status === "ready"
    ) {
      const updated = transitionAppInstallationStatus(
        installation,
        "suspended",
        now,
      );
      await input.store.saveAppInstallation(updated);
      await appendBillingStatusChangeEvents({
        store: input.store,
        installationId: installation.installationId,
        from: installation.status,
        to: updated.status,
        billingAccount: input.billingAccount,
        eventType: "billing.entitlement_suspended",
        now,
      });
      suspendedInstallationIds.push(installation.installationId);
      continue;
    }

    if (
      canRestoreForBilling(input.billingAccount.status) &&
      installation.status === "suspended" &&
      wasSuspendedByBilling(
        await input.store.listInstallationEvents(installation.installationId),
      )
    ) {
      const updated = transitionAppInstallationStatus(
        installation,
        "ready",
        now,
      );
      await input.store.saveAppInstallation(updated);
      await appendBillingStatusChangeEvents({
        store: input.store,
        installationId: installation.installationId,
        from: installation.status,
        to: updated.status,
        billingAccount: input.billingAccount,
        eventType: "billing.entitlement_restored",
        now,
      });
      restoredInstallationIds.push(installation.installationId);
      continue;
    }

    unchangedInstallationIds.push(installation.installationId);
  }

  return {
    billingAccountId: input.billingAccount.billingAccountId,
    billingStatus: input.billingAccount.status,
    suspendedInstallationIds,
    restoredInstallationIds,
    unchangedInstallationIds,
  };
}

function shouldSuspendForBilling(status: BillingAccountStatus): boolean {
  return (
    status === "incomplete" ||
    status === "incomplete_expired" ||
    status === "past_due" ||
    status === "unpaid" ||
    status === "canceled" ||
    status === "paused" ||
    // Chargebacks freeze entitlements until the dispute resolves.
    status === "disputed"
  );
}

function canRestoreForBilling(status: BillingAccountStatus): boolean {
  return status === "active" || status === "trialing";
}

async function appendBillingStatusChangeEvents(input: {
  store: AccountsStore;
  installationId: string;
  from: string;
  to: string;
  billingAccount: BillingAccountRecord;
  eventType: "billing.entitlement_suspended" | "billing.entitlement_restored";
  now: number;
}): Promise<void> {
  await appendInstallationEvent(input.store, {
    installationId: input.installationId,
    eventType: "installation.status_changed",
    payload: {
      from: input.from,
      to: input.to,
      reason: `billing:${input.billingAccount.status}`,
      billingAccountId: input.billingAccount.billingAccountId,
      billingStatus: input.billingAccount.status,
    },
    now: input.now,
  });
  await appendInstallationEvent(input.store, {
    installationId: input.installationId,
    eventType: input.eventType,
    payload: {
      from: input.from,
      to: input.to,
      billingAccountId: input.billingAccount.billingAccountId,
      billingStatus: input.billingAccount.status,
    },
    now: input.now,
  });
}

async function appendInstallationEvent(
  store: AccountsStore,
  input: {
    installationId: string;
    eventType: string;
    payload: Record<string, unknown>;
    now: number;
  },
): Promise<InstallationEventRecord> {
  const previousEventHash = (
    await store.listInstallationEvents(input.installationId)
  ).at(-1)?.eventHash;
  const event = await buildInstallationEvent({
    installationId: input.installationId,
    eventType: input.eventType,
    payload: input.payload,
    previousEventHash,
    createdAt: input.now,
  });
  await store.appendInstallationEvent(event);
  return event;
}

function wasSuspendedByBilling(
  events: readonly InstallationEventRecord[],
): boolean {
  const lastStatusChange = [...events]
    .reverse()
    .find((event) => event.eventType === "installation.status_changed");
  return (
    lastStatusChange?.payload.to === "suspended" &&
    typeof lastStatusChange.payload.reason === "string" &&
    lastStatusChange.payload.reason.startsWith("billing:")
  );
}

function checkoutStatus(
  event: Extract<StripeBillingEvent, { kind: "checkout_completed" }>,
): BillingAccountStatus {
  if (
    event.paymentStatus === "paid" ||
    event.paymentStatus === "no_payment_required" ||
    event.subscriptionId
  ) {
    return "active";
  }
  return "incomplete";
}

function eventStatus(
  event: Exclude<
    StripeBillingEvent,
    | { kind: "checkout_completed" }
    | { kind: "credit_recorded" }
    | { kind: "unhandled" }
    | { kind: "tax_policy_recorded" }
    | { kind: "invoice_dunning_updated" }
    | { kind: "dispute_opened" }
    | { kind: "dispute_closed" }
  >,
): BillingAccountStatus {
  switch (event.kind) {
    case "invoice_paid":
      return "active";
    case "invoice_payment_failed":
      return "past_due";
    case "invoice_marked_uncollectible":
      return "unpaid";
    case "subscription_updated":
      return event.status;
    case "subscription_canceled":
      return "canceled";
  }
}
