import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

import type {
  BillingAccountStatus,
  BillingCancellationRecord,
} from "./store.ts";

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: unknown;
    previous_attributes?: unknown;
  };
}

export type StripeBillingEvent =
  | {
      kind: "checkout_completed";
      eventId: string;
      subject?: TakosumiSubject;
      customerId?: string;
      subscriptionId?: string;
      stripePriceId?: string;
      planCode?: string;
      paymentStatus?: string;
    }
  | {
      kind: "invoice_paid";
      eventId: string;
      customerId: string;
      invoiceId?: string;
      currentPeriodEndUnix?: number;
    }
  | {
      kind: "invoice_payment_failed";
      eventId: string;
      customerId: string;
      invoiceId?: string;
      nextPaymentAttemptUnix?: number;
      attemptCount?: number;
    }
  | {
      kind: "invoice_dunning_updated";
      eventId: string;
      customerId: string;
      invoiceId?: string;
      nextPaymentAttemptUnix?: number;
      attemptCount?: number;
    }
  | {
      kind: "invoice_marked_uncollectible";
      eventId: string;
      customerId: string;
      invoiceId?: string;
    }
  | {
      kind: "subscription_updated";
      eventId: string;
      customerId: string;
      status: BillingAccountStatus;
      stripePriceId?: string;
      planCode?: string;
      currentPeriodEndUnix?: number;
    }
  | {
      kind: "tax_policy_recorded";
      eventId: string;
      customerId: string;
      invoiceId?: string;
      taxPolicyRef?: string;
      taxJurisdiction?: string;
      taxAutomaticStatus?: string;
    }
  | {
      kind: "subscription_canceled";
      eventId: string;
      customerId: string;
      cancellation?: BillingCancellationRecord;
    }
  | {
      kind: "dispute_opened";
      eventId: string;
      // Real Stripe Dispute webhook payloads carry NO top-level `customer`; the
      // owner is resolved later (in apply) from the `charge` / `payment_intent`
      // string id. `customerId` is only populated on the rare path where Stripe
      // already inlined it.
      customerId?: string;
      disputeId: string;
      chargeId?: string;
      paymentIntentId?: string;
      reason?: string;
      status?: string;
      openedAtUnix?: number;
    }
  | {
      kind: "dispute_closed";
      eventId: string;
      customerId?: string;
      disputeId: string;
      chargeId?: string;
      paymentIntentId?: string;
      reason?: string;
      status?: string;
      closedAtUnix?: number;
    }
  | {
      kind: "credit_recorded";
      eventId: string;
      customerId: string;
      creditKind: "refund" | "credit_note";
      creditId: string;
      amount?: number;
      currency?: string;
    }
  | {
      kind: "unhandled";
      eventId: string;
      eventType: string;
    };

export function normalizeStripeBillingEvent(
  event: StripeWebhookEvent,
): StripeBillingEvent {
  const object = isRecord(event.data.object) ? event.data.object : {};
  switch (event.type) {
    case "checkout.session.completed":
      return {
        kind: "checkout_completed",
        eventId: event.id,
        subject: takosumiSubjectFromMetadata(object.metadata),
        customerId: stripeId(object.customer),
        subscriptionId: stripeId(object.subscription),
        stripePriceId: stripePriceIdFromObject(object),
        planCode: planCodeFromMetadata(object.metadata),
        paymentStatus:
          typeof object.payment_status === "string"
            ? object.payment_status
            : undefined,
      };
    case "invoice.paid": {
      const customerId = stripeId(object.customer);
      if (!customerId) return unhandled(event);
      return {
        kind: "invoice_paid",
        eventId: event.id,
        customerId,
        invoiceId: stripeId(object.id),
        currentPeriodEndUnix: invoicePeriodEndUnix(object),
      };
    }
    case "invoice.payment_failed": {
      const customerId = stripeId(object.customer);
      return customerId
        ? {
            kind: "invoice_payment_failed",
            eventId: event.id,
            customerId,
            invoiceId: stripeId(object.id),
            nextPaymentAttemptUnix:
              typeof object.next_payment_attempt === "number"
                ? object.next_payment_attempt
                : undefined,
            attemptCount: positiveInteger(object.attempt_count),
          }
        : unhandled(event);
    }
    case "invoice.updated": {
      const customerId = stripeId(object.customer);
      return customerId &&
        hasInvoiceDunningSignal(object, event.data.previous_attributes)
        ? {
            kind: "invoice_dunning_updated",
            eventId: event.id,
            customerId,
            invoiceId: stripeId(object.id),
            nextPaymentAttemptUnix:
              typeof object.next_payment_attempt === "number"
                ? object.next_payment_attempt
                : undefined,
            attemptCount: positiveInteger(object.attempt_count),
          }
        : unhandled(event);
    }
    case "invoice.marked_uncollectible": {
      const customerId = stripeId(object.customer);
      return customerId
        ? {
            kind: "invoice_marked_uncollectible",
            eventId: event.id,
            customerId,
            invoiceId: stripeId(object.id),
          }
        : unhandled(event);
    }
    case "invoice.finalized": {
      const customerId = stripeId(object.customer);
      return customerId
        ? {
            kind: "tax_policy_recorded",
            eventId: event.id,
            customerId,
            invoiceId: stripeId(object.id),
            taxPolicyRef: stringFromMetadata(
              object.metadata,
              "tax_policy_ref",
              "taxPolicyRef",
            ),
            taxJurisdiction: taxJurisdictionFromInvoice(object),
            taxAutomaticStatus: taxAutomaticStatusFromObject(object),
          }
        : unhandled(event);
    }
    // Stripe sends `customer.subscription.created` when a subscription is
    // first attached to a customer (and again the same field set as
    // `customer.subscription.updated`). We reuse the subscription_updated
    // logic so the BillingAccount picks up plan + period end + status as
    // soon as the subscription exists, instead of waiting for the first
    // `updated` event.
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const customerId = stripeId(object.customer);
      if (!customerId) return unhandled(event);
      const status = stripeSubscriptionStatus(object.status);
      if (status === undefined) {
        // Unknown subscription status: do NOT coerce it into a suspend-worthy
        // local status (that would silently suspend a healthy account if Stripe
        // introduces a new status). Skip the event (no entitlement change) and
        // log the unrecognized value for operator review.
        console.warn(
          "stripe_unknown_subscription_status",
          JSON.stringify({
            eventId: event.id,
            eventType: event.type,
            status:
              typeof object.status === "string"
                ? object.status
                : typeof object.status,
          }),
        );
        return unhandled(event);
      }
      return {
        kind: "subscription_updated",
        eventId: event.id,
        customerId,
        status,
        stripePriceId: stripePriceIdFromObject(object),
        planCode: planCodeFromMetadata(object.metadata),
        currentPeriodEndUnix: subscriptionCurrentPeriodEnd(object),
      };
    }
    case "customer.subscription.deleted": {
      const customerId = stripeId(object.customer);
      if (!customerId) return unhandled(event);
      return {
        kind: "subscription_canceled",
        eventId: event.id,
        customerId,
        cancellation: subscriptionCancellationFromObject(object),
      };
    }
    case "charge.dispute.created": {
      // A real Dispute webhook has no top-level `customer`; `charge` and
      // `payment_intent` arrive as unexpanded string ids. Carry whatever link
      // we have (inline customer if Stripe expanded it, otherwise the charge /
      // payment_intent id) and let the apply layer resolve the owner. We only
      // need a `disputeId` plus *some* link to proceed; without any link the
      // event genuinely cannot be associated with an account.
      const customerId =
        stripeId(object.customer) ?? chargeCustomerIdFromDispute(object);
      const disputeId = stripeId(object.id);
      const chargeId = stripeId(object.charge);
      const paymentIntentId = stripeId(object.payment_intent);
      if (!disputeId || (!customerId && !chargeId && !paymentIntentId)) {
        return unhandled(event);
      }
      return {
        kind: "dispute_opened",
        eventId: event.id,
        customerId,
        disputeId,
        chargeId,
        paymentIntentId,
        reason: typeof object.reason === "string" ? object.reason : undefined,
        status: typeof object.status === "string" ? object.status : undefined,
        openedAtUnix: positiveInteger(object.created),
      };
    }
    case "charge.dispute.closed": {
      const customerId =
        stripeId(object.customer) ?? chargeCustomerIdFromDispute(object);
      const disputeId = stripeId(object.id);
      const chargeId = stripeId(object.charge);
      const paymentIntentId = stripeId(object.payment_intent);
      if (!disputeId || (!customerId && !chargeId && !paymentIntentId)) {
        return unhandled(event);
      }
      return {
        kind: "dispute_closed",
        eventId: event.id,
        customerId,
        disputeId,
        chargeId,
        paymentIntentId,
        reason: typeof object.reason === "string" ? object.reason : undefined,
        status: typeof object.status === "string" ? object.status : undefined,
        closedAtUnix: positiveInteger(object.created),
      };
    }
    case "credit_note.created": {
      const customerId = stripeId(object.customer);
      const creditId = stripeId(object.id);
      return customerId && creditId
        ? {
            kind: "credit_recorded",
            eventId: event.id,
            customerId,
            creditKind: "credit_note",
            creditId,
            amount: positiveInteger(object.amount),
            currency: lowercaseString(object.currency),
          }
        : unhandled(event);
    }
    case "charge.refunded": {
      const customerId = stripeId(object.customer);
      const refund = firstStripeRefund(object);
      const creditId = stripeId(refund?.id) ?? stripeId(object.id);
      return customerId && creditId
        ? {
            kind: "credit_recorded",
            eventId: event.id,
            customerId,
            creditKind: "refund",
            creditId,
            amount:
              positiveInteger(object.amount_refunded) ??
              positiveInteger(refund?.amount),
            currency:
              lowercaseString(object.currency) ??
              lowercaseString(refund?.currency),
          }
        : unhandled(event);
    }
    case "refund.created": {
      const customerId =
        stripeId(object.customer) ??
        (isRecord(object.charge)
          ? stripeId(object.charge.customer)
          : undefined);
      const creditId = stripeId(object.id);
      return customerId && creditId
        ? {
            kind: "credit_recorded",
            eventId: event.id,
            customerId,
            creditKind: "refund",
            creditId,
            amount: positiveInteger(object.amount),
            currency: lowercaseString(object.currency),
          }
        : unhandled(event);
    }
    default:
      return unhandled(event);
  }
}

/**
 * Map a raw Stripe subscription status string onto our local
 * `BillingAccountStatus`. Returns `undefined` for any unrecognized value so the
 * caller can skip the event instead of silently coercing an unknown status into
 * a suspend-worthy `incomplete` (Stripe can add statuses, e.g. `paused`, and an
 * unknown value must never auto-suspend a paying customer).
 */
export function stripeSubscriptionStatus(
  value: unknown,
): BillingAccountStatus | undefined {
  switch (value) {
    case "active":
    case "trialing":
    case "incomplete":
    case "incomplete_expired":
    case "past_due":
    case "unpaid":
    case "canceled":
    case "paused":
      return value;
    default:
      return undefined;
  }
}

function invoicePeriodEndUnix(
  object: Record<string, unknown>,
): number | undefined {
  const lines = isRecord(object.lines) ? object.lines : undefined;
  const data = Array.isArray(lines?.data) ? lines.data : [];
  const first = isRecord(data[0]) ? data[0] : undefined;
  const period = isRecord(first?.period) ? first.period : undefined;
  return typeof period?.end === "number" ? period.end : undefined;
}

/**
 * Stripe is moving `current_period_end` off the Subscription root and onto the
 * SubscriptionItem (`items.data[0].current_period_end`). To survive the
 * deprecation window we read the top-level field if Stripe still emits it, and
 * otherwise fall back to the first subscription item's period end.
 */
function subscriptionCurrentPeriodEnd(
  object: Record<string, unknown>,
): number | undefined {
  if (typeof object.current_period_end === "number") {
    return object.current_period_end;
  }
  const items = isRecord(object.items) ? object.items : undefined;
  const data = Array.isArray(items?.data) ? items.data : [];
  const first = isRecord(data[0]) ? data[0] : undefined;
  return typeof first?.current_period_end === "number"
    ? first.current_period_end
    : undefined;
}

/**
 * `customer.subscription.deleted` carries cancellation context that powers
 * support / churn analytics. We snapshot it on the BillingAccount so we don't
 * need to call back into Stripe later (the subscription object is gone after
 * deletion).
 */
function subscriptionCancellationFromObject(
  object: Record<string, unknown>,
): BillingCancellationRecord | undefined {
  const canceledAt = positiveInteger(object.canceled_at);
  const details = isRecord(object.cancellation_details)
    ? object.cancellation_details
    : undefined;
  const reason =
    typeof object.cancellation_reason === "string"
      ? object.cancellation_reason
      : details && typeof details.reason === "string"
        ? details.reason
        : undefined;
  const feedback =
    details && typeof details.feedback === "string"
      ? details.feedback
      : undefined;
  const comment =
    details && typeof details.comment === "string"
      ? details.comment
      : undefined;
  if (
    canceledAt === undefined &&
    reason === undefined &&
    feedback === undefined &&
    comment === undefined
  ) {
    return undefined;
  }
  return { canceledAt, reason, feedback, comment };
}

function chargeCustomerIdFromDispute(
  object: Record<string, unknown>,
): string | undefined {
  const charge = isRecord(object.charge) ? object.charge : undefined;
  return charge ? stripeId(charge.customer) : undefined;
}

function firstStripeRefund(
  object: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const refunds = isRecord(object.refunds) ? object.refunds : undefined;
  const data = Array.isArray(refunds?.data) ? refunds.data : [];
  return isRecord(data[0]) ? data[0] : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function hasInvoiceDunningSignal(
  object: Record<string, unknown>,
  previousAttributes: unknown,
): boolean {
  if (typeof object.next_payment_attempt === "number") return true;
  if (!isRecord(previousAttributes)) return false;
  return (
    "next_payment_attempt" in previousAttributes ||
    "attempt_count" in previousAttributes
  );
}

function lowercaseString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : undefined;
}

function takosumiSubjectFromMetadata(
  value: unknown,
): TakosumiSubject | undefined {
  if (!isRecord(value)) return undefined;
  const subject = value.takosumi_subject;
  return typeof subject === "string" && subject.startsWith("tsub_")
    ? (subject as TakosumiSubject)
    : undefined;
}

function stripeId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.id === "string") return value.id;
  return undefined;
}

function stripePriceIdFromObject(
  object: Record<string, unknown>,
): string | undefined {
  const items = isRecord(object.items) ? object.items : undefined;
  const itemData = Array.isArray(items?.data) ? items.data : [];
  const firstItem = isRecord(itemData[0]) ? itemData[0] : undefined;
  const itemPrice = isRecord(firstItem?.price) ? firstItem.price : undefined;
  const lineItems = isRecord(object.line_items) ? object.line_items : undefined;
  const lineData = Array.isArray(lineItems?.data) ? lineItems.data : [];
  const firstLine = isRecord(lineData[0]) ? lineData[0] : undefined;
  const linePrice = isRecord(firstLine?.price) ? firstLine.price : undefined;
  return stripeId(itemPrice) ?? stripeId(linePrice) ?? stripeId(object.price);
}

function planCodeFromMetadata(value: unknown): string | undefined {
  const planCode = stringFromMetadata(value, "plan_code", "planCode");
  return planCode && /^[a-z][a-z0-9_-]{0,63}$/.test(planCode)
    ? planCode
    : undefined;
}

function stringFromMetadata(
  value: unknown,
  ...keys: readonly string[]
): string | undefined {
  if (!isRecord(value)) return undefined;
  const found = keys
    .map((key) => value[key])
    .find((item) => typeof item === "string" && item.trim().length > 0);
  return typeof found === "string" ? found.trim() : undefined;
}

function taxJurisdictionFromInvoice(
  object: Record<string, unknown>,
): string | undefined {
  const details = isRecord(object.customer_details)
    ? object.customer_details
    : undefined;
  const address = isRecord(details?.address) ? details.address : undefined;
  return lowercaseString(address?.country)?.toUpperCase();
}

function taxAutomaticStatusFromObject(
  object: Record<string, unknown>,
): string | undefined {
  const automaticTax = isRecord(object.automatic_tax)
    ? object.automatic_tax
    : undefined;
  const status =
    typeof automaticTax?.status === "string"
      ? automaticTax.status
      : typeof automaticTax?.enabled === "boolean"
        ? automaticTax.enabled
          ? "enabled"
          : "disabled"
        : undefined;
  return status && /^[a-z_]+$/.test(status) ? status : undefined;
}

function unhandled(event: StripeWebhookEvent): StripeBillingEvent {
  return {
    kind: "unhandled",
    eventId: event.id,
    eventType: event.type,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
