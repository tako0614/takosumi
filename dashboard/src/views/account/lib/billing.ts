/**
 * Billing RPC for the account plane (Stripe checkout / customer portal).
 *
 * Checkout is plan-id based (spec §32): the client names an operator-offered
 * `planId` (from `GET /api/v1/billing/plans`) plus the target `workspaceId`; the
 * SERVER resolves the Stripe price, checkout mode, and credit metadata. The
 * redirect URLs land back on the first-class Billing screen.
 */
import { apiFetch } from "./http.ts";
import * as paths from "./paths.ts";
import { buildBillingReturnUrl } from "./billing-return.ts";

export interface StripeCheckoutResult {
  readonly url?: string;
  readonly sessionId?: string;
}

export interface StripePortalResult {
  readonly url?: string;
  readonly sessionId?: string;
}

export async function startStripeCheckout(input: {
  readonly subject: string;
  readonly planId: string;
  readonly workspaceId: string;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
  readonly customerEmail?: string;
}): Promise<StripeCheckoutResult> {
  const successUrl =
    input.successUrl ??
    buildBillingReturnUrl({
      origin: location.origin,
      checkout: "success",
      workspaceId: input.workspaceId,
    });
  const cancelUrl =
    input.cancelUrl ??
    buildBillingReturnUrl({
      origin: location.origin,
      checkout: "cancelled",
      workspaceId: input.workspaceId,
    });
  const body = await apiFetch<
    StripeCheckoutResult & { readonly session_id?: string }
  >(paths.STRIPE_CHECKOUT, {
    method: "POST",
    body: {
      subject: input.subject,
      planId: input.planId,
      workspaceId: input.workspaceId,
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
    new URL("/billing?portal=return", location.origin).toString();
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
