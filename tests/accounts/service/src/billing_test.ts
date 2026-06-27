import { expect, test } from "bun:test";
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "../../../helpers/assert.ts";
import {
  aggregateBillingUsage,
  applyStripeBillingEvent,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  createStripeInvoiceItem,
  createStripeUsageInvoiceItemsForBillingAccount,
  createStripeUsageInvoiceItem,
  handleStripeWebhook,
  normalizeStripeBillingEvent,
  parseStripeUsageInvoiceItemPrices,
  reconcileBillingEntitlements,
  STRIPE_API_VERSION,
  stripeInvoiceItemParams,
  verifyStripeWebhookSignature,
} from "../../../../accounts/service/src/billing.ts";
import { stripeInvoiceCreditReconciliationInput } from "../../../../accounts/service/src/billing-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const textEncoder = new TextEncoder();

test("verifyStripeWebhookSignature accepts valid Stripe v1 signatures", async () => {
  const payload = JSON.stringify(
    stripeEvent({
      id: "evt_1",
      type: "invoice.payment_failed",
      object: { customer: "cus_1" },
    }),
  );
  const signature = await stripeSignatureHeader({
    payload,
    secret: "whsec_test",
    timestamp: 1_700_000_000,
  });

  const event = await verifyStripeWebhookSignature({
    payload,
    signature,
    secret: "whsec_test",
    now: 1_700_000_000_000,
  });

  expect(event.id).toEqual("evt_1");
  expect(event.type).toEqual("invoice.payment_failed");
});

test("verifyStripeWebhookSignature rejects bad or stale signatures", async () => {
  const payload = JSON.stringify(
    stripeEvent({
      id: "evt_1",
      type: "invoice.payment_failed",
      object: { customer: "cus_1" },
    }),
  );
  const signature = await stripeSignatureHeader({
    payload,
    secret: "whsec_test",
    timestamp: 1_700_000_000,
  });

  await assertRejects(
    () =>
      verifyStripeWebhookSignature({
        payload,
        signature,
        secret: "wrong-secret",
        now: 1_700_000_000_000,
      }),
    TypeError,
    "signature mismatch",
  );
  await assertRejects(
    () =>
      verifyStripeWebhookSignature({
        payload,
        signature,
        secret: "whsec_test",
        toleranceSeconds: 10,
        now: 1_700_000_100_000,
      }),
    TypeError,
    "outside tolerance",
  );
});

test("stripe invoice credit reconciliation reads Stripe 2026 parent subscription metadata", () => {
  expect(
    stripeInvoiceCreditReconciliationInput(
      JSON.stringify(
        stripeEvent({
          id: "evt_invoice_paid",
          type: "invoice.paid",
          object: {
            id: "in_paid",
            parent: {
              subscription_details: {
                subscription: "sub_1",
                metadata: {
                  space_id: "space_133669ab2c4c450c",
                  credits: "1000",
                  plan_code: "starter",
                },
              },
            },
          },
        }),
      ),
    ),
  ).toEqual({
    spaceId: "space_133669ab2c4c450c",
    credits: 1000,
    stripeEventId: "evt_invoice_paid",
  });
});

test("createStripeCheckoutSession posts Takosumi subject metadata", async () => {
  let requestBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toEqual("https://api.stripe.test/v1/checkout/sessions");
    expect(request.method).toEqual("POST");
    expect(request.headers.get("authorization")).toEqual("Bearer sk_test");
    expect(request.headers.get("stripe-version")).toEqual(STRIPE_API_VERSION);
    requestBody = await request.text();
    return Response.json({
      id: "cs_1",
      url: "https://checkout.stripe.test/cs_1",
    });
  };

  const result = await createStripeCheckoutSession({
    secretKey: "sk_test",
    priceId: "price_1",
    mode: "subscription",
    subject: "tsub_account",
    successUrl: "https://accounts.example.test/success",
    cancelUrl: "https://accounts.example.test/cancel",
    customerEmail: "user@example.test",
    metadata: { purchase_kind: "plus_subscription" },
    automaticTax: true,
    taxIdCollection: true,
    stripeApiBase: "https://api.stripe.test/v1",
    fetch: fetchImpl,
  });
  const params = new URLSearchParams(requestBody);

  expect(result).toEqual({
    sessionId: "cs_1",
    url: "https://checkout.stripe.test/cs_1",
  });
  expect(params.get("mode")).toEqual("subscription");
  expect(params.get("line_items[0][price]")).toEqual("price_1");
  expect(params.get("client_reference_id")).toEqual("tsub_account");
  expect(params.get("metadata[takosumi_subject]")).toEqual("tsub_account");
  expect(params.get("metadata[purchase_kind]")).toEqual("plus_subscription");
  expect(params.get("automatic_tax[enabled]")).toEqual("true");
  expect(params.get("tax_id_collection[enabled]")).toEqual("true");
  expect(params.get("customer_email")).toEqual("user@example.test");
});

test("createStripeBillingPortalSession posts customer and return URL", async () => {
  let requestBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toEqual(
      "https://api.stripe.test/v1/billing_portal/sessions",
    );
    expect(request.method).toEqual("POST");
    expect(request.headers.get("authorization")).toEqual("Bearer sk_test");
    requestBody = await request.text();
    return Response.json({
      id: "bps_1",
      url: "https://billing.stripe.test/session/bps_1",
    });
  };

  const result = await createStripeBillingPortalSession({
    secretKey: "sk_test",
    stripeCustomerId: "cus_1",
    returnUrl: "https://accounts.example.test/account/billing",
    stripeApiBase: "https://api.stripe.test/v1",
    fetch: fetchImpl,
  });
  const params = new URLSearchParams(requestBody);

  expect(result).toEqual({
    sessionId: "bps_1",
    url: "https://billing.stripe.test/session/bps_1",
  });
  expect(params.get("customer")).toEqual("cus_1");
  expect(params.get("return_url")).toEqual(
    "https://accounts.example.test/account/billing",
  );
});

test("createStripeInvoiceItem posts customer amount metadata and idempotency key", async () => {
  let requestBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toEqual("https://api.stripe.test/v1/invoiceitems");
    expect(request.method).toEqual("POST");
    expect(request.headers.get("authorization")).toEqual("Bearer sk_test");
    expect(request.headers.get("stripe-version")).toEqual(STRIPE_API_VERSION);
    expect(request.headers.get("idempotency-key")).toEqual("usage-key-1");
    requestBody = await request.text();
    return Response.json({ id: "ii_1" });
  };

  const result = await createStripeInvoiceItem({
    secretKey: "sk_test",
    stripeCustomerId: "cus_1",
    amount: 450,
    currency: "JPY",
    description: "Takosumi usage: cloudflare.workers_script",
    metadata: {
      takosumi_usage_meter: "cloudflare.workers_script",
      app: "takos",
    },
    idempotencyKey: "usage-key-1",
    stripeApiBase: "https://api.stripe.test/v1",
    fetch: fetchImpl,
  });
  const params = new URLSearchParams(requestBody);

  expect(result).toEqual({ invoiceItemId: "ii_1" });
  expect(params.get("customer")).toEqual("cus_1");
  expect(params.get("amount")).toEqual("450");
  expect(params.get("currency")).toEqual("jpy");
  expect(params.get("description")).toEqual(
    "Takosumi usage: cloudflare.workers_script",
  );
  expect(params.get("metadata[takosumi_usage_meter]")).toEqual(
    "cloudflare.workers_script",
  );
  expect(params.get("metadata[app]")).toEqual("takos");
});

test("createStripeUsageInvoiceItem maps workers script rollups to Stripe invoice items", async () => {
  let requestBody = "";
  let idempotencyKey = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toEqual("https://api.stripe.test/v1/invoiceitems");
    idempotencyKey = request.headers.get("idempotency-key") ?? "";
    requestBody = await request.text();
    return Response.json({ id: "ii_workers_script" });
  };

  const result = await createStripeUsageInvoiceItem({
    secretKey: "sk_test",
    stripeCustomerId: "cus_workers",
    unitAmount: 3,
    currency: "usd",
    metadata: { takosumi_workspace_id: "ws_1" },
    rollup: {
      billingAccountId: "bill_1",
      meter: "cloudflare.workers_script",
      unit: "requests",
      quantity: 5,
      usageReportCount: 2,
      usageReportIds: ["usage_a", "usage_b"],
      periodStart: 1_800_000_000,
      periodEnd: 1_800_086_400,
      firstReportedAt: 1_800_000_100,
      lastReportedAt: 1_800_000_200,
    },
    stripeApiBase: "https://api.stripe.test/v1",
    fetch: fetchImpl,
  });
  const params = new URLSearchParams(requestBody);

  expect(result).toEqual({ invoiceItemId: "ii_workers_script" });
  expect(params.get("customer")).toEqual("cus_workers");
  expect(params.get("amount")).toEqual("15");
  expect(params.get("currency")).toEqual("usd");
  expect(params.get("description")).toEqual(
    "Takosumi usage: cloudflare.workers_script (5 requests)",
  );
  expect(params.get("metadata[takosumi_billing_account_id]")).toEqual("bill_1");
  expect(params.get("metadata[takosumi_usage_meter]")).toEqual(
    "cloudflare.workers_script",
  );
  expect(params.get("metadata[takosumi_usage_unit]")).toEqual("requests");
  expect(params.get("metadata[takosumi_usage_quantity]")).toEqual("5");
  expect(params.get("metadata[takosumi_usage_report_count]")).toEqual("2");
  expect(params.get("metadata[takosumi_usage_report_ids]")).toEqual(
    "usage_a,usage_b",
  );
  expect(params.get("metadata[takosumi_usage_period_start]")).toEqual(
    "1800000000",
  );
  expect(params.get("metadata[takosumi_usage_period_end]")).toEqual(
    "1800086400",
  );
  expect(params.get("metadata[takosumi_workspace_id]")).toEqual("ws_1");
  expect(params.get("metadata[takosumi_usage_meter]")).not.toContain(
    "workers_for_platforms",
  );
  expect(idempotencyKey).toContain("cloudflare.workers_script");
  expect(idempotencyKey).toContain("usage_a.usage_b");
  expect(idempotencyKey.length).toBeLessThanOrEqual(255);
});

test("createStripeUsageInvoiceItem rejects internal Workers for Platforms meters", async () => {
  await assertRejects(
    () =>
      createStripeUsageInvoiceItem({
        secretKey: "sk_test",
        stripeCustomerId: "cus_workers",
        unitAmount: 3,
        currency: "usd",
        rollup: {
          billingAccountId: "bill_1",
          meter: "cloudflare.wfp",
          unit: "requests",
          quantity: 5,
          usageReportCount: 1,
          usageReportIds: ["usage_wfp"],
          firstReportedAt: 1_800_000_100,
          lastReportedAt: 1_800_000_100,
        },
      }),
    TypeError,
    "customer-facing managed resource",
  );
  await assertRejects(
    () =>
      createStripeUsageInvoiceItem({
        secretKey: "sk_test",
        stripeCustomerId: "cus_workers",
        unitAmount: 3,
        currency: "usd",
        rollup: {
          billingAccountId: "bill_1",
          meter: "cloudflare.workers.for.platforms",
          unit: "requests",
          quantity: 5,
          usageReportCount: 1,
          usageReportIds: ["usage_wfp_dotted"],
          firstReportedAt: 1_800_000_100,
          lastReportedAt: 1_800_000_100,
        },
      }),
    TypeError,
    "customer-facing managed resource",
  );
});

test("parseStripeUsageInvoiceItemPrices rejects internal Workers for Platforms meters", () => {
  assertThrows(
    () =>
      parseStripeUsageInvoiceItemPrices(
        JSON.stringify([
          {
            meter: "cloudflare.workers_for_platforms",
            unit: "requests",
            unitAmount: 4,
            currency: "usd",
          },
        ]),
      ),
    TypeError,
    "customer-facing managed resource",
  );
  assertThrows(
    () =>
      parseStripeUsageInvoiceItemPrices(
        JSON.stringify([
          {
            meter: "cloudflare.workers.for.platforms",
            unit: "requests",
            unitAmount: 4,
            currency: "usd",
          },
        ]),
      ),
    TypeError,
    "customer-facing managed resource",
  );
  assertThrows(
    () =>
      parseStripeUsageInvoiceItemPrices(
        JSON.stringify([
          {
            meter: "cloudflare.workers_script",
            unit: "requests",
            unitAmount: 4,
            currency: "usd",
            metadata: {
              backend: "cloudflare.workers_for_platforms",
            },
          },
        ]),
      ),
    TypeError,
    "must not expose the internal Workers for Platforms backend",
  );
});

test("createStripeUsageInvoiceItemsForBillingAccount exports unbilled workers script usage", async () => {
  const store = new InMemoryAccountsStore();
  store.saveBillingAccount({
    billingAccountId: "bill_1",
    subject: "tsub_account",
    provider: "stripe",
    stripeCustomerId: "cus_workers",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  store.saveBillingUsageRecord({
    usageReportId: "usage_workers_a",
    installationId: "inst_a",
    billingAccountId: "bill_1",
    meter: "cloudflare.workers_script",
    quantity: 2,
    unit: "requests",
    periodStart: 1_800_000_000,
    periodEnd: 1_800_086_400,
    requestDigest: "sha256:a",
    metadata: { backend: "cloudflare.workers_for_platforms" },
    reportedAt: 1_800_000_100,
  });
  store.saveBillingUsageRecord({
    usageReportId: "usage_workers_b",
    installationId: "inst_b",
    billingAccountId: "bill_1",
    meter: "cloudflare.workers_script",
    quantity: 3,
    unit: "requests",
    periodStart: 1_800_000_000,
    periodEnd: 1_800_086_400,
    requestDigest: "sha256:b",
    metadata: { backend: "cloudflare.workers_for_platforms" },
    reportedAt: 1_800_000_200,
  });
  store.saveBillingUsageRecord({
    usageReportId: "usage_ai",
    installationId: "inst_ai",
    billingAccountId: "bill_1",
    meter: "cloudflare.ai_gateway",
    quantity: 7,
    unit: "requests",
    requestDigest: "sha256:ai",
    metadata: {},
    reportedAt: 1_800_000_300,
    billingExportProvider: "stripe",
    billingExportId: "already-exported",
    billingExportReference: "ii_existing",
    billingExportedAt: 1_800_000_400,
  });
  const invoiceBodies: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    invoiceBodies.push(await request.text());
    return Response.json({ id: "ii_workers_rollup" });
  };

  const result = await createStripeUsageInvoiceItemsForBillingAccount({
    store,
    secretKey: "sk_test",
    billingAccountId: "bill_1",
    prices: [
      {
        meter: "cloudflare.workers_script",
        unit: "requests",
        unitAmount: 4,
        currency: "usd",
      },
    ],
    now: 1_800_000_500,
    stripeApiBase: "https://api.stripe.test/v1",
    fetch: fetchImpl,
  });

  expect(result).toEqual({
    billingAccountId: "bill_1",
    stripeCustomerId: "cus_workers",
    exported: [
      {
        meter: "cloudflare.workers_script",
        unit: "requests",
        quantity: 5,
        usageReportCount: 2,
        usageReportIds: ["usage_workers_a", "usage_workers_b"],
        exportId:
          "takosumi-usage:bill_1:cloudflare.workers_script:requests:1800000000:1800086400:usage_workers_a.usage_workers_b",
        invoiceItemId: "ii_workers_rollup",
      },
    ],
  });
  expect(invoiceBodies.length).toEqual(1);
  const params = new URLSearchParams(invoiceBodies[0]);
  expect(params.get("amount")).toEqual("20");
  expect(params.get("metadata[takosumi_usage_meter]")).toEqual(
    "cloudflare.workers_script",
  );
  expect(
    store.findBillingUsageRecord("usage_workers_a")?.billingExportReference,
  ).toEqual("ii_workers_rollup");
  expect(
    store.findBillingUsageRecord("usage_workers_b")?.billingExportedAt,
  ).toEqual(1_800_000_500);
  expect(
    store.findBillingUsageRecord("usage_ai")?.billingExportReference,
  ).toEqual("ii_existing");

  const second = await createStripeUsageInvoiceItemsForBillingAccount({
    store,
    secretKey: "sk_test",
    billingAccountId: "bill_1",
    prices: [
      {
        meter: "cloudflare.workers_script",
        unit: "requests",
        unitAmount: 4,
        currency: "usd",
      },
    ],
    stripeApiBase: "https://api.stripe.test/v1",
    fetch: fetchImpl,
  });
  expect(second.exported).toEqual([]);
  expect(invoiceBodies.length).toEqual(1);
});

test("createStripeUsageInvoiceItemsForBillingAccount exports managed Cloudflare resource families", async () => {
  const store = new InMemoryAccountsStore();
  store.saveBillingAccount({
    billingAccountId: "bill_cloudflare",
    subject: "tsub_account",
    provider: "stripe",
    stripeCustomerId: "cus_cloudflare",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  const meters = [
    "cloudflare.kv",
    "cloudflare.r2",
    "cloudflare.d1",
    "cloudflare.workflows",
    "cloudflare.containers",
    "cloudflare.queues",
    "cloudflare.durable_objects",
  ] as const;
  meters.forEach((meter, index) => {
    store.saveBillingUsageRecord({
      usageReportId: `usage_${meter.replaceAll(".", "_")}`,
      installationId: "inst_cloudflare",
      billingAccountId: "bill_cloudflare",
      meter,
      quantity: index + 1,
      unit: "operations",
      requestDigest: `sha256:${meter}`,
      metadata: {},
      reportedAt: 1_800_000_000 + index,
    });
  });
  const invoiceBodies: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    invoiceBodies.push(await request.text());
    return Response.json({ id: `ii_cloudflare_${invoiceBodies.length}` });
  };

  const result = await createStripeUsageInvoiceItemsForBillingAccount({
    store,
    secretKey: "sk_test",
    billingAccountId: "bill_cloudflare",
    prices: meters.map((meter) => ({
      meter,
      unit: "operations",
      unitAmount: 2,
      currency: "usd",
    })),
    now: 1_800_000_500,
    stripeApiBase: "https://api.stripe.test/v1",
    fetch: fetchImpl,
  });

  expect(result.exported.map((item) => item.meter)).toEqual([...meters]);
  expect(invoiceBodies.length).toEqual(meters.length);
  const invoiceParams = invoiceBodies.map((body) => new URLSearchParams(body));
  expect(
    invoiceParams.map((params) => params.get("metadata[takosumi_usage_meter]")),
  ).toEqual([...meters]);
  expect(invoiceParams.map((params) => params.get("amount"))).toEqual([
    "2",
    "4",
    "6",
    "8",
    "10",
    "12",
    "14",
  ]);
  expect(invoiceBodies.join("\n")).not.toContain("workers_for_platforms");
});

test("stripeInvoiceItemParams rejects invalid invoice item input", () => {
  assertThrows(
    () =>
      stripeInvoiceItemParams({
        secretKey: "sk_test",
        stripeCustomerId: "",
        amount: 100,
        currency: "usd",
        description: "usage",
      }),
    TypeError,
    "stripeCustomerId",
  );
  assertThrows(
    () =>
      stripeInvoiceItemParams({
        secretKey: "sk_test",
        stripeCustomerId: "cus_1",
        amount: 0,
        currency: "usd",
        description: "usage",
      }),
    TypeError,
    "positive integer",
  );
  assertThrows(
    () =>
      stripeInvoiceItemParams({
        secretKey: "sk_test",
        stripeCustomerId: "cus_1",
        amount: 100,
        currency: "usd1",
        description: "usage",
      }),
    TypeError,
    "3-letter",
  );
});

test("aggregateBillingUsage rollups are deterministic by account meter and unit", () => {
  const rollups = aggregateBillingUsage([
    {
      usageReportId: "usage_b",
      installationId: "inst_1",
      billingAccountId: "bill_1",
      meter: "agent.compute.seconds",
      quantity: 2,
      unit: "seconds",
      periodStart: 200,
      periodEnd: 300,
      requestDigest: "sha256:b",
      metadata: {},
      reportedAt: 20,
    },
    {
      usageReportId: "usage_a",
      installationId: "inst_1",
      billingAccountId: "bill_1",
      meter: "agent.compute.seconds",
      quantity: 3,
      unit: "seconds",
      periodStart: 100,
      periodEnd: 200,
      requestDigest: "sha256:a",
      metadata: {},
      reportedAt: 10,
    },
    {
      usageReportId: "usage_c",
      installationId: "inst_1",
      billingAccountId: "bill_1",
      meter: "agent.compute.tokens",
      quantity: 7,
      unit: "tokens",
      requestDigest: "sha256:c",
      metadata: {},
      reportedAt: 30,
    },
  ]);

  expect(rollups).toEqual([
    {
      billingAccountId: "bill_1",
      meter: "agent.compute.seconds",
      unit: "seconds",
      quantity: 5,
      usageReportCount: 2,
      usageReportIds: ["usage_a", "usage_b"],
      periodStart: 100,
      periodEnd: 300,
      firstReportedAt: 10,
      lastReportedAt: 20,
    },
    {
      billingAccountId: "bill_1",
      meter: "agent.compute.tokens",
      unit: "tokens",
      quantity: 7,
      usageReportCount: 1,
      usageReportIds: ["usage_c"],
      firstReportedAt: 30,
      lastReportedAt: 30,
    },
  ]);
});

test("aggregateBillingUsage applies billing account window and late-arrival policy", () => {
  const rollups = aggregateBillingUsage(
    [
      {
        usageReportId: "usage_in_window",
        installationId: "inst_1",
        billingAccountId: "bill_1",
        meter: "agent.compute.seconds",
        quantity: 2,
        unit: "seconds",
        periodStart: 100,
        periodEnd: 200,
        requestDigest: "sha256:in-window",
        metadata: {},
        reportedAt: 500,
      },
      {
        usageReportId: "usage_late_accepted",
        installationId: "inst_1",
        billingAccountId: "bill_1",
        meter: "agent.compute.seconds",
        quantity: 3,
        unit: "seconds",
        periodStart: 200,
        periodEnd: 300,
        requestDigest: "sha256:late-accepted",
        metadata: {},
        reportedAt: 1_100,
      },
      {
        usageReportId: "usage_late_rejected",
        installationId: "inst_1",
        billingAccountId: "bill_1",
        meter: "agent.compute.seconds",
        quantity: 5,
        unit: "seconds",
        periodStart: 300,
        periodEnd: 400,
        requestDigest: "sha256:late-rejected",
        metadata: {},
        reportedAt: 2_000,
      },
      {
        usageReportId: "usage_other_account",
        installationId: "inst_2",
        billingAccountId: "bill_2",
        meter: "agent.compute.seconds",
        quantity: 7,
        unit: "seconds",
        periodStart: 100,
        periodEnd: 200,
        requestDigest: "sha256:other-account",
        metadata: {},
        reportedAt: 500,
      },
      {
        usageReportId: "usage_outside_window",
        installationId: "inst_1",
        billingAccountId: "bill_1",
        meter: "agent.compute.seconds",
        quantity: 11,
        unit: "seconds",
        periodStart: 900,
        periodEnd: 1_000,
        requestDigest: "sha256:outside-window",
        metadata: {},
        reportedAt: 1_000,
      },
    ],
    {
      billingAccountId: "bill_1",
      windowStart: 100,
      windowEnd: 400,
      lateArrivalAcceptedUntil: 1_500,
    },
  );

  expect(rollups).toEqual([
    {
      billingAccountId: "bill_1",
      meter: "agent.compute.seconds",
      unit: "seconds",
      quantity: 5,
      usageReportCount: 2,
      usageReportIds: ["usage_in_window", "usage_late_accepted"],
      periodStart: 100,
      periodEnd: 300,
      firstReportedAt: 500,
      lastReportedAt: 1_100,
    },
  ]);
});

test("normalizeStripeBillingEvent maps known Stripe event shapes", () => {
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_checkout",
        type: "checkout.session.completed",
        object: {
          customer: "cus_1",
          subscription: "sub_1",
          payment_status: "paid",
          line_items: { data: [{ price: { id: "price_plus" } }] },
          metadata: {
            takosumi_subject: "tsub_account",
            purchase_kind: "plus_subscription",
            plan_code: "plus",
          },
        },
      }),
    ),
  ).toEqual({
    kind: "checkout_completed",
    eventId: "evt_checkout",
    subject: "tsub_account",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    stripePriceId: "price_plus",
    planCode: "plus",
    paymentStatus: "paid",
  });
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_subscription_updated",
        type: "customer.subscription.updated",
        object: {
          customer: "cus_1",
          status: "active",
          current_period_end: 1_700_100_000,
          items: { data: [{ price: { id: "price_pro" } }] },
          metadata: { planCode: "pro" },
        },
      }),
    ),
  ).toEqual({
    kind: "subscription_updated",
    eventId: "evt_subscription_updated",
    customerId: "cus_1",
    status: "active",
    stripePriceId: "price_pro",
    planCode: "pro",
    currentPeriodEndUnix: 1_700_100_000,
  });
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_credit_note",
        type: "credit_note.created",
        object: {
          id: "cn_1",
          customer: "cus_1",
          amount: 1200,
          currency: "JPY",
        },
      }),
    ),
  ).toEqual({
    kind: "credit_recorded",
    eventId: "evt_credit_note",
    customerId: "cus_1",
    creditKind: "credit_note",
    creditId: "cn_1",
    amount: 1200,
    currency: "jpy",
  });
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_refund",
        type: "charge.refunded",
        object: {
          id: "ch_1",
          customer: "cus_1",
          amount_refunded: 800,
          currency: "USD",
          refunds: { data: [{ id: "re_1", amount: 800, currency: "USD" }] },
        },
      }),
    ),
  ).toEqual({
    kind: "credit_recorded",
    eventId: "evt_refund",
    customerId: "cus_1",
    creditKind: "refund",
    creditId: "re_1",
    amount: 800,
    currency: "usd",
  });
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_invoice_finalized",
        type: "invoice.finalized",
        object: {
          id: "in_tax",
          customer: "cus_1",
          automatic_tax: { enabled: true, status: "complete" },
          customer_details: { address: { country: "jp" } },
          metadata: { tax_policy_ref: "tax-policy://jp-consumption-tax" },
        },
      }),
    ),
  ).toEqual({
    kind: "tax_policy_recorded",
    eventId: "evt_invoice_finalized",
    customerId: "cus_1",
    invoiceId: "in_tax",
    taxPolicyRef: "tax-policy://jp-consumption-tax",
    taxJurisdiction: "JP",
    taxAutomaticStatus: "complete",
  });
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_invoice_updated",
        type: "invoice.updated",
        object: {
          id: "in_retry",
          customer: "cus_1",
          next_payment_attempt: 1_700_400_000,
          attempt_count: 2,
        },
      }),
    ),
  ).toEqual({
    kind: "invoice_dunning_updated",
    eventId: "evt_invoice_updated",
    customerId: "cus_1",
    invoiceId: "in_retry",
    nextPaymentAttemptUnix: 1_700_400_000,
    attemptCount: 2,
  });
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_invoice_updated_metadata",
        type: "invoice.updated",
        object: {
          id: "in_metadata",
          customer: "cus_1",
          attempt_count: 0,
          metadata: { note: "unrelated" },
        },
      }),
    ),
  ).toEqual({
    kind: "unhandled",
    eventId: "evt_invoice_updated_metadata",
    eventType: "invoice.updated",
  });
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_uncollectible",
        type: "invoice.marked_uncollectible",
        object: { id: "in_retry", customer: "cus_1" },
      }),
    ),
  ).toEqual({
    kind: "invoice_marked_uncollectible",
    eventId: "evt_uncollectible",
    customerId: "cus_1",
    invoiceId: "in_retry",
  });
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_unknown",
        type: "customer.created",
        object: { id: "cus_1" },
      }),
    ),
  ).toEqual({
    kind: "unhandled",
    eventId: "evt_unknown",
    eventType: "customer.created",
  });
  // customer.subscription.created should be normalized through the same path
  // as customer.subscription.updated so the BillingAccount picks up state on
  // first subscription attachment without waiting for an updated event.
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_subscription_created",
        type: "customer.subscription.created",
        object: {
          customer: "cus_1",
          status: "trialing",
          items: {
            data: [
              {
                price: { id: "price_plus" },
                current_period_end: 1_700_500_000,
              },
            ],
          },
          metadata: { plan_code: "plus" },
        },
      }),
    ),
  ).toEqual({
    kind: "subscription_updated",
    eventId: "evt_subscription_created",
    customerId: "cus_1",
    status: "trialing",
    stripePriceId: "price_plus",
    planCode: "plus",
    // `current_period_end` is missing on the subscription root; falls back to
    // the first subscription item's `current_period_end` per Stripe's
    // upcoming API deprecation path.
    currentPeriodEndUnix: 1_700_500_000,
  });
  // charge.dispute.created maps to dispute_opened.
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_dispute_open",
        type: "charge.dispute.created",
        object: {
          id: "dp_1",
          customer: "cus_1",
          charge: "ch_1",
          reason: "fraudulent",
          status: "needs_response",
          created: 1_700_900_000,
        },
      }),
    ),
  ).toEqual({
    kind: "dispute_opened",
    eventId: "evt_dispute_open",
    customerId: "cus_1",
    disputeId: "dp_1",
    chargeId: "ch_1",
    paymentIntentId: undefined,
    reason: "fraudulent",
    status: "needs_response",
    openedAtUnix: 1_700_900_000,
  });
  // charge.dispute.closed maps to dispute_closed with the outcome status.
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_dispute_close",
        type: "charge.dispute.closed",
        object: {
          id: "dp_1",
          customer: "cus_1",
          charge: "ch_1",
          reason: "fraudulent",
          status: "won",
          created: 1_700_950_000,
        },
      }),
    ),
  ).toEqual({
    kind: "dispute_closed",
    eventId: "evt_dispute_close",
    customerId: "cus_1",
    disputeId: "dp_1",
    chargeId: "ch_1",
    paymentIntentId: undefined,
    reason: "fraudulent",
    status: "won",
    closedAtUnix: 1_700_950_000,
  });
  // A REALISTIC Stripe dispute webhook has NO top-level `customer` and an
  // unexpanded `charge` / `payment_intent` string id. Normalization must still
  // produce a dispute event (carrying the link ids) so the apply layer can
  // resolve the owner, instead of downgrading to `unhandled`.
  expect(
    normalizeStripeBillingEvent(
      stripeEvent({
        id: "evt_dispute_real",
        type: "charge.dispute.created",
        object: {
          id: "dp_real",
          charge: "ch_real",
          payment_intent: "pi_real",
          reason: "fraudulent",
          status: "needs_response",
          created: 1_700_900_000,
        },
      }),
    ),
  ).toEqual({
    kind: "dispute_opened",
    eventId: "evt_dispute_real",
    customerId: undefined,
    disputeId: "dp_real",
    chargeId: "ch_real",
    paymentIntentId: "pi_real",
    reason: "fraudulent",
    status: "needs_response",
    openedAtUnix: 1_700_900_000,
  });
});

test("applyStripeBillingEvent suspends entitlements on chargeback and restores when dispute is won", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveBillingAccount({
    billingAccountId: "bill_1",
    subject: "tsub_account",
    provider: "stripe",
    stripeCustomerId: "cus_dispute",
    stripeSubscriptionId: "sub_dispute",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveAppInstallation({
    installationId: "inst_dispute",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_1",
    status: "ready",
    createdBySubject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });

  const opened = await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_dispute_open",
      type: "charge.dispute.created",
      object: {
        id: "dp_1",
        customer: "cus_dispute",
        charge: "ch_1",
        reason: "fraudulent",
        status: "needs_response",
        created: 1_700_001_000,
      },
    }),
  });
  expect(opened.applied).toEqual(true);
  const opening = store.findBillingAccountByStripeCustomerId("cus_dispute");
  expect(opening?.status).toEqual("disputed");
  expect(opening?.preDisputeStatus).toEqual("active");
  expect(opening?.activeDispute?.disputeId).toEqual("dp_1");
  // Entitlement must be suspended while the chargeback is open.
  expect(store.findAppInstallation("inst_dispute")?.status).toEqual(
    "suspended",
  );

  const closed = await applyStripeBillingEvent({
    store,
    now: 3000,
    event: stripeEvent({
      id: "evt_dispute_close",
      type: "charge.dispute.closed",
      object: {
        id: "dp_1",
        customer: "cus_dispute",
        charge: "ch_1",
        reason: "fraudulent",
        status: "won",
        created: 1_700_002_000,
      },
    }),
  });
  expect(closed.applied).toEqual(true);
  const closing = store.findBillingAccountByStripeCustomerId("cus_dispute");
  // Won dispute restores the pre-dispute status (active).
  expect(closing?.status).toEqual("active");
  expect(closing?.preDisputeStatus).toEqual(undefined);
  expect(closing?.activeDispute?.status).toEqual("won");
  expect(store.findAppInstallation("inst_dispute")?.status).toEqual("ready");
});

test("customer.subscription.deleted captures cancellation reason details", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveBillingAccount({
    billingAccountId: "bill_1",
    subject: "tsub_account",
    provider: "stripe",
    stripeCustomerId: "cus_cancel",
    stripeSubscriptionId: "sub_cancel",
    status: "active",
    planCode: "plus",
    createdAt: 1000,
    updatedAt: 1000,
  });

  await applyStripeBillingEvent({
    store,
    now: 5000,
    event: stripeEvent({
      id: "evt_cancel",
      type: "customer.subscription.deleted",
      object: {
        customer: "cus_cancel",
        canceled_at: 1_700_003_000,
        cancellation_details: {
          reason: "cancellation_requested",
          feedback: "too_expensive",
          comment: "moved to free plan",
        },
      },
    }),
  });

  const canceled = store.findBillingAccountByStripeCustomerId("cus_cancel");
  expect(canceled?.status).toEqual("canceled");
  expect(canceled?.lastCancellation?.canceledAt).toEqual(1_700_003_000);
  expect(canceled?.lastCancellation?.reason).toEqual("cancellation_requested");
  expect(canceled?.lastCancellation?.feedback).toEqual("too_expensive");
  expect(canceled?.lastCancellation?.comment).toEqual("moved to free plan");
});

test("verifyStripeWebhookSignature rejects malformed t= values", async () => {
  const payload = JSON.stringify(
    stripeEvent({
      id: "evt_1",
      type: "invoice.payment_failed",
      object: { customer: "cus_1" },
    }),
  );
  // Build a header with a bogus timestamp - signature value does not matter
  // because parsing the timestamp must fail before any HMAC compare.
  for (const bogus of ["-1", "0", "1.5", "1e9", "abc", "  100", ""]) {
    const header = `t=${bogus},v1=deadbeef`;
    await assertRejects(
      () =>
        verifyStripeWebhookSignature({
          payload,
          signature: header,
          secret: "whsec_test",
          now: 1_700_000_000_000,
        }),
      TypeError,
    );
  }
});

test("applyStripeBillingEvent updates billing account state from Stripe events", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  const checkout = await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_checkout",
      type: "checkout.session.completed",
      object: {
        customer: "cus_1",
        subscription: "sub_1",
        payment_status: "paid",
        line_items: { data: [{ price: { id: "price_plus" } }] },
        metadata: { takosumi_subject: "tsub_account", plan_code: "plus" },
      },
    }),
  });
  expect(checkout.applied).toEqual(true);
  expect(
    store.findBillingAccountForSubject("tsub_account")?.stripeCustomerId,
  ).toEqual("cus_1");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.stripeSubscriptionId,
  ).toEqual("sub_1");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.stripePriceId,
  ).toEqual("price_plus");
  expect(store.findBillingAccountByStripeCustomerId("cus_1")?.planCode).toEqual(
    "plus",
  );

  const invoicePaid = await applyStripeBillingEvent({
    store,
    now: 3000,
    event: stripeEvent({
      id: "evt_invoice_paid",
      type: "invoice.paid",
      object: {
        id: "in_paid",
        customer: "cus_1",
        lines: { data: [{ period: { end: 1_700_100_000 } }] },
      },
    }),
  });
  expect(invoicePaid.applied).toEqual(true);
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.currentPeriodEndUnix,
  ).toEqual(1_700_100_000);
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.lastInvoiceId,
  ).toEqual("in_paid");

  await applyStripeBillingEvent({
    store,
    now: 4000,
    event: stripeEvent({
      id: "evt_failed",
      type: "invoice.payment_failed",
      object: {
        id: "in_failed",
        customer: "cus_1",
        next_payment_attempt: 1_700_300_000,
        attempt_count: 1,
      },
    }),
  });
  expect(store.findBillingAccountByStripeCustomerId("cus_1")?.status).toEqual(
    "past_due",
  );
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.lastInvoiceId,
  ).toEqual("in_failed");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.dunningStartedAt,
  ).toEqual(4000);
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.nextPaymentAttemptUnix,
  ).toEqual(1_700_300_000);
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.dunningAttemptCount,
  ).toEqual(1);
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.dunningAction,
  ).toEqual("retry_scheduled");

  await applyStripeBillingEvent({
    store,
    now: 4250,
    event: stripeEvent({
      id: "evt_retry",
      type: "invoice.updated",
      object: {
        id: "in_failed",
        customer: "cus_1",
        next_payment_attempt: 1_700_400_000,
        attempt_count: 2,
      },
    }),
  });
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.dunningAttemptCount,
  ).toEqual(2);
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.nextPaymentAttemptUnix,
  ).toEqual(1_700_400_000);

  await applyStripeBillingEvent({
    store,
    now: 4300,
    event: stripeEvent({
      id: "evt_uncollectible",
      type: "invoice.marked_uncollectible",
      object: { id: "in_failed", customer: "cus_1" },
    }),
  });
  expect(store.findBillingAccountByStripeCustomerId("cus_1")?.status).toEqual(
    "unpaid",
  );
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.dunningAction,
  ).toEqual("marked_uncollectible");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.dunningExhaustedAt,
  ).toEqual(4300);

  await applyStripeBillingEvent({
    store,
    now: 4500,
    event: stripeEvent({
      id: "evt_credit_note",
      type: "credit_note.created",
      object: {
        id: "cn_recovery",
        customer: "cus_1",
        amount: 500,
        currency: "usd",
      },
    }),
  });
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.lastCreditKind,
  ).toEqual("credit_note");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.lastCreditId,
  ).toEqual("cn_recovery");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.lastCreditAmount,
  ).toEqual(500);

  await applyStripeBillingEvent({
    store,
    now: 4750,
    event: stripeEvent({
      id: "evt_tax",
      type: "invoice.finalized",
      object: {
        id: "in_tax",
        customer: "cus_1",
        automatic_tax: { enabled: true, status: "complete" },
        customer_details: { address: { country: "US" } },
        metadata: { tax_policy_ref: "tax-policy://us-sales-tax" },
      },
    }),
  });
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.lastTaxEventId,
  ).toEqual("evt_tax");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.taxPolicyRef,
  ).toEqual("tax-policy://us-sales-tax");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.taxJurisdiction,
  ).toEqual("US");

  await applyStripeBillingEvent({
    store,
    now: 5000,
    event: stripeEvent({
      id: "evt_updated",
      type: "customer.subscription.updated",
      object: {
        customer: "cus_1",
        status: "paused",
        items: { data: [{ price: { id: "price_pro" } }] },
        metadata: { plan_code: "pro" },
        current_period_end: 1_700_200_000,
      },
    }),
  });
  expect(store.findBillingAccountByStripeCustomerId("cus_1")?.status).toEqual(
    "paused",
  );
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.currentPeriodEndUnix,
  ).toEqual(1_700_200_000);
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.stripePriceId,
  ).toEqual("price_pro");
  expect(store.findBillingAccountByStripeCustomerId("cus_1")?.planCode).toEqual(
    "pro",
  );
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")
      ?.lastPlanTransitionEventId,
  ).toEqual("evt_updated");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.lastPlanFromCode,
  ).toEqual("plus");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_1")?.lastPlanToCode,
  ).toEqual("pro");

  await applyStripeBillingEvent({
    store,
    now: 6000,
    event: stripeEvent({
      id: "evt_deleted",
      type: "customer.subscription.deleted",
      object: { customer: "cus_1" },
    }),
  });
  const canceled = store.findBillingAccountByStripeCustomerId("cus_1");
  expect(canceled?.status).toEqual("canceled");
  expect(canceled?.stripeSubscriptionId).toEqual(undefined);
  expect(canceled?.stripePriceId).toEqual(undefined);
  expect(canceled?.planCode).toEqual(undefined);
  expect(canceled?.currentPeriodEndUnix).toEqual(undefined);
});

test("applyStripeBillingEvent reconciles billing entitlements into AppInstallation status", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveBillingAccount({
    billingAccountId: "bill_1",
    subject: "tsub_account",
    provider: "stripe",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveAppInstallation({
    installationId: "inst_paid",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_1",
    status: "ready",
    createdBySubject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });

  const failed = await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_failed",
      type: "invoice.payment_failed",
      object: { customer: "cus_1" },
    }),
  });

  expect(failed.applied).toEqual(true);
  expect(
    failed.applied
      ? failed.entitlementReconciliation.suspendedInstallationIds
      : [],
  ).toEqual(["inst_paid"]);
  expect(store.findAppInstallation("inst_paid")?.status).toEqual("suspended");
  expect(
    store.listInstallationEvents("inst_paid").map((event) => event.eventType),
  ).toEqual(["installation.status_changed", "billing.entitlement_suspended"]);

  const uncollectible = await applyStripeBillingEvent({
    store,
    now: 2500,
    event: stripeEvent({
      id: "evt_uncollectible",
      type: "invoice.marked_uncollectible",
      object: { id: "in_failed", customer: "cus_1" },
    }),
  });

  expect(uncollectible.applied).toEqual(true);
  expect(store.findAppInstallation("inst_paid")?.status).toEqual("suspended");
  expect(
    store.listInstallationEvents("inst_paid").map((event) => event.eventType),
  ).toEqual(["installation.status_changed", "billing.entitlement_suspended"]);

  const paid = await applyStripeBillingEvent({
    store,
    now: 3000,
    event: stripeEvent({
      id: "evt_paid",
      type: "invoice.paid",
      object: { customer: "cus_1" },
    }),
  });

  expect(paid.applied).toEqual(true);
  expect(
    paid.applied ? paid.entitlementReconciliation.restoredInstallationIds : [],
  ).toEqual(["inst_paid"]);
  expect(store.findAppInstallation("inst_paid")?.status).toEqual("ready");
  expect(
    store.listInstallationEvents("inst_paid").map((event) => event.eventType),
  ).toEqual([
    "installation.status_changed",
    "billing.entitlement_suspended",
    "installation.status_changed",
    "billing.entitlement_restored",
  ]);
});

test("reconcileBillingEntitlements does not restore non-billing suspensions", async () => {
  const store = new InMemoryAccountsStore();
  const billingAccount = {
    billingAccountId: "bill_1",
    subject: "tsub_account" as const,
    provider: "stripe" as const,
    stripeCustomerId: "cus_1",
    status: "active" as const,
    createdAt: 1000,
    updatedAt: 1000,
  };
  store.saveBillingAccount(billingAccount);
  store.saveAppInstallation({
    installationId: "inst_manual_suspend",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_1",
    status: "suspended",
    createdBySubject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });

  const result = await reconcileBillingEntitlements({
    store,
    billingAccount,
    now: 2000,
  });

  expect(result.restoredInstallationIds).toEqual([]);
  expect(result.unchangedInstallationIds).toEqual(["inst_manual_suspend"]);
  expect(store.findAppInstallation("inst_manual_suspend")?.status).toEqual(
    "suspended",
  );
});

test("handleStripeWebhook records receipt status and skips duplicates", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });
  const payload = JSON.stringify(
    stripeEvent({
      id: "evt_checkout",
      type: "checkout.session.completed",
      object: {
        customer: "cus_1",
        subscription: "sub_1",
        payment_status: "paid",
        metadata: { takosumi_subject: "tsub_account" },
      },
    }),
  );
  const signature = await stripeSignatureHeader({
    payload,
    secret: "whsec_test",
    timestamp: 1_700_000_000,
  });

  const first = await handleStripeWebhook({
    store,
    payload,
    signature,
    secret: "whsec_test",
    now: 1_700_000_000_000,
  });
  const duplicate = await handleStripeWebhook({
    store,
    payload,
    signature,
    secret: "whsec_test",
    now: 1_700_000_000_000,
  });

  expect(first.status).toEqual("processed");
  expect(first.duplicate).toEqual(false);
  expect(duplicate.status).toEqual("processed");
  expect(duplicate.duplicate).toEqual(true);
  expect(store.findBillingWebhookEvent("evt_checkout")?.status).toEqual(
    "processed",
  );
});

test("handleStripeWebhook marks unhandled and ownerless events without retrying", async () => {
  const store = new InMemoryAccountsStore();
  const unknownPayload = JSON.stringify(
    stripeEvent({
      id: "evt_unknown",
      type: "customer.created",
      object: { id: "cus_1" },
    }),
  );
  const unknownSignature = await stripeSignatureHeader({
    payload: unknownPayload,
    secret: "whsec_test",
    timestamp: 1_700_000_000,
  });
  const unknown = await handleStripeWebhook({
    store,
    payload: unknownPayload,
    signature: unknownSignature,
    secret: "whsec_test",
    now: 1_700_000_000_000,
  });

  const ownerlessPayload = JSON.stringify(
    stripeEvent({
      id: "evt_ownerless",
      type: "checkout.session.completed",
      object: {
        customer: "cus_1",
        payment_status: "paid",
        metadata: { takosumi_subject: "tsub_missing" },
      },
    }),
  );
  const ownerlessSignature = await stripeSignatureHeader({
    payload: ownerlessPayload,
    secret: "whsec_test",
    timestamp: 1_700_000_000,
  });
  const ownerless = await handleStripeWebhook({
    store,
    payload: ownerlessPayload,
    signature: ownerlessSignature,
    secret: "whsec_test",
    now: 1_700_000_000_000,
  });

  expect(unknown.status).toEqual("skipped");
  expect(store.findBillingWebhookEvent("evt_unknown")?.status).toEqual(
    "skipped",
  );
  expect(ownerless.status).toEqual("failed");
  expect(ownerless.errorMessage).toEqual("unknown_account");
  expect(store.findBillingWebhookEvent("evt_ownerless")?.status).toEqual(
    "failed",
  );
});

function stripeEvent(input: {
  id: string;
  type: string;
  object: unknown;
  previousAttributes?: unknown;
}) {
  return {
    id: input.id,
    type: input.type,
    data: {
      object: input.object,
      ...(input.previousAttributes === undefined
        ? {}
        : { previous_attributes: input.previousAttributes }),
    },
  };
}

async function stripeSignatureHeader(input: {
  payload: string;
  secret: string;
  timestamp: number;
}): Promise<string> {
  const signature = await hmacSha256Hex(
    input.secret,
    `${input.timestamp}.${input.payload}`,
  );
  return `t=${input.timestamp},v1=${signature}`;
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
