import { apiFetch } from "./http";
import * as paths from "./paths";

export interface StripeCheckoutResult {
  readonly url?: string;
  readonly sessionId?: string;
}

export async function startStripeCheckout(input: {
  readonly planId?: string;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
}): Promise<StripeCheckoutResult> {
  return await apiFetch<StripeCheckoutResult>(paths.STRIPE_CHECKOUT, {
    method: "POST",
    body: input,
  });
}
