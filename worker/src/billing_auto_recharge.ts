import { createStripeAutoRechargePaymentIntent } from "../../accounts/service/src/billing.ts";
import {
  USD_MICROS_PER_CENT,
  type BillingAutoRechargeAttempt,
} from "takosumi-contract/billing";
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
    const idempotencyKey = `takosumi-autorecharge:${request.spaceId}:${request.runId}`;
    const nowIso = new Date(request.now).toISOString();
    const requestedUsdMicros = roundUpToStripeCent(request.rechargeUsdMicros);
    const period = billingAutoRechargePeriod(request.now);
    const attempt: BillingAutoRechargeAttempt = {
      id: billingAutoRechargeAttemptId(idempotencyKey),
      spaceId: request.spaceId,
      runId: request.runId,
      billingAccountId: billingAccount.id,
      idempotencyKey,
      periodStart: period.start,
      periodEnd: period.end,
      requestedUsdMicros,
      ...(request.monthlyLimitUsdMicros !== undefined
        ? { monthlyLimitUsdMicros: request.monthlyLimitUsdMicros }
        : {}),
      status: "pending",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const claim = await input.store.claimBillingAutoRechargeAttempt({
      attempt,
      ...(request.monthlyLimitUsdMicros !== undefined
        ? { monthlyLimitUsdMicros: request.monthlyLimitUsdMicros }
        : {}),
    });
    const chargeAttempt = async (
      claimedAttempt: BillingAutoRechargeAttempt,
    ) => {
      try {
        const paymentIntent = await createStripeAutoRechargePaymentIntent({
          secretKey,
          stripeCustomerId: billingAccount.stripeCustomerId,
          stripePaymentMethodId: billingAccount.stripeDefaultPaymentMethodId,
          usdMicros: claimedAttempt.requestedUsdMicros,
          idempotencyKey: claimedAttempt.idempotencyKey,
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
        const chargedUsdMicros = paymentIntent.amount * USD_MICROS_PER_CENT;
        if (paymentIntent.status !== "succeeded") {
          const terminalFailure = stripePaymentIntentTerminalFailure(
            paymentIntent.status,
          );
          await input.store.settleBillingAutoRechargeAttempt({
            attemptId: claimedAttempt.id,
            status: terminalFailure ? "failed" : "pending_unknown",
            ...(terminalFailure ? { failureReason: paymentIntent.status } : {}),
            stripePaymentIntentId: paymentIntent.paymentIntentId,
            providerStatus: paymentIntent.status,
            updatedAt: nowIso,
          });
          return {
            skippedReason: `stripe_payment_intent_${paymentIntent.status}`,
          };
        }
        const settled = await input.store.settleBillingAutoRechargeAttempt({
          attemptId: claimedAttempt.id,
          status: "succeeded",
          chargedUsdMicros,
          stripePaymentIntentId: paymentIntent.paymentIntentId,
          providerStatus: paymentIntent.status,
          updatedAt: nowIso,
        });
        return {
          balance: settled.balance,
          chargedUsdMicros:
            settled.attempt?.chargedUsdMicros ?? chargedUsdMicros,
        };
      } catch (_error) {
        await input.store.settleBillingAutoRechargeAttempt({
          attemptId: claimedAttempt.id,
          status: "pending_unknown",
          failureReason: "stripe_auto_recharge_failed",
          updatedAt: nowIso,
        });
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
    if (!claim.claimed) {
      if (claim.skippedReason === "monthly_limit_exceeded") {
        return { skippedReason: "monthly_limit_exceeded" };
      }
      if (claim.attempt.status === "succeeded") {
        return {
          balance: await input.store.getCreditBalance(request.spaceId),
          chargedUsdMicros:
            claim.attempt.chargedUsdMicros ?? claim.attempt.requestedUsdMicros,
        };
      }
      if (
        claim.attempt.status === "pending" ||
        claim.attempt.status === "pending_unknown"
      ) {
        if (claim.attempt.status === "pending_unknown") {
          return await chargeAttempt(claim.attempt);
        }
        return { skippedReason: "auto_recharge_pending" };
      }
      return { skippedReason: "auto_recharge_failed" };
    }
    return await chargeAttempt(claim.attempt);
  };
}

function roundUpToStripeCent(usdMicros: number): number {
  return Math.ceil(usdMicros / USD_MICROS_PER_CENT) * USD_MICROS_PER_CENT;
}

function billingAutoRechargePeriod(now: number): {
  readonly start: string;
  readonly end: string;
} {
  const date = new Date(now);
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  );
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  );
  return { start: start.toISOString(), end: end.toISOString() };
}

function billingAutoRechargeAttemptId(idempotencyKey: string): string {
  return idempotencyKey;
}

function stripePaymentIntentTerminalFailure(status: string): boolean {
  return (
    status === "canceled" ||
    status === "requires_payment_method" ||
    status === "requires_action"
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
