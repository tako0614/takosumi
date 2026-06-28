import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "./store.ts";
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
export const TAKOSUMI_ACCOUNTS_BILLING_SMOKE_TOKEN_HEADER =
  "x-takosumi-billing-smoke-token";

const STRIPE_API_VERSION = "2026-02-25.clover";
const STRIPE_CHECKOUT_SESSIONS_URL =
  "https://api.stripe.com/v1/checkout/sessions";

export interface StripeBillingCheckoutPlan {
  readonly id: string;
  readonly kind: string;
  readonly stripePriceId: string;
}

export interface StripeBillingCheckoutOptions {
  readonly stripeSecretKey: string;
  readonly plans: readonly StripeBillingCheckoutPlan[];
  readonly redirectAllowlist: readonly string[];
  readonly smokeToken?: string;
  readonly fetch?: typeof fetch;
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
  const workspaceId = stringValue(body.spaceId);
  const planId = stringValue(body.planId);
  const successUrl = stringValue(body.successUrl);
  const cancelUrl = stringValue(body.cancelUrl);
  if (!workspaceId || !planId || !successUrl || !cancelUrl) {
    return errorJson(
      "invalid_request",
      "planId, spaceId, successUrl, and cancelUrl are required",
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
  setMetadata(params, "metadata", { subject, workspaceId, planId: plan.id });
  if (mode === "subscription") {
    setMetadata(params, "subscription_data[metadata]", {
      subject,
      workspaceId,
      planId: plan.id,
    });
  } else {
    params.set("customer_creation", "always");
    setMetadata(params, "payment_intent_data[metadata]", {
      subject,
      workspaceId,
      planId: plan.id,
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
  },
): void {
  params.set(`${prefix}[takosumi_subject]`, values.subject);
  params.set(`${prefix}[takosumi_workspace_id]`, values.workspaceId);
  params.set(`${prefix}[takosumi_plan_id]`, values.planId);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripeErrorMessage(body: Record<string, unknown> | null): string {
  const error = isRecord(body?.error) ? body.error : undefined;
  return (
    stringValue(error?.message) ??
    "Stripe Checkout Session creation was rejected"
  );
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
