import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { createStripeCheckoutSession, handleStripeWebhook } from "./billing.ts";
import type { AccountsStore } from "./store.ts";
import type { StripeBillingOptions } from "./mod.ts";
import {
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
  if (!body) return json({ error: "invalid_request" }, 400);

  const subject = takosumiSubjectValue(body.subject);
  const priceId = stringValue(body.priceId);
  const mode = body.mode === "payment" || body.mode === "subscription"
    ? body.mode
    : undefined;
  const successUrl = stringValue(body.successUrl);
  const cancelUrl = stringValue(body.cancelUrl);
  if (!subject || !priceId || !mode || !successUrl || !cancelUrl) {
    return json({
      error: "invalid_request",
      error_description:
        "subject, priceId, mode, successUrl, and cancelUrl are required",
    }, 400);
  }
  if (subject !== input.sessionSubject) {
    return json({
      error: "subject_mismatch",
      error_description:
        "checkout body subject does not match the authenticated session",
    }, 403);
  }
  const allowlist = resolveBillingRedirectAllowlist(
    input.billingRedirectAllowlist,
  );
  if (!allowlist || allowlist.length === 0) {
    return json({
      error: "feature_unavailable",
      error_description: "Billing redirect allowlist is not configured.",
    }, 503);
  }
  if (!isAllowedBillingRedirect(successUrl, allowlist)) {
    return json({
      error: "invalid_redirect_uri",
      error_description: "successUrl origin is not in the billing allowlist",
    }, 400);
  }
  if (!isAllowedBillingRedirect(cancelUrl, allowlist)) {
    return json({
      error: "invalid_redirect_uri",
      error_description: "cancelUrl origin is not in the billing allowlist",
    }, 400);
  }

  const account = await input.store.findAccount(subject);
  if (!account) return json({ error: "account_not_found" }, 404);
  const metadata = stringRecordValue(body.metadata);
  if (body.metadata !== undefined && !metadata) {
    return json({ error: "invalid_request" }, 400);
  }
  const existingBilling = await input.store.findBillingAccountForSubject(
    subject,
  );

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
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "checkout_failed",
      error_description: "billing checkout failed",
    }, 502);
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
}): Promise<Response> {
  const signature = input.request.headers.get("stripe-signature");
  if (!signature) return json({ error: "missing_signature" }, 400);

  try {
    const result = await handleStripeWebhook({
      store: input.store,
      payload: await input.request.text(),
      signature,
      secret: input.stripe.webhookSecret,
      toleranceSeconds: input.stripe.webhookToleranceSeconds,
      // Lets dispute webhooks (which omit a top-level customer) resolve the
      // owning customer via the Stripe API instead of being dropped.
      stripeSecretKey: input.stripe.secretKey,
      fetch: input.stripe.fetch,
      stripeApiBase: input.stripe.stripeApiBase,
    });
    return json({
      received: result.received,
      duplicate: result.duplicate,
      event_id: result.eventId,
      status: result.status,
      error: result.errorMessage,
    });
  } catch {
    return json({ error: "invalid_signature" }, 400);
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
