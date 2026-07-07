import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore, BillingWebhookEventRecord } from "./store.ts";
import type { ControlPlaneOperations } from "./control-operations.ts";
import { requireAccountSession } from "./account-session.ts";
import {
  errorJson,
  isRecord,
  json,
  readJsonObject,
  stringValue,
} from "./http-helpers.ts";
import { requireWorkspaceAccess } from "./control/shared.ts";

export const TAKOSUMI_ACCOUNTS_BILLING_STRIPE_CHECKOUT_PATH =
  "/v1/billing/stripe/checkout";
export const TAKOSUMI_ACCOUNTS_BILLING_STRIPE_PORTAL_PATH =
  "/v1/billing/stripe/portal";
export const TAKOSUMI_ACCOUNTS_BILLING_STRIPE_WEBHOOK_PATH =
  "/v1/billing/stripe/webhook";
export const TAKOSUMI_ACCOUNTS_BILLING_SMOKE_TOKEN_HEADER =
  "x-takosumi-billing-smoke-token";

const STRIPE_API_VERSION = "2026-02-25.clover";
const STRIPE_CHECKOUT_SESSIONS_URL =
  "https://api.stripe.com/v1/checkout/sessions";
const STRIPE_BILLING_PORTAL_SESSIONS_URL =
  "https://api.stripe.com/v1/billing_portal/sessions";

export interface StripeBillingCheckoutPlan {
  readonly id: string;
  readonly kind: string;
  readonly stripePriceId: string;
  readonly usdMicros?: number;
}

export interface StripeBillingCheckoutOptions {
  readonly stripeSecretKey: string;
  readonly plans: readonly StripeBillingCheckoutPlan[];
  readonly redirectAllowlist: readonly string[];
  readonly smokeToken?: string;
  readonly fetch?: typeof fetch;
}

export interface StripeBillingWebhookOptions {
  readonly webhookSecret: string;
  readonly plans: readonly StripeBillingCheckoutPlan[];
  readonly toleranceSeconds?: number;
}

export async function handleStripeBillingCheckout(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly checkout: StripeBillingCheckoutOptions;
}): Promise<Response> {
  const session = await requireAccountSession({
    request: input.request,
    store: input.store,
  });
  if (!session.ok) return session.response;

  const body = await readJsonObject(input.request);
  if (!body) {
    return errorJson(
      "invalid_request",
      "request body must be a JSON object",
      400,
      input.request,
    );
  }

  const subject = stringValue(body.subject) ?? session.subject;
  if (subject !== session.subject) {
    return errorJson(
      "forbidden",
      "checkout subject must match the authenticated session",
      403,
      input.request,
    );
  }
  const workspaceId =
    stringValue(body.workspaceId) ?? stringValue(body.spaceId);
  const planId = stringValue(body.planId);
  const successUrl = stringValue(body.successUrl);
  const cancelUrl = stringValue(body.cancelUrl);
  if (!workspaceId || !planId || !successUrl || !cancelUrl) {
    return errorJson(
      "invalid_request",
      "planId, workspaceId, successUrl, and cancelUrl are required",
      400,
      input.request,
    );
  }
  if (!redirectAllowed(successUrl, input.checkout.redirectAllowlist)) {
    return errorJson(
      "invalid_redirect",
      "successUrl is not in the billing redirect allowlist",
      400,
      input.request,
    );
  }
  if (!redirectAllowed(cancelUrl, input.checkout.redirectAllowlist)) {
    return errorJson(
      "invalid_redirect",
      "cancelUrl is not in the billing redirect allowlist",
      400,
      input.request,
    );
  }
  if (!input.operations) {
    return errorJson(
      "feature_unavailable",
      "billing checkout requires the control-plane operations facade",
      503,
      input.request,
    );
  }

  const access = await requireWorkspaceAccess({
    operations: input.operations,
    store: input.store,
    subject,
    workspaceId,
  });
  if (!access.ok) return access.response;

  const plan = input.checkout.plans.find((entry) => entry.id === planId);
  if (!plan) {
    return errorJson("not_found", "billing plan not found", 404, input.request);
  }

  const params = new URLSearchParams();
  const mode = plan.kind === "subscription" ? "subscription" : "payment";
  params.set("mode", mode);
  params.set("line_items[0][price]", plan.stripePriceId);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("client_reference_id", `${subject}:${workspaceId}:${plan.id}`);
  setMetadata(params, "metadata", {
    subject,
    workspaceId,
    planId: plan.id,
    usdMicros: plan.usdMicros,
  });
  if (mode === "subscription") {
    setMetadata(params, "subscription_data[metadata]", {
      subject,
      workspaceId,
      planId: plan.id,
      usdMicros: plan.usdMicros,
    });
  } else {
    params.set("customer_creation", "always");
    setMetadata(params, "payment_intent_data[metadata]", {
      subject,
      workspaceId,
      planId: plan.id,
      usdMicros: plan.usdMicros,
    });
  }

  const existingBilling = await input.store.findBillingAccountForSubject(
    subject as TakosumiSubject,
  );
  if (existingBilling?.stripeCustomerId) {
    params.set("customer", existingBilling.stripeCustomerId);
  }

  const stripeFetch = input.checkout.fetch ?? fetch;
  let stripeResponse: Response;
  let stripeBodyText = "";
  try {
    stripeResponse = await stripeFetch(STRIPE_CHECKOUT_SESSIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.checkout.stripeSecretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": STRIPE_API_VERSION,
      },
      body: params,
    });
    stripeBodyText = await stripeResponse.text();
  } catch {
    return errorJson(
      "stripe_checkout_failed",
      "Stripe Checkout Session creation failed",
      502,
      input.request,
    );
  }

  const stripeBody = parseJsonObject(stripeBodyText);
  if (!stripeResponse.ok) {
    return errorJson(
      "stripe_checkout_failed",
      stripeErrorMessage(stripeBody),
      502,
      input.request,
      {},
      stripeErrorDetails(stripeBody),
    );
  }
  const sessionId = stringValue(stripeBody?.id);
  const checkoutUrl = stringValue(stripeBody?.url);
  if (!sessionId || !checkoutUrl) {
    return errorJson(
      "stripe_checkout_failed",
      "Stripe Checkout response did not include a Checkout Session id and URL",
      502,
      input.request,
    );
  }
  return json(
    {
      session_id: sessionId,
      url: checkoutUrl,
      mode,
      plan_id: plan.id,
      workspace_id: workspaceId,
    },
    201,
    { "cache-control": "no-store" },
  );
}

export async function handleStripeBillingPortal(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly portal: StripeBillingCheckoutOptions;
}): Promise<Response> {
  const session = await requireAccountSession({
    request: input.request,
    store: input.store,
  });
  if (!session.ok) return session.response;

  const body = await readJsonObject(input.request);
  if (!body) {
    return errorJson(
      "invalid_request",
      "request body must be a JSON object",
      400,
      input.request,
    );
  }

  const subject = stringValue(body.subject) ?? session.subject;
  if (subject !== session.subject) {
    return errorJson(
      "forbidden",
      "portal subject must match the authenticated session",
      403,
      input.request,
    );
  }
  const returnUrl = stringValue(body.returnUrl);
  if (!returnUrl) {
    return errorJson(
      "invalid_request",
      "returnUrl is required",
      400,
      input.request,
    );
  }
  if (!redirectAllowed(returnUrl, input.portal.redirectAllowlist)) {
    return errorJson(
      "invalid_redirect",
      "returnUrl is not in the billing redirect allowlist",
      400,
      input.request,
    );
  }

  const existingBilling = await input.store.findBillingAccountForSubject(
    subject as TakosumiSubject,
  );
  if (!existingBilling?.stripeCustomerId) {
    return errorJson(
      "billing_customer_required",
      "Stripe customer is not available for this account yet",
      409,
      input.request,
    );
  }

  const params = new URLSearchParams();
  params.set("customer", existingBilling.stripeCustomerId);
  params.set("return_url", returnUrl);

  const stripeFetch = input.portal.fetch ?? fetch;
  let stripeResponse: Response;
  let stripeBodyText = "";
  try {
    stripeResponse = await stripeFetch(STRIPE_BILLING_PORTAL_SESSIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.portal.stripeSecretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": STRIPE_API_VERSION,
      },
      body: params,
    });
    stripeBodyText = await stripeResponse.text();
  } catch {
    return errorJson(
      "stripe_portal_failed",
      "Stripe Billing Portal Session creation failed",
      502,
      input.request,
    );
  }

  const stripeBody = parseJsonObject(stripeBodyText);
  if (!stripeResponse.ok) {
    return errorJson(
      "stripe_portal_failed",
      stripeErrorMessage(
        stripeBody,
        "Stripe Billing Portal Session creation was rejected",
      ),
      502,
      input.request,
      {},
      stripeErrorDetails(stripeBody),
    );
  }
  const sessionId = stringValue(stripeBody?.id);
  const portalUrl = stringValue(stripeBody?.url);
  if (!sessionId || !portalUrl) {
    return errorJson(
      "stripe_portal_failed",
      "Stripe Billing Portal response did not include a Session id and URL",
      502,
      input.request,
    );
  }
  return json(
    {
      session_id: sessionId,
      url: portalUrl,
    },
    201,
    { "cache-control": "no-store" },
  );
}

export async function handleStripeBillingWebhook(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly webhook: StripeBillingWebhookOptions;
}): Promise<Response> {
  const signature = input.request.headers.get("stripe-signature");
  if (!signature) {
    return errorJson(
      "invalid_request",
      "Stripe-Signature header is required",
      400,
      input.request,
    );
  }
  const payload = await input.request.text();
  let event: StripeWebhookEvent;
  try {
    event = await verifyStripeWebhookEvent({
      payload,
      signature,
      secret: input.webhook.webhookSecret,
      toleranceSeconds: input.webhook.toleranceSeconds,
    });
  } catch (error) {
    return errorJson(
      "invalid_signature",
      error instanceof Error
        ? error.message
        : "Stripe webhook verification failed",
      400,
      input.request,
    );
  }

  const now = Date.now();
  const claim = await input.store.claimBillingWebhookEvent({
    eventId: event.id,
    eventType: event.type,
    status: "received",
    receivedAt: now,
    updatedAt: now,
  });
  if (!claim.inserted) {
    if (shouldRetryBillingWebhookEvent(claim.existing, now)) {
      await input.store.saveBillingWebhookEvent({
        eventId: event.id,
        eventType: event.type,
        status: "received",
        receivedAt: claim.existing.receivedAt,
        updatedAt: now,
      });
    } else {
      return json(
        {
          received: true,
          duplicate: true,
          event_id: event.id,
          status: claim.existing.status,
        },
        200,
        { "cache-control": "no-store" },
      );
    }
  }

  let apply: StripeWebhookApplyResult;
  try {
    apply = await applyStripeWebhookToBilling({
      event,
      store: input.store,
      operations: input.operations,
      plans: input.webhook.plans,
      now,
    });
  } catch (error) {
    const reason = webhookFailureReason(error);
    await input.store.saveBillingWebhookEvent({
      eventId: event.id,
      eventType: event.type,
      status: "failed",
      receivedAt: now,
      updatedAt: Date.now(),
      errorMessage: reason,
    });
    return errorJson(
      "webhook_processing_failed",
      "Stripe webhook processing failed",
      500,
      input.request,
      {},
      { reason },
    );
  }

  await input.store.saveBillingWebhookEvent({
    eventId: event.id,
    eventType: event.type,
    status: apply.ok ? apply.status : "failed",
    receivedAt: now,
    updatedAt: Date.now(),
    ...(apply.ok ? {} : { errorMessage: apply.reason }),
  });
  return json(
    {
      received: true,
      duplicate: false,
      event_id: event.id,
      status: apply.ok ? apply.status : "failed",
      ...(apply.ok ? {} : { reason: apply.reason }),
    },
    200,
    { "cache-control": "no-store" },
  );
}

function shouldRetryBillingWebhookEvent(
  record: BillingWebhookEventRecord,
  now: number,
): boolean {
  if (record.status === "failed") return true;
  return record.status === "received" && now - record.updatedAt > 5 * 60 * 1000;
}

function webhookFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : "webhook_processing_failed";
}

function redirectAllowed(
  urlValue: string,
  allowlist: readonly string[],
): boolean {
  try {
    const origin = new URL(urlValue).origin;
    return allowlist.includes(origin);
  } catch {
    return false;
  }
}

function setMetadata(
  params: URLSearchParams,
  prefix: string,
  values: {
    readonly subject: string;
    readonly workspaceId: string;
    readonly planId: string;
    readonly usdMicros?: number;
  },
): void {
  params.set(`${prefix}[takosumi_subject]`, values.subject);
  params.set(`${prefix}[takosumi_workspace_id]`, values.workspaceId);
  params.set(`${prefix}[takosumi_plan_id]`, values.planId);
  params.set(`${prefix}[space_id]`, values.workspaceId);
  params.set(`${prefix}[workspaceId]`, values.workspaceId);
  params.set(`${prefix}[plan_code]`, values.planId);
  params.set(`${prefix}[planCode]`, values.planId);
  if (positiveSafeInteger(values.usdMicros)) {
    params.set(`${prefix}[usd_micros]`, String(values.usdMicros));
    params.set(`${prefix}[usdMicros]`, String(values.usdMicros));
    params.set(`${prefix}[takosumi_usd_micros]`, String(values.usdMicros));
    params.set(
      `${prefix}[takosumi_credits]`,
      String(values.usdMicros / 1_000_000),
    );
  }
}

interface StripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly data: {
    readonly object: unknown;
    readonly previous_attributes?: unknown;
  };
}

type StripeWebhookApplyResult =
  | { readonly ok: true; readonly status: "processed" | "skipped" }
  | { readonly ok: false; readonly reason: string };

async function applyStripeWebhookToBilling(input: {
  readonly event: StripeWebhookEvent;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly plans: readonly StripeBillingCheckoutPlan[];
  readonly now: number;
}): Promise<StripeWebhookApplyResult> {
  const object = isRecord(input.event.data.object)
    ? input.event.data.object
    : {};
  switch (input.event.type) {
    case "checkout.session.completed":
      return await applyCheckoutCompleted({ ...input, object });
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return await applyInvoicePaid({ ...input, object });
    case "invoice.payment_failed":
      return await applyCustomerStatusEvent(
        input.store,
        object,
        "past_due",
        input.now,
      );
    case "customer.subscription.updated":
      return await applySubscriptionStatusUpdated(
        input.store,
        object,
        input.now,
      );
    case "customer.subscription.deleted":
      return await applyCustomerStatusEvent(
        input.store,
        object,
        "canceled",
        input.now,
      );
    default:
      return { ok: true, status: "skipped" };
  }
}

async function applyCheckoutCompleted(input: {
  readonly event: StripeWebhookEvent;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly plans: readonly StripeBillingCheckoutPlan[];
  readonly now: number;
  readonly object: Record<string, unknown>;
}): Promise<StripeWebhookApplyResult> {
  const metadata = metadataRecord(input.object);
  const subject = takosumiSubjectFromMetadata(metadata);
  const workspaceId = workspaceIdFromMetadata(metadata);
  const planId = planIdFromMetadata(metadata);
  const customerId = stripeId(input.object.customer);
  if (!subject || !workspaceId || !planId || !customerId) {
    return { ok: false, reason: "missing_checkout_metadata" };
  }
  const account = await input.store.findAccount(subject);
  if (!account) return { ok: false, reason: "unknown_account" };
  const plan = input.plans.find((entry) => entry.id === planId);
  if (!plan) return { ok: false, reason: "unknown_plan" };
  const subscriptionId = stripeId(input.object.subscription);
  const status = checkoutBillingStatus(input.object);
  await upsertBillingAccount({
    store: input.store,
    subject,
    customerId,
    subscriptionId,
    stripePriceId: plan.stripePriceId,
    planCode: plan.id,
    status,
    now: input.now,
  });
  if (
    plan.kind !== "subscription" &&
    status === "active" &&
    positiveSafeInteger(plan.usdMicros)
  ) {
    await topUpWorkspaceCredits(input.operations, workspaceId, plan.usdMicros);
  }
  return { ok: true, status: "processed" };
}

async function applyInvoicePaid(input: {
  readonly event: StripeWebhookEvent;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly plans: readonly StripeBillingCheckoutPlan[];
  readonly now: number;
  readonly object: Record<string, unknown>;
}): Promise<StripeWebhookApplyResult> {
  const metadata = invoiceSubscriptionMetadata(input.object);
  const workspaceId = workspaceIdFromMetadata(metadata);
  const planId = planIdFromMetadata(metadata);
  const customerId = stripeId(input.object.customer);
  if (!workspaceId || !customerId) {
    return { ok: false, reason: "missing_invoice_metadata" };
  }
  const existing =
    await input.store.findBillingAccountByStripeCustomerId(customerId);
  const plan =
    (planId ? input.plans.find((entry) => entry.id === planId) : undefined) ??
    input.plans.find((entry) => entry.id === existing?.planCode);
  if (!plan) return { ok: false, reason: "unknown_plan" };
  if (existing) {
    await saveBillingAccountWithRetry(input.store, existing, (record) => ({
      ...record,
      status: "active",
      stripePriceId: plan.stripePriceId,
      planCode: plan.id,
      lastInvoiceId: stripeId(input.object.id) ?? record.lastInvoiceId,
      currentPeriodEndUnix:
        invoicePeriodEndUnix(input.object) ?? record.currentPeriodEndUnix,
      updatedAt: input.now,
    }));
  }
  const usdMicros =
    positiveUsdMicrosMetadataValue(metadata) ??
    (positiveSafeInteger(plan.usdMicros) ? plan.usdMicros : undefined);
  if (positiveSafeInteger(usdMicros)) {
    await topUpWorkspaceCredits(input.operations, workspaceId, usdMicros);
  }
  return { ok: true, status: "processed" };
}

async function applySubscriptionStatusUpdated(
  store: AccountsStore,
  object: Record<string, unknown>,
  now: number,
): Promise<StripeWebhookApplyResult> {
  const customerId = stripeId(object.customer);
  if (!customerId) return { ok: false, reason: "unknown_customer" };
  const status = subscriptionStatus(stringValue(object.status));
  return await applyCustomerStatusEvent(store, object, status, now);
}

async function applyCustomerStatusEvent(
  store: AccountsStore,
  object: Record<string, unknown>,
  status: BillingAccountStatus,
  now: number,
): Promise<StripeWebhookApplyResult> {
  const customerId = stripeId(object.customer);
  if (!customerId) return { ok: false, reason: "unknown_customer" };
  const existing = await store.findBillingAccountByStripeCustomerId(customerId);
  if (!existing) return { ok: true, status: "skipped" };
  await saveBillingAccountWithRetry(store, existing, (record) => ({
    ...record,
    status,
    stripeSubscriptionId:
      status === "canceled"
        ? undefined
        : (stripeId(object.id) ?? record.stripeSubscriptionId),
    currentPeriodEndUnix:
      status === "canceled"
        ? undefined
        : (subscriptionPeriodEndUnix(object) ?? record.currentPeriodEndUnix),
    updatedAt: now,
  }));
  return { ok: true, status: "processed" };
}

type BillingAccountStatus =
  | "active"
  | "trialing"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "paused"
  | "disputed";

async function upsertBillingAccount(input: {
  readonly store: AccountsStore;
  readonly subject: TakosumiSubject;
  readonly customerId: string;
  readonly subscriptionId?: string;
  readonly stripePriceId?: string;
  readonly planCode?: string;
  readonly status: BillingAccountStatus;
  readonly now: number;
}): Promise<void> {
  const existing = await input.store.findBillingAccountForSubject(
    input.subject,
  );
  if (!existing) {
    await input.store.saveBillingAccount({
      billingAccountId: await billingAccountIdForSubject(input.subject),
      subject: input.subject,
      provider: "stripe",
      stripeCustomerId: input.customerId,
      stripeSubscriptionId: input.subscriptionId,
      stripePriceId: input.stripePriceId,
      planCode: input.planCode,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return;
  }
  await saveBillingAccountWithRetry(input.store, existing, (record) => ({
    ...record,
    stripeCustomerId: input.customerId,
    stripeSubscriptionId: input.subscriptionId ?? record.stripeSubscriptionId,
    stripePriceId: input.stripePriceId ?? record.stripePriceId,
    planCode: input.planCode ?? record.planCode,
    status: input.status,
    updatedAt: input.now,
  }));
}

async function saveBillingAccountWithRetry(
  store: AccountsStore,
  initial: NonNullable<
    Awaited<ReturnType<AccountsStore["findBillingAccount"]>>
  >,
  update: (
    record: NonNullable<
      Awaited<ReturnType<AccountsStore["findBillingAccount"]>>
    >,
  ) => NonNullable<Awaited<ReturnType<AccountsStore["findBillingAccount"]>>>,
): Promise<void> {
  let current:
    | NonNullable<Awaited<ReturnType<AccountsStore["findBillingAccount"]>>>
    | undefined = initial;
  for (let attempt = 0; attempt < 5 && current; attempt++) {
    const expectedVersion = current.version ?? 0;
    const saved = await store.saveBillingAccountIfVersion(
      update(current),
      expectedVersion,
    );
    if (saved) return;
    current = await store.findBillingAccount(current.billingAccountId);
  }
  throw new Error("billing_account_write_conflict");
}

async function billingAccountIdForSubject(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`takosumi-billing-account:${subject}`),
  );
  return `bill_${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function takosumiSubjectFromMetadata(
  metadata: Record<string, unknown>,
): TakosumiSubject | undefined {
  const subject = stringValue(metadata.takosumi_subject);
  return subject?.startsWith("tsub_")
    ? (subject as TakosumiSubject)
    : undefined;
}

async function topUpWorkspaceCredits(
  operations: ControlPlaneOperations | undefined,
  workspaceId: string,
  usdMicros: number,
): Promise<void> {
  if (!operations) throw new Error("control_plane_operations_unavailable");
  await operations.topUpWorkspaceCredits(workspaceId, { usdMicros });
}

async function verifyStripeWebhookEvent(input: {
  readonly payload: string;
  readonly signature: string;
  readonly secret: string;
  readonly toleranceSeconds?: number;
}): Promise<StripeWebhookEvent> {
  const parsed = parseStripeSignatureHeader(input.signature);
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    throw new TypeError("Stripe webhook timestamp is outside tolerance");
  }
  const expected = await hmacSha256Hex(
    input.secret,
    `${parsed.timestamp}.${input.payload}`,
  );
  if (
    !parsed.signatures.some((signature) =>
      timingSafeEqualText(signature, expected),
    )
  ) {
    throw new TypeError("Stripe webhook signature mismatch");
  }
  const event = parseJsonObject(input.payload);
  if (
    !event ||
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    !isRecord(event.data)
  ) {
    throw new TypeError("Stripe webhook payload is missing required fields");
  }
  return {
    id: event.id,
    type: event.type,
    data: {
      object: event.data.object,
      previous_attributes: event.data.previous_attributes,
    },
  };
}

function parseStripeSignatureHeader(value: string): {
  readonly timestamp: number;
  readonly signatures: readonly string[];
} {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const segment of value.split(",")) {
    const [key, raw] = segment.split("=", 2);
    if (key === "t") {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed > 0) timestamp = parsed;
    } else if (key === "v1" && raw) {
      signatures.push(raw);
    }
  }
  if (!timestamp || signatures.length === 0) {
    throw new TypeError("Stripe-Signature header is malformed");
  }
  return { timestamp, signatures };
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index++) {
    result |= left[index]! ^ right[index]!;
  }
  return result === 0;
}

function metadataRecord(
  object: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(object.metadata) ? object.metadata : {};
}

function invoiceSubscriptionMetadata(
  object: Record<string, unknown>,
): Record<string, unknown> {
  const subscriptionDetails = isRecord(object.subscription_details)
    ? object.subscription_details
    : undefined;
  if (isRecord(subscriptionDetails?.metadata)) {
    return subscriptionDetails.metadata;
  }
  const parent = isRecord(object.parent) ? object.parent : undefined;
  const parentSubscriptionDetails = isRecord(parent?.subscription_details)
    ? parent.subscription_details
    : undefined;
  if (isRecord(parentSubscriptionDetails?.metadata)) {
    return parentSubscriptionDetails.metadata;
  }
  return metadataRecord(object);
}

function workspaceIdFromMetadata(
  metadata: Record<string, unknown>,
): string | undefined {
  return stringValue(
    metadata.takosumi_workspace_id ??
      metadata.workspace_id ??
      metadata.space_id ??
      metadata.workspaceId ??
      metadata.spaceId,
  );
}

function planIdFromMetadata(
  metadata: Record<string, unknown>,
): string | undefined {
  return stringValue(
    metadata.takosumi_plan_id ??
      metadata.plan_id ??
      metadata.plan_code ??
      metadata.planId ??
      metadata.planCode,
  );
}

function positiveUsdMicrosMetadataValue(
  metadata: Record<string, unknown>,
): number | undefined {
  return (
    positiveIntegerValue(
      metadata.takosumi_usd_micros ?? metadata.usd_micros ?? metadata.usdMicros,
    ) ?? legacyCreditsToUsdMicros(metadata.takosumi_credits ?? metadata.credits)
  );
}

function positiveIntegerValue(value: unknown): number | undefined {
  if (typeof value === "number" && positiveSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return positiveSafeInteger(parsed) ? parsed : undefined;
}

function legacyCreditsToUsdMicros(value: unknown): number | undefined {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(value)
        ? Number(value)
        : undefined;
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const micros = Math.round(amount * 1_000_000);
  return positiveSafeInteger(micros) ? micros : undefined;
}

function stripeId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }
  return undefined;
}

function checkoutBillingStatus(
  object: Record<string, unknown>,
): BillingAccountStatus {
  const paymentStatus = stringValue(object.payment_status);
  return paymentStatus === "paid" ||
    paymentStatus === "no_payment_required" ||
    stripeId(object.subscription)
    ? "active"
    : "incomplete";
}

function subscriptionStatus(value: string | undefined): BillingAccountStatus {
  switch (value) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return value;
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "incomplete";
  }
}

function invoicePeriodEndUnix(
  object: Record<string, unknown>,
): number | undefined {
  const lines = isRecord(object.lines) ? object.lines : undefined;
  const data = Array.isArray(lines?.data) ? lines.data : [];
  const first = isRecord(data[0]) ? data[0] : undefined;
  const period = isRecord(first?.period) ? first.period : undefined;
  return positiveIntegerValue(period?.end);
}

function subscriptionPeriodEndUnix(
  object: Record<string, unknown>,
): number | undefined {
  return positiveIntegerValue(object.current_period_end);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripeErrorMessage(
  body: Record<string, unknown> | null,
  fallback = "Stripe Checkout Session creation was rejected",
): string {
  const error = isRecord(body?.error) ? body.error : undefined;
  return stringValue(error?.message) ?? fallback;
}

function stripeErrorDetails(
  body: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const error = isRecord(body?.error) ? body.error : undefined;
  const code = stringValue(error?.code);
  const type = stringValue(error?.type);
  return code || type
    ? { ...(code ? { code } : {}), ...(type ? { type } : {}) }
    : undefined;
}
