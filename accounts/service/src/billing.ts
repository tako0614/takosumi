import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

import type { AccountsStore, BillingWebhookEventStatus } from "./store.ts";
import {
  applyStripeBillingEvent,
  type ApplyStripeBillingEventResult,
  type StripeDisputeCustomerResolver,
} from "./billing-apply.ts";
import type { StripeWebhookEvent } from "./billing-events.ts";
import {
  aggregateBillingUsage,
  type BillingUsageAggregationPolicy,
  type BillingUsageRollup,
} from "./billing-usage.ts";
export {
  aggregateBillingUsage,
  type BillingUsageAggregationPolicy,
  type BillingUsageRollup,
} from "./billing-usage.ts";
export {
  normalizeStripeBillingEvent,
  type StripeBillingEvent,
  type StripeWebhookEvent,
} from "./billing-events.ts";
export {
  applyStripeBillingEvent,
  type ApplyStripeBillingEventInput,
  type ApplyStripeBillingEventResult,
  type BillingEntitlementReconciliationResult,
  reconcileBillingEntitlements,
} from "./billing-apply.ts";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
// Pinned Stripe API version. Bump deliberately after validating against the
// current Stripe API version; never let Stripe choose the version implicitly
// per account.
export const STRIPE_API_VERSION = "2026-05-27.dahlia";
const textEncoder = new TextEncoder();

function stripeRequestHeaders(
  secretKey: string,
  idempotencyKey?: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${secretKey}`,
    "content-type": "application/x-www-form-urlencoded",
    "Stripe-Version": STRIPE_API_VERSION,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

interface StripeErrorSummary {
  readonly requestId: string | null;
  readonly errorCode: string | null;
  readonly errorType: string | null;
}

/**
 * Safely extract loggable fields from a Stripe error response.
 *
 * Stripe error bodies have shape `{ error: { code, type, message,
 * param, ... } }` where `message` and `param` can contain PII (email,
 * customer name, card hints, idempotency keys). This summarizer keeps
 * only the structural fields (`code`, `type`) plus the
 * `Stripe-Request-Id` header, which Stripe needs to trace a request.
 */
async function summarizeStripeErrorResponse(
  response: Response,
): Promise<StripeErrorSummary> {
  const requestId =
    response.headers.get("Stripe-Request-Id") ??
    response.headers.get("request-id");
  let errorCode: string | null = null;
  let errorType: string | null = null;
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const err = parsed.error;
      if (typeof err.code === "string") errorCode = err.code;
      if (typeof err.type === "string") errorType = err.type;
    }
  } catch (_error) {
    // Non-JSON body or read error. Summary fields stay null.
  }
  return { requestId, errorCode, errorType };
}

export interface CreateStripeCheckoutSessionInput {
  secretKey: string;
  priceId: string;
  mode: "subscription" | "payment";
  subject: TakosumiSubject;
  successUrl: string;
  cancelUrl: string;
  stripeCustomerId?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
  /**
   * Metadata stamped onto the CREATED SUBSCRIPTION (subscription mode only,
   * via `subscription_data[metadata]`). Every subsequent invoice then carries
   * it under `subscription_details.metadata`, which is how the webhook grants
   * the Space its monthly plan credits without a store lookup.
   */
  subscriptionMetadata?: Record<string, string>;
  automaticTax?: boolean;
  taxIdCollection?: boolean;
  fetch?: typeof fetch;
  stripeApiBase?: string;
}

export interface StripeCheckoutSessionResult {
  sessionId: string;
  url: string;
}

export interface CreateStripeBillingPortalSessionInput {
  secretKey: string;
  stripeCustomerId: string;
  returnUrl: string;
  fetch?: typeof fetch;
  stripeApiBase?: string;
}

export interface StripeBillingPortalSessionResult {
  sessionId: string;
  url: string;
}

export interface CreateStripeInvoiceItemInput {
  secretKey: string;
  stripeCustomerId: string;
  amount: number;
  currency: string;
  description: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  fetch?: typeof fetch;
  stripeApiBase?: string;
}

export interface StripeInvoiceItemResult {
  invoiceItemId: string;
}

export interface CreateStripeUsageInvoiceItemInput {
  secretKey: string;
  stripeCustomerId: string;
  rollup: BillingUsageRollup;
  unitAmount: number;
  currency: string;
  descriptionPrefix?: string;
  metadata?: Record<string, string>;
  fetch?: typeof fetch;
  stripeApiBase?: string;
}

export interface StripeUsageInvoiceItemPrice {
  meter: string;
  unit: string;
  unitAmount: number;
  currency: string;
  descriptionPrefix?: string;
  metadata?: Record<string, string>;
}

export interface CreateStripeUsageInvoiceItemsForBillingAccountInput {
  store: AccountsStore;
  secretKey: string;
  billingAccountId: string;
  prices: readonly StripeUsageInvoiceItemPrice[];
  policy?: Omit<BillingUsageAggregationPolicy, "billingAccountId">;
  metadata?: Record<string, string>;
  now?: number;
  fetch?: typeof fetch;
  stripeApiBase?: string;
}

export interface StripeUsageInvoiceItemExport {
  meter: string;
  unit: string;
  quantity: number;
  usageReportCount: number;
  usageReportIds: readonly string[];
  exportId: string;
  invoiceItemId: string;
}

export interface CreateStripeUsageInvoiceItemsForBillingAccountResult {
  billingAccountId: string;
  stripeCustomerId: string;
  exported: readonly StripeUsageInvoiceItemExport[];
}

export interface HandleStripeWebhookInput {
  store: AccountsStore;
  payload: string;
  signature: string;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
  /**
   * Stripe secret key used to resolve dispute owners. `charge.dispute.*`
   * webhooks carry the `charge` / `payment_intent` only as string ids with no
   * top-level `customer`, so the owning customer is recovered by retrieving the
   * charge (or payment intent) with the customer expanded. Required for
   * production dispute handling; when absent, disputes that cannot be linked
   * inline fail closed and Stripe retries.
   */
  stripeSecretKey?: string;
  /** Overridable for tests. */
  fetch?: typeof fetch;
  /** Overridable for tests. */
  stripeApiBase?: string;
}

export interface HandleStripeWebhookResult {
  received: true;
  duplicate: boolean;
  eventId: string;
  status: BillingWebhookEventStatus;
  applyResult?: ApplyStripeBillingEventResult;
  errorMessage?: string;
}

export async function createStripeCheckoutSession(
  input: CreateStripeCheckoutSessionInput,
): Promise<StripeCheckoutSessionResult> {
  const body = stripeCheckoutSessionParams(input);
  const response = await (input.fetch ?? fetch)(
    `${input.stripeApiBase ?? STRIPE_API_BASE}/checkout/sessions`,
    {
      method: "POST",
      headers: stripeRequestHeaders(input.secretKey),
      body,
    },
  );
  if (!response.ok) {
    // Stripe error bodies can echo PII (email, customer name, raw card
    // hints, idempotency keys). Do not log the raw body. Extract only
    // the safe summary fields (Stripe `error.code`, `error.type`, and
    // the response `Stripe-Request-Id` header) and emit a structured
    // record.
    const summary = await summarizeStripeErrorResponse(response);
    console.error(
      "stripe_api_error",
      JSON.stringify({
        endpoint: "checkout/sessions",
        status: response.status,
        requestId: summary.requestId,
        errorCode: summary.errorCode,
        errorType: summary.errorType,
      }),
    );
    throw new Error("stripe_api_error");
  }

  const data: unknown = await response.json();
  if (
    !isRecord(data) ||
    typeof data.id !== "string" ||
    typeof data.url !== "string"
  ) {
    throw new TypeError(
      "Stripe checkout session response is missing id or url",
    );
  }
  return {
    sessionId: data.id,
    url: data.url,
  };
}

export async function createStripeBillingPortalSession(
  input: CreateStripeBillingPortalSessionInput,
): Promise<StripeBillingPortalSessionResult> {
  const params = new URLSearchParams();
  params.set("customer", input.stripeCustomerId);
  params.set("return_url", input.returnUrl);
  const response = await (input.fetch ?? fetch)(
    `${input.stripeApiBase ?? STRIPE_API_BASE}/billing_portal/sessions`,
    {
      method: "POST",
      headers: stripeRequestHeaders(input.secretKey),
      body: params,
    },
  );
  if (!response.ok) {
    const summary = await summarizeStripeErrorResponse(response);
    console.error(
      "stripe_api_error",
      JSON.stringify({
        endpoint: "billing_portal/sessions",
        status: response.status,
        requestId: summary.requestId,
        errorCode: summary.errorCode,
        errorType: summary.errorType,
      }),
    );
    throw new Error("stripe_api_error");
  }

  const data: unknown = await response.json();
  if (
    !isRecord(data) ||
    typeof data.id !== "string" ||
    typeof data.url !== "string"
  ) {
    throw new TypeError(
      "Stripe billing portal session response is missing id or url",
    );
  }
  return {
    sessionId: data.id,
    url: data.url,
  };
}

export async function createStripeInvoiceItem(
  input: CreateStripeInvoiceItemInput,
): Promise<StripeInvoiceItemResult> {
  const body = stripeInvoiceItemParams(input);
  const response = await (input.fetch ?? fetch)(
    `${input.stripeApiBase ?? STRIPE_API_BASE}/invoiceitems`,
    {
      method: "POST",
      headers: stripeRequestHeaders(input.secretKey, input.idempotencyKey),
      body,
    },
  );
  if (!response.ok) {
    const summary = await summarizeStripeErrorResponse(response);
    console.error(
      "stripe_api_error",
      JSON.stringify({
        endpoint: "invoiceitems",
        status: response.status,
        requestId: summary.requestId,
        errorCode: summary.errorCode,
        errorType: summary.errorType,
      }),
    );
    throw new Error("stripe_api_error");
  }

  const data: unknown = await response.json();
  if (!isRecord(data) || typeof data.id !== "string") {
    throw new TypeError("Stripe invoice item response is missing id");
  }
  return { invoiceItemId: data.id };
}

export async function createStripeUsageInvoiceItem(
  input: CreateStripeUsageInvoiceItemInput,
): Promise<StripeInvoiceItemResult> {
  const amount = stripeUsageRollupAmount(input.rollup, input.unitAmount);
  return await createStripeInvoiceItem({
    secretKey: input.secretKey,
    stripeCustomerId: input.stripeCustomerId,
    amount,
    currency: input.currency,
    description: stripeUsageRollupDescription(
      input.rollup,
      input.descriptionPrefix,
    ),
    metadata: {
      ...(input.metadata ?? {}),
      ...stripeUsageRollupMetadata(input.rollup),
    },
    idempotencyKey: stripeUsageRollupIdempotencyKey(input.rollup),
    fetch: input.fetch,
    stripeApiBase: input.stripeApiBase,
  });
}

export async function createStripeUsageInvoiceItemsForBillingAccount(
  input: CreateStripeUsageInvoiceItemsForBillingAccountInput,
): Promise<CreateStripeUsageInvoiceItemsForBillingAccountResult> {
  const billingAccount = await input.store.findBillingAccount(
    input.billingAccountId,
  );
  if (!billingAccount) {
    throw new TypeError("billing account was not found");
  }
  if (!billingAccount.stripeCustomerId) {
    throw new TypeError("billing account is not linked to a Stripe customer");
  }
  const priceByMeterUnit = stripeUsagePriceMap(input.prices);
  const records = (
    await input.store.listBillingUsageRecordsForBillingAccount(
      input.billingAccountId,
    )
  ).filter((record) => record.billingExportedAt === undefined);
  const rollups = aggregateBillingUsage(records, {
    ...(input.policy ?? {}),
    billingAccountId: input.billingAccountId,
  });
  const exported: StripeUsageInvoiceItemExport[] = [];
  const exportedAt = input.now ?? Date.now();
  for (const rollup of rollups) {
    const price = priceByMeterUnit.get(stripeUsagePriceKey(rollup));
    if (!price) {
      throw new TypeError(
        `Stripe usage price is not configured for ${rollup.meter} ${rollup.unit}`,
      );
    }
    const result = await createStripeUsageInvoiceItem({
      secretKey: input.secretKey,
      stripeCustomerId: billingAccount.stripeCustomerId,
      rollup,
      unitAmount: price.unitAmount,
      currency: price.currency,
      descriptionPrefix: price.descriptionPrefix,
      metadata: {
        ...(input.metadata ?? {}),
        ...(price.metadata ?? {}),
      },
      fetch: input.fetch,
      stripeApiBase: input.stripeApiBase,
    });
    const exportId = stripeUsageRollupIdempotencyKey(rollup);
    await input.store.markBillingUsageRecordsExported({
      billingAccountId: input.billingAccountId,
      usageReportIds: rollup.usageReportIds,
      provider: "stripe",
      exportId,
      exportReference: result.invoiceItemId,
      exportedAt,
    });
    exported.push({
      meter: rollup.meter,
      unit: rollup.unit,
      quantity: rollup.quantity,
      usageReportCount: rollup.usageReportCount,
      usageReportIds: rollup.usageReportIds,
      exportId,
      invoiceItemId: result.invoiceItemId,
    });
  }
  return {
    billingAccountId: input.billingAccountId,
    stripeCustomerId: billingAccount.stripeCustomerId,
    exported,
  };
}

export function stripeCheckoutSessionParams(
  input: Omit<CreateStripeCheckoutSessionInput, "fetch" | "stripeApiBase">,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("mode", input.mode);
  params.set("line_items[0][price]", input.priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);
  params.set("client_reference_id", input.subject);
  params.set("metadata[takosumi_subject]", input.subject);
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    params.set(`metadata[${key}]`, value);
  }
  if (input.mode === "subscription") {
    for (const [key, value] of Object.entries(
      input.subscriptionMetadata ?? {},
    )) {
      params.set(`subscription_data[metadata][${key}]`, value);
    }
  }
  if (input.automaticTax) {
    params.set("automatic_tax[enabled]", "true");
  }
  if (input.taxIdCollection) {
    params.set("tax_id_collection[enabled]", "true");
  }

  if (input.stripeCustomerId) {
    params.set("customer", input.stripeCustomerId);
  } else if (input.customerEmail) {
    params.set("customer_email", input.customerEmail);
  } else {
    throw new TypeError(
      "Stripe checkout requires either stripeCustomerId or customerEmail",
    );
  }

  return params;
}

export function stripeInvoiceItemParams(
  input: Omit<CreateStripeInvoiceItemInput, "fetch" | "stripeApiBase">,
): URLSearchParams {
  if (!input.stripeCustomerId.trim()) {
    throw new TypeError("Stripe invoice item requires stripeCustomerId");
  }
  if (
    !Number.isSafeInteger(input.amount) ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0
  ) {
    throw new TypeError(
      "Stripe invoice item amount must be a positive integer",
    );
  }
  const currency = input.currency.trim().toLowerCase();
  if (!/^[a-z]{3}$/u.test(currency)) {
    throw new TypeError("Stripe invoice item currency must be a 3-letter code");
  }
  const description = input.description.trim();
  if (!description) {
    throw new TypeError("Stripe invoice item description is required");
  }
  const params = new URLSearchParams();
  params.set("customer", input.stripeCustomerId);
  params.set("amount", String(input.amount));
  params.set("currency", currency);
  params.set("description", description);
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    params.set(`metadata[${key}]`, value);
  }
  return params;
}

function stripeUsageRollupAmount(
  rollup: BillingUsageRollup,
  unitAmount: number,
): number {
  if (
    !Number.isFinite(unitAmount) ||
    !Number.isSafeInteger(unitAmount) ||
    unitAmount <= 0
  ) {
    throw new TypeError("Stripe usage unitAmount must be a positive integer");
  }
  if (!Number.isFinite(rollup.quantity) || rollup.quantity <= 0) {
    throw new TypeError("Stripe usage rollup quantity must be positive");
  }
  const amount = Math.round(rollup.quantity * unitAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError("Stripe usage amount must be a positive integer");
  }
  return amount;
}

function stripeUsageRollupDescription(
  rollup: BillingUsageRollup,
  prefix = "Takosumi usage",
): string {
  return `${prefix}: ${rollup.meter} (${rollup.quantity} ${rollup.unit})`;
}

function stripeUsageRollupMetadata(
  rollup: BillingUsageRollup,
): Record<string, string> {
  return {
    takosumi_billing_account_id: rollup.billingAccountId,
    takosumi_usage_meter: rollup.meter,
    takosumi_usage_unit: rollup.unit,
    takosumi_usage_quantity: String(rollup.quantity),
    takosumi_usage_report_count: String(rollup.usageReportCount),
    takosumi_usage_report_ids: rollup.usageReportIds.join(",").slice(0, 500),
    ...(rollup.periodStart === undefined
      ? {}
      : { takosumi_usage_period_start: String(rollup.periodStart) }),
    ...(rollup.periodEnd === undefined
      ? {}
      : { takosumi_usage_period_end: String(rollup.periodEnd) }),
  };
}

function stripeUsageRollupIdempotencyKey(rollup: BillingUsageRollup): string {
  return [
    "takosumi-usage",
    rollup.billingAccountId,
    rollup.meter,
    rollup.unit,
    rollup.periodStart ?? "no-start",
    rollup.periodEnd ?? "no-end",
    rollup.usageReportIds.join("."),
  ]
    .join(":")
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .slice(0, 255);
}

function stripeUsagePriceMap(
  prices: readonly StripeUsageInvoiceItemPrice[],
): Map<string, StripeUsageInvoiceItemPrice> {
  const mapped = new Map<string, StripeUsageInvoiceItemPrice>();
  for (const price of prices) {
    if (!price.meter.trim() || !price.unit.trim()) {
      throw new TypeError("Stripe usage price requires meter and unit");
    }
    const key = stripeUsagePriceKey(price);
    if (mapped.has(key)) {
      throw new TypeError(
        `Stripe usage price is duplicated for ${price.meter} ${price.unit}`,
      );
    }
    mapped.set(key, price);
  }
  return mapped;
}

function stripeUsagePriceKey(input: { meter: string; unit: string }): string {
  return `${input.meter}\u0000${input.unit}`;
}

export async function verifyStripeWebhookSignature(input: {
  payload: string;
  signature: string;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}): Promise<StripeWebhookEvent> {
  const { timestamp, signatures } = parseStripeSignatureHeader(input.signature);
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new TypeError("Stripe webhook timestamp is outside tolerance");
  }

  const expectedSignature = await hmacSha256Hex(
    input.secret,
    `${timestamp}.${input.payload}`,
  );
  if (
    !signatures.some((signature) =>
      timingSafeEqualText(signature, expectedSignature),
    )
  ) {
    throw new TypeError("Stripe webhook signature mismatch");
  }

  const parsed: unknown = JSON.parse(input.payload);
  if (!isRecord(parsed)) {
    throw new TypeError("Stripe webhook payload is not a JSON object");
  }
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.type !== "string" ||
    !isRecord(parsed.data)
  ) {
    throw new TypeError("Stripe webhook payload is missing required fields");
  }
  return {
    id: parsed.id,
    type: parsed.type,
    data: {
      object: parsed.data.object,
      previous_attributes: parsed.data.previous_attributes,
    },
  };
}

export async function handleStripeWebhook(
  input: HandleStripeWebhookInput,
): Promise<HandleStripeWebhookResult> {
  const now = input.now ?? Date.now();
  const event = await verifyStripeWebhookSignature({
    payload: input.payload,
    signature: input.signature,
    secret: input.secret,
    toleranceSeconds: input.toleranceSeconds,
    now,
  });

  // Atomic idempotency claim: a single backend-level statement (Postgres
  // `INSERT ... ON CONFLICT DO NOTHING RETURNING`, SQLite `INSERT OR IGNORE`)
  // ensures that two concurrent webhook deliveries for the same event id
  // cannot both pass a "not exists" check and double-apply the side effects.
  const claim = await input.store.claimBillingWebhookEvent({
    eventId: event.id,
    eventType: event.type,
    status: "received",
    receivedAt: now,
    updatedAt: now,
  });
  if (!claim.inserted) {
    return {
      received: true,
      duplicate: true,
      eventId: event.id,
      status: claim.existing.status,
      errorMessage: claim.existing.errorMessage,
    };
  }

  try {
    const applyResult = await applyStripeBillingEvent({
      store: input.store,
      event,
      now,
      resolveDisputeCustomerId: input.stripeSecretKey
        ? stripeDisputeCustomerResolver({
            secretKey: input.stripeSecretKey,
            fetch: input.fetch,
            stripeApiBase: input.stripeApiBase,
          })
        : undefined,
    });
    const status = billingWebhookStatus(applyResult);
    await input.store.saveBillingWebhookEvent({
      eventId: event.id,
      eventType: event.type,
      status,
      receivedAt: now,
      updatedAt: now,
      errorMessage:
        status === "failed" && !applyResult.applied
          ? applyResult.reason
          : undefined,
    });
    return {
      received: true,
      duplicate: false,
      eventId: event.id,
      status,
      applyResult,
      errorMessage:
        status === "failed" && !applyResult.applied
          ? applyResult.reason
          : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await input.store.saveBillingWebhookEvent({
      eventId: event.id,
      eventType: event.type,
      status: "failed",
      receivedAt: now,
      updatedAt: now,
      errorMessage,
    });
    return {
      received: true,
      duplicate: false,
      eventId: event.id,
      status: "failed",
      errorMessage,
    };
  }
}

function billingWebhookStatus(
  result: ApplyStripeBillingEventResult,
): BillingWebhookEventStatus {
  if (result.applied) return "processed";
  return result.reason === "unhandled_event" ? "skipped" : "failed";
}

/**
 * Build a dispute -> customer resolver backed by the Stripe API. A real
 * `charge.dispute.*` webhook delivers `charge` / `payment_intent` as string ids
 * only, so we retrieve the charge (or payment intent) with the customer
 * expanded to recover the owning customer id. Returning `undefined` makes the
 * caller fail the webhook closed (Stripe retries) instead of silently dropping
 * the chargeback freeze.
 */
export function stripeDisputeCustomerResolver(input: {
  secretKey: string;
  fetch?: typeof fetch;
  stripeApiBase?: string;
}): StripeDisputeCustomerResolver {
  const fetchImpl = input.fetch ?? fetch;
  const apiBase = input.stripeApiBase ?? STRIPE_API_BASE;
  return async ({ disputeId, chargeId, paymentIntentId }) => {
    if (chargeId) {
      const customerId = await retrieveStripeCustomerId(
        `${apiBase}/charges/${encodeURIComponent(chargeId)}`,
        input.secretKey,
        fetchImpl,
        "charges.retrieve",
      );
      if (customerId) return customerId;
    }
    if (paymentIntentId) {
      const customerId = await retrieveStripeCustomerId(
        `${apiBase}/payment_intents/${encodeURIComponent(paymentIntentId)}`,
        input.secretKey,
        fetchImpl,
        "payment_intents.retrieve",
      );
      if (customerId) return customerId;
    }
    console.error(
      "stripe_dispute_customer_unresolved",
      JSON.stringify({
        disputeId,
        hasCharge: !!chargeId,
        hasPaymentIntent: !!paymentIntentId,
      }),
    );
    return undefined;
  };
}

async function retrieveStripeCustomerId(
  url: string,
  secretKey: string,
  fetchImpl: typeof fetch,
  endpoint: string,
): Promise<string | undefined> {
  // `expand[]=customer` returns the customer object inline so we can read its
  // id even when Stripe would otherwise emit a deleted/string reference.
  const requestUrl = `${url}?expand[]=customer`;
  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: stripeRequestHeaders(secretKey),
    });
  } catch (error) {
    console.error(
      "stripe_api_error",
      JSON.stringify({
        endpoint,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return undefined;
  }
  if (!response.ok) {
    const summary = await summarizeStripeErrorResponse(response);
    console.error(
      "stripe_api_error",
      JSON.stringify({
        endpoint,
        status: response.status,
        requestId: summary.requestId,
        errorCode: summary.errorCode,
        errorType: summary.errorType,
      }),
    );
    return undefined;
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  return stripeCustomerIdFromObject(data.customer);
}

function stripeCustomerIdFromObject(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }
  return undefined;
}

function parseStripeSignatureHeader(header: string): {
  timestamp: number;
  signatures: string[];
} {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = parseStripeSignatureTimestamp(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (typeof timestamp !== "number" || signatures.length === 0) {
    throw new TypeError("Stripe signature header is invalid");
  }
  return { timestamp, signatures };
}

// Stripe documents `t=<unix-seconds>` as a positive integer. Reject anything
// non-canonical (sign, fraction, whitespace, scientific notation, NaN, Infinity)
// rather than letting `Number()` accept it. This blocks signature replay
// abuse that relies on lax timestamp parsing.
function parseStripeSignatureTimestamp(value: string | undefined): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("invalid_signature_timestamp");
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new TypeError("invalid_signature_timestamp");
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    !Number.isSafeInteger(parsed)
  ) {
    throw new TypeError("invalid_signature_timestamp");
  }
  return parsed;
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)),
    ),
  );
}

function timingSafeEqualText(first: string, second: string): boolean {
  return timingSafeEqual(textEncoder.encode(first), textEncoder.encode(second));
}

function timingSafeEqual(first: Uint8Array, second: Uint8Array): boolean {
  if (first.byteLength !== second.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < first.byteLength; index += 1) {
    diff |= first[index] ^ second[index];
  }
  return diff === 0;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
