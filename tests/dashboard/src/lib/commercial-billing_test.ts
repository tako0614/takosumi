import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  commercialBillingDestination,
  localizedCommercialBillingText,
  parseCommercialBillingCatalog,
  parseCommercialBillingSummary,
} from "../../../../dashboard/src/lib/commercial-billing.ts";

test("commercial billing catalog tolerates incomplete extension data", () => {
  const catalog = parseCommercialBillingCatalog({
    plans: [
      undefined,
      { id: undefined, name: { ja: undefined } },
      {
        id: "payg",
        kind: "subscription",
        name: { ja: "従量課金", en: "Usage based" },
        priceDisplay: { ja: "固定費なし" },
        monthlyPriceUsdMicros: 0,
      },
    ],
    countryMatrix: {
      version: "2026-07",
      supportedCountries: ["jp", "US", undefined, "invalid", "JP"],
    },
  });
  expect(catalog.plans).toHaveLength(1);
  expect(catalog.plans[0]?.id).toBe("payg");
  expect(catalog.countryMatrix?.supportedCountries).toEqual(["JP", "US"]);
  expect(
    localizedCommercialBillingText(
      catalog.plans[0]?.name ?? {},
      "ja-JP",
      "payg",
    ),
  ).toBe("従量課金");
});

test("commercial billing summary filters malformed rows and unsafe links", () => {
  const summary = parseCommercialBillingSummary({
    billing: {
      configured: true,
      account: {
        billingAccountId: "billing_account_1",
        status: "active",
        customerType: "business",
        taxJurisdiction: "JP",
      },
      subscription: {
        id: "subscription_1",
        status: "active",
        planId: "payg",
        cancelAtPeriodEnd: false,
      },
      invoices: [
        undefined,
        { id: undefined },
        {
          id: "invoice_1",
          status: "paid",
          currency: "usd",
          totalMinor: 1250,
          paid: true,
          hostedInvoiceUrl: "javascript:alert(1)",
          invoicePdfUrl: "https://billing.example/invoice.pdf",
        },
      ],
    },
  });
  expect(summary.configured).toBe(true);
  expect(summary.account?.customerType).toBe("business");
  expect(summary.subscription?.planId).toBe("payg");
  expect(summary.invoices).toHaveLength(1);
  expect(summary.invoices[0]?.hostedInvoiceUrl).toBeUndefined();
  expect(summary.invoices[0]?.invoicePdfUrl).toBe(
    "https://billing.example/invoice.pdf",
  );
});

test("commercial billing projections are bounded and deduplicate identities", () => {
  const plans = Array.from({ length: 80 }, (_, index) => ({
    id: `plan_${index}`,
    name: { en: `Plan ${index}` },
  }));
  plans.splice(1, 0, { id: "plan_0", name: { en: "Substituted" } });
  const catalog = parseCommercialBillingCatalog({ plans });
  expect(catalog.plans).toHaveLength(63);
  expect(catalog.plans[0]?.name.en).toBe("Plan 0");

  const invoices = Array.from({ length: 120 }, (_, index) => ({
    id: `invoice_${index}`,
    status: "paid",
    currency: "usd",
    createdAt: "not-a-date",
  }));
  invoices.splice(1, 0, {
    id: "invoice_0",
    status: "open",
    currency: "usd",
    createdAt: "2026-07-28T00:00:00.000Z",
  });
  const summary = parseCommercialBillingSummary({
    billing: { configured: true, invoices },
  });
  expect(summary.invoices).toHaveLength(99);
  expect(summary.invoices[0]?.status).toBe("paid");
  expect(summary.invoices[0]?.createdAt).toBeUndefined();
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
  expect(component).not.toContain("Stripe");
  expect(component).not.toContain("cloud-billing");
  expect(client).toContain('"plans"');
  expect(client).toContain('"summary"');
  expect(client).toContain('"checkout"');
  expect(client).toContain('"portal"');
  expect(client).toContain('credentials: "include"');
  expect(client).not.toContain("Stripe");
});
