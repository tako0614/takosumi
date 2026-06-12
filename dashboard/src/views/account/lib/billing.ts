/**
 * Billing RPC for the account plane (Stripe checkout / customer portal).
 *
 * Checkout is plan-id based (spec §32): the client names an operator-offered
 * `planId` (from `GET /api/v1/billing/plans`) plus the target `spaceId`; the
 * SERVER resolves the Stripe price, checkout mode, and credit metadata. The
 * redirect URLs land back on the Space billing tab.
 */
import { apiFetch } from "./http.ts";
import * as paths from "./paths.ts";

export interface StripeCheckoutResult {
  readonly url?: string;
  readonly sessionId?: string;
}

export interface StripePortalResult {
  readonly url?: string;
  readonly sessionId?: string;
}

const BILLING_RETURN_PATH = "/space/settings/billing";

export async function startStripeCheckout(input: {
  readonly subject: string;
  readonly planId: string;
  readonly spaceId: string;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
  readonly customerEmail?: string;
}): Promise<StripeCheckoutResult> {
  const successUrl =
    input.successUrl ??
    new URL(
      `${BILLING_RETURN_PATH}?checkout=success`,
      location.origin,
    ).toString();
  const cancelUrl =
    input.cancelUrl ??
    new URL(
      `${BILLING_RETURN_PATH}?checkout=cancelled`,
      location.origin,
    ).toString();
  const body = await apiFetch<
    StripeCheckoutResult & { readonly session_id?: string }
  >(paths.STRIPE_CHECKOUT, {
    method: "POST",
    body: {
      subject: input.subject,
      planId: input.planId,
      spaceId: input.spaceId,
      successUrl,
      cancelUrl,
      ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
    },
  });
  return {
    url: body.url,
    sessionId: body.sessionId ?? body.session_id,
  };
}

export async function startStripePortal(input: {
  readonly subject: string;
  readonly returnUrl?: string;
}): Promise<StripePortalResult> {
  const returnUrl =
    input.returnUrl ??
    new URL(`${BILLING_RETURN_PATH}?portal=return`, location.origin).toString();
  const body = await apiFetch<
    StripePortalResult & { readonly session_id?: string }
  >(paths.STRIPE_PORTAL, {
    method: "POST",
    body: {
      subject: input.subject,
      returnUrl,
    },
  });
  return {
    url: body.url,
    sessionId: body.sessionId ?? body.session_id,
  };
}
