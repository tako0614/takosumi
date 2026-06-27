import { expect, test } from "bun:test";

import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
import { createStripeBillingAutoRechargePort } from "../../../worker/src/billing_auto_recharge.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";

test("Stripe billing auto recharge charges saved payment method and grants USD balance", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putBillingAccount({
    id: "bill_space_1",
    ownerType: "space",
    ownerId: "space_1",
    provider: "stripe",
    stripeCustomerId: "cus_1",
    stripeDefaultPaymentMethodId: "pm_1",
    status: "active",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  });
  const requests: Array<{
    readonly url: string;
    readonly body: string;
    readonly idempotencyKey: string | null;
  }> = [];
  const port = createStripeBillingAutoRechargePort({
    env: {
      TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY: "sk_test",
      TAKOSUMI_ACCOUNTS_STRIPE_API_BASE: "https://stripe.example.test/v1",
    } as CloudflareWorkerEnv,
    store,
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: String(init?.body),
        idempotencyKey:
          init?.headers instanceof Headers
            ? init.headers.get("Idempotency-Key")
            : ((init?.headers as Record<string, string> | undefined)?.[
                "Idempotency-Key"
              ] ?? null),
      });
      return Response.json({
        id: "pi_1",
        status: "succeeded",
        amount: 124,
        currency: "usd",
      });
    },
  });

  const result = await port!({
    spaceId: "space_1",
    runId: "plan_1",
    estimatedUsdMicros: 1_000_000,
    availableUsdMicros: 0,
    shortfallUsdMicros: 1_000_000,
    thresholdUsdMicros: 500_000,
    rechargeUsdMicros: 1_230_001,
    now: Date.parse("2026-06-27T00:00:00.000Z"),
  });

  expect(result).toMatchObject({
    chargedUsdMicros: 1_240_000,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toEqual(
    "https://stripe.example.test/v1/payment_intents",
  );
  expect(requests[0]?.idempotencyKey).toEqual(
    "takosumi-autorecharge:space_1:plan_1",
  );
  const body = new URLSearchParams(requests[0]?.body);
  expect(body.get("customer")).toEqual("cus_1");
  expect(body.get("payment_method")).toEqual("pm_1");
  expect(body.get("amount")).toEqual("124");
  expect(body.get("metadata[takosumi_space_id]")).toEqual("space_1");
  expect(await store.getCreditBalance("space_1")).toMatchObject({
    availableUsdMicros: 1_240_000,
    purchasedUsdMicros: 1_240_000,
  });
});

test("Stripe billing auto recharge skips safely when no payment method is stored", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putBillingAccount({
    id: "bill_space_1",
    ownerType: "space",
    ownerId: "space_1",
    provider: "stripe",
    stripeCustomerId: "cus_1",
    status: "active",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  });
  let called = 0;
  const port = createStripeBillingAutoRechargePort({
    env: {
      TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY: "sk_test",
    } as CloudflareWorkerEnv,
    store,
    fetch: async () => {
      called++;
      return Response.json({});
    },
  });

  const result = await port!({
    spaceId: "space_1",
    runId: "plan_1",
    estimatedUsdMicros: 1_000_000,
    availableUsdMicros: 0,
    shortfallUsdMicros: 1_000_000,
    thresholdUsdMicros: 0,
    rechargeUsdMicros: 2_000_000,
    now: Date.parse("2026-06-27T00:00:00.000Z"),
  });

  expect(result).toEqual({ skippedReason: "stripe_payment_method_missing" });
  expect(called).toEqual(0);
  expect(await store.getCreditBalance("space_1")).toBeUndefined();
});
