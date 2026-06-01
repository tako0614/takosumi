import { apiFetch } from "./client";

export interface StripeCheckoutResult {
  readonly url?: string;
  readonly sessionId?: string;
}

export async function startStripeCheckout(input: {
  readonly planId?: string;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
}): Promise<StripeCheckoutResult> {
  return await apiFetch<StripeCheckoutResult>("/v1/billing/stripe/checkout", {
    method: "POST",
    body: input,
  });
}
