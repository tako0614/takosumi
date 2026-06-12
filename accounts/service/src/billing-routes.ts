import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  handleStripeWebhook,
} from "./billing.ts";
import type { AccountsStore } from "./store.ts";
import type { StripeBillingOptions } from "./mod.ts";
import {
  errorJson,
  isRecord,
  json,
  readJsonObject,
  stringValue,
  takosumiSubjectValue,
} from "./http-helpers.ts";
import { readEnvVar } from "./read-env.ts";

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
   * must be HTTPS (or http: for explicit dev origins on the list) and the
   * origin must match exactly. When omitted we fall back to the
   * `TAKOSUMI_ACCOUNTS_BILLING_REDIRECT_ALLOWLIST` env var.
   */
  billingRedirectAllowlist?: readonly string[];
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);

  const subject = takosumiSubjectValue(body.subject);
  const priceId = stringValue(body.priceId);
  const mode =
    body.mode === "payment" || body.mode === "subscription"
      ? body.mode
      : undefined;
  const successUrl = stringValue(body.successUrl);
  const cancelUrl = stringValue(body.cancelUrl);
  if (!subject || !priceId || !mode || !successUrl || !cancelUrl) {
    return errorJson("invalid_request", "subject, priceId, mode, successUrl, and cancelUrl are required", 400);
  }
  if (subject !== input.sessionSubject) {
    return errorJson("subject_mismatch", "checkout body subject does not match the authenticated session", 403);
  }
  const allowlist = resolveBillingRedirectAllowlist(
    input.billingRedirectAllowlist,
  );
  if (!allowlist || allowlist.length === 0) {
    return errorJson("feature_unavailable", "Billing redirect allowlist is not configured.", 503);
  }
  if (!isAllowedBillingRedirect(successUrl, allowlist)) {
    return errorJson("invalid_redirect_uri", "successUrl origin is not in the billing allowlist", 400);
  }
  if (!isAllowedBillingRedirect(cancelUrl, allowlist)) {
    return errorJson("invalid_redirect_uri", "cancelUrl origin is not in the billing allowlist", 400);
  }

  const account = await input.store.findAccount(subject);
  if (!account) return errorJson("account_not_found", "account not found", 404);
  const metadata = stringRecordValue(body.metadata);
  if (body.metadata !== undefined && !metadata) {
    return errorJson("invalid_request", "invalid request", 400);
  }
  const existingBilling =
    await input.store.findBillingAccountForSubject(subject);

  try {
    const result = await createStripeCheckoutSession({
      secretKey: input.stripe.secretKey,
      priceId,
      mode,
      subject,
      successUrl,
      cancelUrl,
      stripeCustomerId: existingBilling?.stripeCustomerId,
      customerEmail: stringValue(body.customerEmail) ?? account.email,
      metadata,
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
    console.error(
      "billing_checkout_failed",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
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
    return errorJson("invalid_request", "subject and returnUrl are required", 400);
  }
  if (subject !== input.sessionSubject) {
    return errorJson("subject_mismatch", "portal body subject does not match the authenticated session", 403);
  }

  const allowlist = resolveBillingRedirectAllowlist(
    input.billingRedirectAllowlist,
  );
  if (!allowlist || allowlist.length === 0) {
    return errorJson("feature_unavailable", "Billing redirect allowlist is not configured.", 503);
  }
  if (!isAllowedBillingRedirect(returnUrl, allowlist)) {
    return errorJson("invalid_redirect_uri", "returnUrl origin is not in the billing allowlist", 400);
  }

  const existingBilling =
    await input.store.findBillingAccountForSubject(subject);
  if (!existingBilling?.stripeCustomerId) {
    return errorJson("billing_account_not_linked", "Stripe Customer Portal requires an existing Stripe customer.", 409);
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
    console.error(
      "billing_portal_failed",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return errorJson("portal_failed", "billing portal failed", 502);
  }
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
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return allowlist.includes(parsed.origin);
}

export async function handleStripeWebhookRequest(input: {
  request: Request;
  store: AccountsStore;
  stripe: StripeBillingOptions;
  billingReconciler?: StripeSpaceBillingReconciler;
  billingCreditReconciler?: StripeSpaceCreditReconciler;
}): Promise<Response> {
  const signature = input.request.headers.get("stripe-signature");
  if (!signature) return errorJson("missing_signature", "missing signature", 400);
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

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    output[key] = entry;
  }
  return output;
}
