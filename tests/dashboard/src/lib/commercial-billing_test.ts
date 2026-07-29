import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  commercialBillingDestination,
  parseCommercialBillingConfiguration,
  parseCommercialBillingSummary,
} from "../../../../dashboard/src/lib/commercial-billing.ts";

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
