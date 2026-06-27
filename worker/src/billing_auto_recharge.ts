import { createStripeAutoRechargePaymentIntent } from "../../accounts/service/src/billing.ts";
import { USD_MICROS_PER_CENT } from "takosumi-contract/billing";
import type { BillingAutoRechargePort } from "../../core/domains/deploy-control/billing_service.ts";
import type { OpenTofuDeploymentStore } from "../../core/domains/deploy-control/store.ts";
import type { CloudflareWorkerEnv } from "./bindings.ts";

export function createStripeBillingAutoRechargePort(input: {
  readonly env: CloudflareWorkerEnv;
  readonly store: OpenTofuDeploymentStore;
  readonly fetch?: typeof fetch;
}): BillingAutoRechargePort | undefined {
  const secretKey = optionalString(
    input.env.TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY,
  );
  if (!secretKey) return undefined;
  const stripeApiBase = optionalString(
    input.env.TAKOSUMI_ACCOUNTS_STRIPE_API_BASE,
  );
  return async (request) => {
    if (request.monthlyLimitUsdMicros !== undefined) {
      return { skippedReason: "monthly_limit_requires_attempt_ledger" };
    }
    const billingAccount = await input.store.getBillingAccountForOwner(
      "space",
      request.spaceId,
    );
    if (billingAccount?.provider !== "stripe") {
      return { skippedReason: "stripe_billing_account_missing" };
    }
    if (!billingAccount.stripeCustomerId) {
      return { skippedReason: "stripe_customer_missing" };
    }
    if (!billingAccount.stripeDefaultPaymentMethodId) {
      return { skippedReason: "stripe_payment_method_missing" };
    }
    try {
      const paymentIntent = await createStripeAutoRechargePaymentIntent({
        secretKey,
        stripeCustomerId: billingAccount.stripeCustomerId,
        stripePaymentMethodId: billingAccount.stripeDefaultPaymentMethodId,
        usdMicros: request.rechargeUsdMicros,
        idempotencyKey: `takosumi-autorecharge:${request.spaceId}:${request.runId}`,
        description: "Takosumi automatic USD balance recharge",
        metadata: {
          takosumi_space_id: request.spaceId,
          takosumi_run_id: request.runId,
          takosumi_estimated_usd_micros: String(request.estimatedUsdMicros),
          takosumi_threshold_usd_micros: String(request.thresholdUsdMicros),
        },
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(stripeApiBase ? { stripeApiBase } : {}),
      });
      if (paymentIntent.status !== "succeeded") {
        return {
          skippedReason: `stripe_payment_intent_${paymentIntent.status}`,
        };
      }
      const chargedUsdMicros = paymentIntent.amount * USD_MICROS_PER_CENT;
      const balance = await input.store.addCredits(request.spaceId, {
        usdMicros: chargedUsdMicros,
        updatedAt: new Date(request.now).toISOString(),
      });
      return { balance, chargedUsdMicros };
    } catch (_error) {
      console.error(
        "billing_auto_recharge_failed",
        JSON.stringify({
          spaceId: request.spaceId,
          runId: request.runId,
        }),
      );
      return { skippedReason: "stripe_auto_recharge_failed" };
    }
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
