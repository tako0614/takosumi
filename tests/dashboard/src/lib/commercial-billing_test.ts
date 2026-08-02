import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  billingReturnUrl,
  checkoutReturnUrl,
  WORKSPACE_BILLING_ROUTE,
} from "../../../../dashboard/src/lib/billing-return-url.ts";
import {
  commercialBillingDestination,
  loadCommercialBillingTransactions,
  parseCommercialBillingConfiguration,
  parseCommercialBillingSummary,
  parseCommercialBillingTransactionPage,
} from "../../../../dashboard/src/lib/commercial-billing.ts";

const DASHBOARD_ORIGIN = "https://app.takosumi.example";
const dashboardIndexSource = readFileSync(
  resolve(import.meta.dir, "../../../../dashboard/src/index.tsx"),
  "utf8",
);
const commercialBillingPanelSource = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../dashboard/src/components/billing/CommercialBillingPanel.tsx",
  ),
  "utf8",
);

test("billing provider returns use the canonical Workspace billing route", () => {
  expect(WORKSPACE_BILLING_ROUTE).toBe("/advanced/workspace/billing");
  expect(dashboardIndexSource).toContain('path="/advanced/workspace/:tab"');
  expect(commercialBillingPanelSource).toContain("checkoutReturnUrl");
  expect(commercialBillingPanelSource).toContain("billingReturnUrl");
  expect(commercialBillingPanelSource).not.toContain(
    'new URL("/settings/billing"',
  );
  expect(
    billingReturnUrl("workspace_1", DASHBOARD_ORIGIN).href,
  ).toBe(
    "https://app.takosumi.example/advanced/workspace/billing?workspaceId=workspace_1",
  );
  expect(
    checkoutReturnUrl("workspace_1", "success", DASHBOARD_ORIGIN).href,
  ).toBe(
    "https://app.takosumi.example/advanced/workspace/billing?workspaceId=workspace_1&checkout=success",
  );
  expect(
    checkoutReturnUrl("workspace_1", "cancelled", DASHBOARD_ORIGIN).href,
  ).toBe(
    "https://app.takosumi.example/advanced/workspace/billing?workspaceId=workspace_1&checkout=cancelled",
  );
});

test("commercial billing configuration validates bounded credit choices", () => {
  const configuration = parseCommercialBillingConfiguration({
    credits: {
      currency: "USD",
      purchaseOptionsUsdMicros: [5_000_000, 10_000_000, 5_000_000],
      autoRecharge: {
        defaultSettings: {
          enabled: false,
          thresholdUsdMicros: 5_000_000,
          rechargeUsdMicros: 10_000_000,
          monthlyLimitUsdMicros: 100_000_000,
        },
        thresholdOptionsUsdMicros: [1_000_000, 5_000_000],
        rechargeOptionsUsdMicros: [5_000_000, 10_000_000],
        monthlyLimitOptionsUsdMicros: [25_000_000, 100_000_000],
      },
    },
    countryMatrix: {
      version: "2026-07",
      supportedCountries: ["jp", "US", undefined, "invalid", "JP"],
    },
  });
  expect(configuration.credits.purchaseOptionsUsdMicros).toEqual([
    5_000_000, 10_000_000,
  ]);
  expect(configuration.countryMatrix?.supportedCountries).toEqual(["JP", "US"]);
});

test("commercial billing summary projects current credit, not lifetime purchases", () => {
  const summary = parseCommercialBillingSummary({
    billing: {
      configured: true,
      account: {
        billingAccountId: "billing_account_1",
        status: "active",
        customerType: "business",
        taxJurisdiction: "JP",
      },
      credits: {
        currency: "USD",
        availableUsdMicros: 9_000_000,
        reservedUsdMicros: 1_000_000,
        // This is lifetime net purchased credit, not a current balance.
        purchasedUsdMicros: 125_000_000,
        paymentMethodReady: true,
        autoRecharge: {
          enabled: true,
          thresholdUsdMicros: 5_000_000,
          rechargeUsdMicros: 10_000_000,
          monthlyLimitUsdMicros: 100_000_000,
        },
      },
      payments: [
        undefined,
        { id: undefined },
        {
          id: "charge_1",
          status: "paid",
          currency: "usd",
          amountMinor: 1250,
          paid: true,
          refunded: false,
          receiptUrl: "javascript:alert(1)",
        },
      ],
    },
  });
  expect(summary.configured).toBe(true);
  expect(summary.account?.customerType).toBe("business");
  expect(summary.credits.availableUsdMicros).toBe(9_000_000);
  expect("purchasedUsdMicros" in summary.credits).toBe(false);
  expect(summary.credits.autoRecharge.enabled).toBe(true);
  expect(summary.payments).toHaveLength(1);
  expect(summary.payments[0]?.receiptUrl).toBeUndefined();
});

test("commercial billing projections are bounded and deduplicate identities", () => {
  const options = Array.from({ length: 80 }, (_, index) => index + 1);
  const configuration = parseCommercialBillingConfiguration({
    credits: {
      currency: "USD",
      purchaseOptionsUsdMicros: options,
      autoRecharge: {
        defaultSettings: {
          enabled: false,
          thresholdUsdMicros: 1,
          rechargeUsdMicros: 2,
          monthlyLimitUsdMicros: 3,
        },
        thresholdOptionsUsdMicros: options,
        rechargeOptionsUsdMicros: options,
        monthlyLimitOptionsUsdMicros: options,
      },
    },
  });
  expect(configuration.credits.purchaseOptionsUsdMicros).toHaveLength(32);

  const payments = Array.from({ length: 120 }, (_, index) => ({
    id: `charge_${index}`,
    status: "paid",
    currency: "usd",
    createdAt: "not-a-date",
  }));
  payments.splice(1, 0, {
    id: "charge_0",
    status: "failed",
    currency: "usd",
    createdAt: "2026-07-28T00:00:00.000Z",
  });
  const summary = parseCommercialBillingSummary({
    billing: {
      configured: true,
      credits: {
        currency: "USD",
        availableUsdMicros: 0,
        reservedUsdMicros: 0,
        paymentMethodReady: false,
        autoRecharge: {
          enabled: false,
          thresholdUsdMicros: 1,
          rechargeUsdMicros: 2,
          monthlyLimitUsdMicros: 3,
        },
      },
      payments,
    },
  });
  expect(summary.payments).toHaveLength(99);
  expect(summary.payments[0]?.status).toBe("paid");
  expect(summary.payments[0]?.createdAt).toBeUndefined();
});

test("commercial billing summary fails closed on account blocks and exact payment states", () => {
  const summary = parseCommercialBillingSummary({
    billing: {
      configured: true,
      account: {
        billingAccountId: "billing_account_blocked",
        provider: "payment-provider-private",
        status: "disabled",
        usageAllowed: false,
        suspensionReason: "payment_disputed",
      },
      credits: {
        currency: "USD",
        availableUsdMicros: 7_500_000,
        reservedUsdMicros: 500_000,
        paymentMethodReady: true,
        autoRecharge: {
          enabled: false,
          thresholdUsdMicros: 5_000_000,
          rechargeUsdMicros: 10_000_000,
          monthlyLimitUsdMicros: 100_000_000,
        },
      },
      payments: [
        {
          id: "charge_disputed",
          status: "paid",
          currency: "usd",
          amountMinor: 1_000,
          amountRefundedMinor: 0,
          paid: true,
          refunded: false,
          disputed: true,
        },
        {
          id: "charge_partially_refunded",
          status: "paid",
          currency: "usd",
          amountMinor: 1_000,
          amountRefundedMinor: 250,
          paid: true,
          refunded: false,
        },
        {
          id: "charge_refunded",
          status: "paid",
          currency: "usd",
          amountMinor: 1_000,
          amountRefundedMinor: 1_000,
          paid: true,
          refunded: false,
        },
      ],
    },
  });

  expect(summary.account).toEqual({
    billingAccountId: "billing_account_blocked",
    status: "disabled",
    usageAllowed: false,
    suspensionReason: "payment_disputed",
  });
  expect(summary.account).not.toHaveProperty("provider");
  expect(summary.credits.availableUsdMicros).toBe(7_500_000);
  expect(summary.payments.map((payment) => payment.status)).toEqual([
    "disputed",
    "partially_refunded",
    "refunded",
  ]);
});

test("commercial billing navigation only accepts credential-free HTTPS", () => {
  expect(
    commercialBillingDestination({
      url: "https://checkout.example/session",
    }),
  ).toBe("https://checkout.example/session");
  expect(() =>
    commercialBillingDestination({ url: "javascript:alert(1)" }),
  ).toThrow("unsafe destination");
  expect(() =>
    commercialBillingDestination({
      url: "https://user:password@checkout.example/session",
    }),
  ).toThrow("unsafe destination");
});

test("native commercial billing stays provider-neutral and uses extension APIs", () => {
  const component = readFileSync(
    resolve(
      import.meta.dir,
      "../../../../dashboard/src/components/billing/CommercialBillingPanel.tsx",
    ),
    "utf8",
  );
  const client = readFileSync(
    resolve(
      import.meta.dir,
      "../../../../dashboard/src/lib/commercial-billing.ts",
    ),
    "utf8",
  );
  expect(component).toContain("CommercialBillingPanel");
  expect(component).toContain("DataTable");
  expect(component).toContain("availableUsdMicros");
  expect(component).toContain("suspensionReason");
  expect(component).toContain("partially_refunded");
  expect(component).toContain('name="billingCustomerType"');
  expect(component).toContain('name="billingCountry"');
  expect(component).not.toContain("purchasedUsdMicros");
  expect(component).not.toContain("balance.purchased");
  expect(component).not.toContain("Stripe");
  expect(component).not.toContain("cloud-billing");
  expect(client).toContain('"config"');
  expect(client).toContain('"summary"');
  expect(client).toContain('"checkout"');
  expect(client).toContain('"auto-recharge"');
  expect(client).toContain('"portal"');
  expect(client).toContain('credentials: "include"');
  expect(client).not.toContain("Stripe");
});

test("commercial transaction parser keeps the customer-safe statement shape", () => {
  const page = parseCommercialBillingTransactionPage({
    items: [
      {
        transactionId: "op_1",
        status: "reversed",
        workspaceId: "workspace_1",
        resourceId: "tkrn:resource_1",
        resourceGeneration: 2,
        interfaceRevision: "v1",
        pricingActivationId: "pricing_1",
        meterId: "managed.operation",
        operation: "object.put",
        quantity: "3",
        unit: "request",
        amountUsdMicros: 250,
        currency: "USD",
        acceptedAt: "2026-07-29T01:02:03.000Z",
        rejectedAt: "2026-07-29T02:02:03.000Z",
        billingSubjectId: "must-not-escape",
        requestDigest: "sha256:private",
        proofDigest: "sha256:private",
      },
    ],
    nextCursor: "cursor_2",
  });

  expect(page).toEqual({
    items: [
      {
        transactionId: "op_1",
        status: "reversed",
        workspaceId: "workspace_1",
        resourceId: "tkrn:resource_1",
        resourceGeneration: 2,
        interfaceRevision: "v1",
        pricingActivationId: "pricing_1",
        meterId: "managed.operation",
        operation: "object.put",
        quantity: "3",
        unit: "request",
        amountUsdMicros: 250,
        currency: "USD",
        acceptedAt: "2026-07-29T01:02:03.000Z",
        rejectedAt: "2026-07-29T02:02:03.000Z",
      },
    ],
    nextCursor: "cursor_2",
  });
  expect(JSON.stringify(page)).not.toContain("billingSubjectId");
  expect(JSON.stringify(page)).not.toContain("requestDigest");
  expect(JSON.stringify(page)).not.toContain("proofDigest");
});

test("commercial transaction client requests a bounded keyset page", async () => {
  const originalFetch = globalThis.fetch;
  let requested: Request | undefined;
  globalThis.fetch = (async (input, init) => {
    requested = new Request(
      new URL(String(input), "https://app.takosumi.com"),
      init,
    );
    return Response.json({ items: [] });
  }) as typeof fetch;
  try {
    const page = await loadCommercialBillingTransactions({
      basePath: "/v1/billing",
      workspaceId: "workspace_1",
      limit: 999,
      cursor: "cursor_2",
    });
    expect(page).toEqual({ items: [] });
    expect(requested?.url).toContain("/v1/billing/transactions?");
    expect(new URL(requested!.url).searchParams.get("workspaceId")).toBe(
      "workspace_1",
    );
    expect(new URL(requested!.url).searchParams.get("limit")).toBe("100");
    expect(new URL(requested!.url).searchParams.get("cursor")).toBe(
      "cursor_2",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
