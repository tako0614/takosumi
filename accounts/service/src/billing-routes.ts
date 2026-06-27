import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  createStripeUsageInvoiceItemsForBillingAccount,
  handleStripeWebhook,
  type StripeUsageInvoiceItemPrice,
  type StripeUsageInvoiceItemExport,
} from "./billing.ts";
import {
  type BillingPlan,
  findBillingPlan,
  parseBillingPlans,
} from "./billing-plans.ts";
import type { AccountsStore } from "./store.ts";
import {
  canAccessSpace,
  type ControlPlaneOperations,
} from "./control-routes.ts";
import type { StripeBillingOptions } from "./mod.ts";
import {
  errorJson,
  isRecord,
  json,
  numberValue,
  readJsonObject,
  stringValue,
  takosumiSubjectValue,
} from "./http-helpers.ts";
import { readEnvVar } from "./read-env.ts";
import { consoleErrorRedacted } from "./redacted-log.ts";

export async function handleStripeCheckoutRequest(input: {
  request: Request;
  store: AccountsStore;
  stripe: StripeBillingOptions;
  /**
   * Authenticated session subject. The request body's `subject` must equal
   * this value; mismatches are rejected with 403 to prevent an attacker from
   * driving a Stripe checkout against another user's billing account.
   */
  sessionSubject: TakosumiSubject;
  /**
   * Allowlisted origins that `successUrl` / `cancelUrl` may use. Both URLs
   * must be HTTPS (or loopback http: for explicit local-dev origins on the
   * list) and the origin must match exactly. When omitted we fall back to the
   * `TAKOSUMI_ACCOUNTS_BILLING_REDIRECT_ALLOWLIST` env var.
   */
  billingRedirectAllowlist?: readonly string[];
  /**
   * Operator plan catalog (spec §32). Checkout is plan-id based: the client
   * names a `planId` + target `spaceId` and the SERVER resolves the Stripe
   * price, checkout mode, and metadata, so a client can never check out an
   * arbitrary price or mint credit metadata. Falls back to the
   * `TAKOSUMI_BILLING_PLANS` env var when omitted.
   */
  billingPlans?: readonly BillingPlan[];
  /**
   * In-process control-plane operations used to verify the authenticated
   * subject OWNS the target `spaceId` before checkout. Checkout server-stamps
   * `metadata.space_id`, and the webhook grants the plan's credits to that
   * Space; without this check a paying user could grant credits to a Space they
   * do not own. When absent (control plane not wired) checkout fails closed: a
   * Space ownership claim cannot be verified, so it is rejected.
   */
  controlPlaneOperations?: ControlPlaneOperations;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);

  const subject = takosumiSubjectValue(body.subject);
  const planId = stringValue(body.planId);
  const spaceId = stringValue(body.spaceId);
  const successUrl = stringValue(body.successUrl);
  const cancelUrl = stringValue(body.cancelUrl);
  if (!subject || !planId || !spaceId || !successUrl || !cancelUrl) {
    return errorJson(
      "invalid_request",
      "subject, planId, spaceId, successUrl, and cancelUrl are required",
      400,
    );
  }
  if (subject !== input.sessionSubject) {
    return errorJson(
      "subject_mismatch",
      "checkout body subject does not match the authenticated session",
      403,
    );
  }
  // Space ownership gate (fail closed): the plan's credits are granted to
  // `spaceId` by the webhook, so the buyer must own it. We cannot verify
  // without the control plane, so reject when it is not wired.
  if (!input.controlPlaneOperations) {
    return errorJson(
      "feature_unavailable",
      "Billing checkout requires the control plane to verify Space ownership.",
      503,
    );
  }
  const owns = await canAccessSpace({
    operations: input.controlPlaneOperations,
    store: input.store,
    subject,
    spaceId,
  });
  if (!owns) {
    return errorJson(
      "forbidden",
      "The authenticated session cannot access this Space.",
      403,
    );
  }
  const plans = resolveBillingPlans(input.billingPlans);
  const plan = findBillingPlan(plans, planId);
  if (!plan) {
    return errorJson("plan_not_found", "unknown billing plan", 404);
  }
  const allowlist = resolveBillingRedirectAllowlist(
    input.billingRedirectAllowlist,
  );
  if (!allowlist || allowlist.length === 0) {
    return errorJson(
      "feature_unavailable",
      "Billing redirect allowlist is not configured.",
      503,
    );
  }
  if (!isAllowedBillingRedirect(successUrl, allowlist)) {
    return errorJson(
      "invalid_redirect_uri",
      "successUrl origin is not in the billing allowlist",
      400,
    );
  }
  if (!isAllowedBillingRedirect(cancelUrl, allowlist)) {
    return errorJson(
      "invalid_redirect_uri",
      "cancelUrl origin is not in the billing allowlist",
      400,
    );
  }

  const account = await input.store.findAccount(subject);
  if (!account) return errorJson("account_not_found", "account not found", 404);
  const existingBilling =
    await input.store.findBillingAccountForSubject(subject);

  // Server-resolved metadata. `space_id` routes the webhook's grant to the
  // right Space; `credits` is the grant amount the PLAN defines (a pack grants
  // once on payment, a subscription grants per paid invoice via the
  // subscription metadata mirror below).
  const planMetadata: Record<string, string> = {
    space_id: spaceId,
    plan_code: plan.id,
    credits: String(plan.credits),
  };

  try {
    const result = await createStripeCheckoutSession({
      secretKey: input.stripe.secretKey,
      priceId: plan.stripePriceId,
      mode: plan.kind === "pack" ? "payment" : "subscription",
      subject,
      successUrl,
      cancelUrl,
      stripeCustomerId: existingBilling?.stripeCustomerId,
      customerEmail: stringValue(body.customerEmail) ?? account.email,
      metadata: planMetadata,
      ...(plan.kind === "subscription"
        ? { subscriptionMetadata: planMetadata }
        : {}),
      fetch: input.stripe.fetch,
      stripeApiBase: input.stripe.stripeApiBase,
    });
    return json({
      session_id: result.sessionId,
      url: result.url,
    });
  } catch (error) {
    // Do not leak raw upstream / driver error text to clients (it can echo
    // Stripe internals or network details). Log server-side, return a fixed
    // safe description and keep the stable error code.
    consoleErrorRedacted("billing_checkout_failed", error);
    return errorJson("checkout_failed", "billing checkout failed", 502);
  }
}

export async function handleStripeBillingPortalRequest(input: {
  request: Request;
  store: AccountsStore;
  stripe: StripeBillingOptions;
  sessionSubject: TakosumiSubject;
  billingRedirectAllowlist?: readonly string[];
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);

  const subject = takosumiSubjectValue(body.subject);
  const returnUrl = stringValue(body.returnUrl);
  if (!subject || !returnUrl) {
    return errorJson(
      "invalid_request",
      "subject and returnUrl are required",
      400,
    );
  }
  if (subject !== input.sessionSubject) {
    return errorJson(
      "subject_mismatch",
      "portal body subject does not match the authenticated session",
      403,
    );
  }

  const allowlist = resolveBillingRedirectAllowlist(
    input.billingRedirectAllowlist,
  );
  if (!allowlist || allowlist.length === 0) {
    return errorJson(
      "feature_unavailable",
      "Billing redirect allowlist is not configured.",
      503,
    );
  }
  if (!isAllowedBillingRedirect(returnUrl, allowlist)) {
    return errorJson(
      "invalid_redirect_uri",
      "returnUrl origin is not in the billing allowlist",
      400,
    );
  }

  const existingBilling =
    await input.store.findBillingAccountForSubject(subject);
  if (!existingBilling?.stripeCustomerId) {
    return errorJson(
      "billing_account_not_linked",
      "Stripe Customer Portal requires an existing Stripe customer.",
      409,
    );
  }

  try {
    const result = await createStripeBillingPortalSession({
      secretKey: input.stripe.secretKey,
      stripeCustomerId: existingBilling.stripeCustomerId,
      returnUrl,
      fetch: input.stripe.fetch,
      stripeApiBase: input.stripe.stripeApiBase,
    });
    return json({
      session_id: result.sessionId,
      url: result.url,
    });
  } catch (error) {
    consoleErrorRedacted("billing_portal_failed", error);
    return errorJson("portal_failed", "billing portal failed", 502);
  }
}

export async function handleStripeUsageInvoiceItemsSyncRequest(input: {
  request: Request;
  store: AccountsStore;
  stripe: StripeBillingOptions;
  prices: readonly StripeUsageInvoiceItemPrice[];
}): Promise<Response> {
  if (input.prices.length === 0) {
    return errorJson(
      "feature_unavailable",
      "Stripe usage invoice item prices are not configured.",
      503,
    );
  }
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const billingAccountId = stringValue(body.billingAccountId);
  if (!billingAccountId) {
    return errorJson("invalid_request", "billingAccountId is required", 400);
  }
  const windowStart = optionalTimestampBodyValue(body.windowStart);
  const windowEnd = optionalTimestampBodyValue(body.windowEnd);
  const lateArrivalAcceptedUntil = optionalTimestampBodyValue(
    body.lateArrivalAcceptedUntil,
  );
  if (
    windowStart === "invalid" ||
    windowEnd === "invalid" ||
    lateArrivalAcceptedUntil === "invalid" ||
    (windowStart !== undefined &&
      windowEnd !== undefined &&
      windowEnd < windowStart)
  ) {
    return errorJson(
      "invalid_request",
      "windowStart, windowEnd, and lateArrivalAcceptedUntil must be non-negative timestamps",
      400,
    );
  }
  const metadata = optionalStringMetadata(body.metadata);
  if (metadata === "invalid") {
    return errorJson(
      "invalid_request",
      "metadata must be an object with string values",
      400,
    );
  }

  try {
    const result = await createStripeUsageInvoiceItemsForBillingAccount({
      store: input.store,
      secretKey: input.stripe.secretKey,
      billingAccountId,
      prices: input.prices,
      policy: {
        ...(windowStart === undefined ? {} : { windowStart }),
        ...(windowEnd === undefined ? {} : { windowEnd }),
        ...(lateArrivalAcceptedUntil === undefined
          ? {}
          : { lateArrivalAcceptedUntil }),
      },
      ...(metadata === undefined ? {} : { metadata }),
      fetch: input.stripe.fetch,
      stripeApiBase: input.stripe.stripeApiBase,
    });
    return json({
      billing_account_id: result.billingAccountId,
      stripe_customer_id: result.stripeCustomerId,
      exported: result.exported.map(serializeStripeUsageInvoiceItemExport),
    });
  } catch (error) {
    consoleErrorRedacted("stripe_usage_invoice_item_sync_failed", error);
    if (error instanceof TypeError) {
      return errorJson("invalid_request", error.message, 400);
    }
    return errorJson(
      "usage_invoice_item_sync_failed",
      "Stripe usage invoice item sync failed",
      502,
    );
  }
}

function resolveBillingPlans(
  configured: readonly BillingPlan[] | undefined,
): readonly BillingPlan[] {
  if (configured && configured.length > 0) return configured;
  return parseBillingPlans(readEnvVar("TAKOSUMI_BILLING_PLANS"));
}

function optionalTimestampBodyValue(
  value: unknown,
): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  return numberValue(value) ?? "invalid";
}

function optionalStringMetadata(
  value: unknown,
): Record<string, string> | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "invalid";
  const output: Record<string, string> = {};
  for (const [key, metadataValue] of Object.entries(value)) {
    if (typeof metadataValue !== "string") return "invalid";
    output[key] = metadataValue;
  }
  return output;
}

function serializeStripeUsageInvoiceItemExport(
  entry: StripeUsageInvoiceItemExport,
) {
  return {
    meter: entry.meter,
    unit: entry.unit,
    quantity: entry.quantity,
    usage_report_count: entry.usageReportCount,
    usage_report_ids: entry.usageReportIds,
    export_id: entry.exportId,
    invoice_item_id: entry.invoiceItemId,
  };
}

function resolveBillingRedirectAllowlist(
  configured: readonly string[] | undefined,
): readonly string[] | undefined {
  if (configured && configured.length > 0) {
    return normalizeBillingRedirectAllowlist(configured);
  }
  const env = readBillingRedirectAllowlistEnv();
  if (env.length > 0) return normalizeBillingRedirectAllowlist(env);
  return undefined;
}

function normalizeBillingRedirectAllowlist(
  entries: readonly string[],
): readonly string[] {
  const origins: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      // Take only the origin to prevent path / query smuggling in the
      // allowlist itself.
      const origin = parsed.origin;
      if (origin && !origins.includes(origin)) origins.push(origin);
    } catch {
      // ignore malformed entries
    }
  }
  return origins;
}

function readBillingRedirectAllowlistEnv(): readonly string[] {
  const raw = readEnvVar("TAKOSUMI_ACCOUNTS_BILLING_REDIRECT_ALLOWLIST");
  if (!raw) return [];
  return raw.split(/[\s,]+/).filter((entry) => entry.length > 0);
}

function isAllowedBillingRedirect(
  candidate: string,
  allowlist: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (!isHttpsOrLoopbackHttp(parsed)) return false;
  return allowlist.includes(parsed.origin);
}

function isHttpsOrLoopbackHttp(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)
  );
}

export async function handleStripeWebhookRequest(input: {
  request: Request;
  store: AccountsStore;
  stripe: StripeBillingOptions;
  billingReconciler?: StripeSpaceBillingReconciler;
  billingCreditReconciler?: StripeSpaceCreditReconciler;
}): Promise<Response> {
  const signature = input.request.headers.get("stripe-signature");
  if (!signature)
    return errorJson("missing_signature", "missing signature", 400);
  const payload = await input.request.text();

  try {
    const result = await handleStripeWebhook({
      store: input.store,
      payload,
      signature,
      secret: input.stripe.webhookSecret,
      toleranceSeconds: input.stripe.webhookToleranceSeconds,
      // Lets dispute webhooks (which omit a top-level customer) resolve the
      // owning customer via the Stripe API instead of being dropped.
      stripeSecretKey: input.stripe.secretKey,
      fetch: input.stripe.fetch,
      stripeApiBase: input.stripe.stripeApiBase,
    });
    if (!result.duplicate && result.applyResult?.applied) {
      const reconciliation = stripeSpaceBillingReconciliationInput(
        payload,
        result.applyResult.billingAccount,
      );
      if (reconciliation) {
        await input.billingReconciler?.(reconciliation.spaceId, {
          stripeCustomerId: reconciliation.stripeCustomerId,
          stripeSubscriptionId: reconciliation.stripeSubscriptionId,
          stripePriceId: reconciliation.stripePriceId,
          planCode: reconciliation.planCode,
          status: reconciliation.status,
          currentPeriodEndUnix: reconciliation.currentPeriodEndUnix,
        });
      }
      const creditReconciliation =
        stripeSpaceCreditReconciliationInput(payload);
      if (creditReconciliation) {
        await input.billingCreditReconciler?.(creditReconciliation.spaceId, {
          credits: creditReconciliation.credits,
          stripeEventId: creditReconciliation.stripeEventId,
          ...(creditReconciliation.stripeCheckoutSessionId
            ? {
                stripeCheckoutSessionId:
                  creditReconciliation.stripeCheckoutSessionId,
              }
            : {}),
        });
      }
      // Subscription plans grant their credits per PAID INVOICE: checkout
      // stamped the plan metadata onto the subscription
      // (`subscription_data[metadata]`), so every invoice carries it under
      // `subscription_details.metadata`. The webhook idempotency claim above
      // already guarantees one grant per Stripe event.
      const invoiceCredit = stripeInvoiceCreditReconciliationInput(payload);
      if (invoiceCredit) {
        await input.billingCreditReconciler?.(invoiceCredit.spaceId, {
          credits: invoiceCredit.credits,
          stripeEventId: invoiceCredit.stripeEventId,
        });
      }
    }
    return json({
      received: result.received,
      duplicate: result.duplicate,
      event_id: result.eventId,
      status: result.status,
      error: result.errorMessage,
    });
  } catch {
    return errorJson("invalid_signature", "invalid signature", 400);
  }
}

export type StripeSpaceBillingReconciler = (
  spaceId: string,
  input: {
    readonly stripeCustomerId: string;
    readonly stripeSubscriptionId: string;
    readonly stripePriceId?: string;
    readonly planCode: string;
    readonly status: string;
    readonly currentPeriodEndUnix?: number;
  },
) => unknown | Promise<unknown>;

export type StripeSpaceCreditReconciler = (
  spaceId: string,
  input: {
    readonly credits: number;
    readonly stripeEventId: string;
    readonly stripeCheckoutSessionId?: string;
  },
) => unknown | Promise<unknown>;

function stripeSpaceBillingReconciliationInput(
  payload: string,
  account: {
    readonly stripeCustomerId?: string;
    readonly stripeSubscriptionId?: string;
    readonly stripePriceId?: string;
    readonly planCode?: string;
    readonly status: string;
    readonly currentPeriodEndUnix?: number;
  },
):
  | {
      readonly spaceId: string;
      readonly stripeCustomerId: string;
      readonly stripeSubscriptionId: string;
      readonly stripePriceId?: string;
      readonly planCode: string;
      readonly status: string;
      readonly currentPeriodEndUnix?: number;
    }
  | undefined {
  const event = safeJsonRecord(payload);
  const object =
    isRecord(event?.data) && isRecord(event.data.object)
      ? event.data.object
      : undefined;
  const metadata = isRecord(object?.metadata) ? object.metadata : undefined;
  const spaceId = stringValue(metadata?.space_id ?? metadata?.spaceId);
  const stripeCustomerId = account.stripeCustomerId;
  const stripeSubscriptionId = account.stripeSubscriptionId;
  const planCode =
    account.planCode ?? stringValue(metadata?.plan_code ?? metadata?.planCode);
  if (!spaceId || !stripeCustomerId || !stripeSubscriptionId || !planCode) {
    return undefined;
  }
  return {
    spaceId,
    stripeCustomerId,
    stripeSubscriptionId,
    ...(account.stripePriceId ? { stripePriceId: account.stripePriceId } : {}),
    planCode,
    status: account.status,
    ...(account.currentPeriodEndUnix !== undefined
      ? { currentPeriodEndUnix: account.currentPeriodEndUnix }
      : {}),
  };
}

function stripeSpaceCreditReconciliationInput(payload: string):
  | {
      readonly spaceId: string;
      readonly credits: number;
      readonly stripeEventId: string;
      readonly stripeCheckoutSessionId?: string;
    }
  | undefined {
  const event = safeJsonRecord(payload);
  const object =
    isRecord(event?.data) && isRecord(event.data.object)
      ? event.data.object
      : undefined;
  const metadata = isRecord(object?.metadata) ? object.metadata : undefined;
  const spaceId = stringValue(metadata?.space_id ?? metadata?.spaceId);
  const credits = positiveIntegerValue(
    metadata?.credits ?? metadata?.takosumi_credits,
  );
  const stripeEventId = stringValue(event?.id);
  const stripeCheckoutSessionId = stringValue(object?.id);
  const mode = stringValue(object?.mode);
  const paymentStatus = stringValue(object?.payment_status);
  if (
    !spaceId ||
    !credits ||
    !stripeEventId ||
    mode !== "payment" ||
    paymentStatus !== "paid"
  ) {
    return undefined;
  }
  return {
    spaceId,
    credits,
    stripeEventId,
    ...(stripeCheckoutSessionId ? { stripeCheckoutSessionId } : {}),
  };
}

/**
 * Monthly subscription credit grant: a paid invoice whose parent subscription
 * carries the plan metadata (`space_id` + `credits`, stamped at checkout via
 * `subscription_data[metadata]`). Exported for tests.
 */
export function stripeInvoiceCreditReconciliationInput(payload: string):
  | {
      readonly spaceId: string;
      readonly credits: number;
      readonly stripeEventId: string;
    }
  | undefined {
  const event = safeJsonRecord(payload);
  const type = stringValue(event?.type);
  if (type !== "invoice.paid" && type !== "invoice.payment_succeeded") {
    return undefined;
  }
  const object =
    isRecord(event?.data) && isRecord(event.data.object)
      ? event.data.object
      : undefined;
  const metadata = invoiceSubscriptionMetadata(object);
  const spaceId = stringValue(metadata?.space_id ?? metadata?.spaceId);
  const credits = positiveIntegerValue(
    metadata?.credits ?? metadata?.takosumi_credits,
  );
  const stripeEventId = stringValue(event?.id);
  if (!spaceId || !credits || !stripeEventId) return undefined;
  return { spaceId, credits, stripeEventId };
}

function invoiceSubscriptionMetadata(
  object: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const legacySubscriptionDetails = isRecord(object?.subscription_details)
    ? object.subscription_details
    : undefined;
  if (isRecord(legacySubscriptionDetails?.metadata)) {
    return legacySubscriptionDetails.metadata;
  }
  const parent = isRecord(object?.parent) ? object.parent : undefined;
  const parentSubscriptionDetails = isRecord(parent?.subscription_details)
    ? parent.subscription_details
    : undefined;
  return isRecord(parentSubscriptionDetails?.metadata)
    ? parentSubscriptionDetails.metadata
    : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function safeJsonRecord(payload: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
