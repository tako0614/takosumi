/**
 * Billing RPC for the account plane.
 * Ported from takosumi dashboard-ui/src/lib/rpc/billing.ts.
 */
import { apiFetch } from "./http.ts";
import * as paths from "./paths.ts";

export interface StripeCheckoutResult {
  readonly url?: string;
  readonly sessionId?: string;
}

export async function startStripeCheckout(input: {
  readonly subject: string;
  readonly priceId: string;
  readonly mode: "subscription" | "payment";
  readonly successUrl?: string;
  readonly cancelUrl?: string;
  readonly customerEmail?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}): Promise<StripeCheckoutResult> {
  const successUrl =
    input.successUrl ??
    new URL("/account/billing?checkout=success", location.origin).toString();
  const cancelUrl =
    input.cancelUrl ??
    new URL("/account/billing?checkout=cancelled", location.origin).toString();
  const body = await apiFetch<
    StripeCheckoutResult & { readonly session_id?: string }
  >(paths.STRIPE_CHECKOUT, {
    method: "POST",
    body: {
      subject: input.subject,
      priceId: input.priceId,
      mode: input.mode,
      successUrl,
      cancelUrl,
      ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
  return {
    url: body.url,
    sessionId: body.sessionId ?? body.session_id,
  };
}
