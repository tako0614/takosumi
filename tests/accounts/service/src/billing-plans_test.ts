/**
 * Billing plan catalog (spec §32): operator JSON parsing, the public
 * projection, and the invoice → monthly-credit-grant extraction.
 */
import { describe, expect, test } from "bun:test";
import { parseBillingPlans, publicBillingPlans } from "../../../../accounts/service/src/billing-plans.ts";
import { stripeInvoiceCreditReconciliationInput } from "../../../../accounts/service/src/billing-routes.ts";

const VALID_PLAN = {
  id: "starter",
  kind: "subscription",
  stripePriceId: "price_starter",
  credits: 500,
  name: { ja: "スターター", en: "Starter" },
  priceDisplay: { ja: "¥1,000 / 月", en: "$8 / mo" },
};

describe("parseBillingPlans", () => {
  test("parses a valid catalog", () => {
    const plans = parseBillingPlans(
      JSON.stringify([
        VALID_PLAN,
        { ...VALID_PLAN, id: "pack-s", kind: "pack", credits: 100 },
      ]),
    );
    expect(plans).toHaveLength(2);
    expect(plans[0]!.id).toEqual("starter");
    expect(plans[1]!.kind).toEqual("pack");
  });

  test("empty / absent / malformed JSON yields an empty catalog", () => {
    expect(parseBillingPlans(undefined)).toHaveLength(0);
    expect(parseBillingPlans("")).toHaveLength(0);
    expect(parseBillingPlans("not json")).toHaveLength(0);
    expect(parseBillingPlans('{"id":"x"}')).toHaveLength(0);
  });

  test("skips invalid entries without dropping valid ones", () => {
    const plans = parseBillingPlans(
      JSON.stringify([
        VALID_PLAN,
        { ...VALID_PLAN, id: "bad-credits", credits: -5 },
        { ...VALID_PLAN, id: "bad-kind", kind: "donation" },
        { ...VALID_PLAN, id: "bad-name", name: { ja: "のみ" } },
        "garbage",
      ]),
    );
    expect(plans.map((plan) => plan.id)).toEqual(["starter"]);
  });

  test("skips duplicate ids (first wins)", () => {
    const plans = parseBillingPlans(
      JSON.stringify([VALID_PLAN, { ...VALID_PLAN, credits: 999 }]),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.credits).toEqual(500);
  });

  test("the public projection drops the Stripe price id", () => {
    const plans = parseBillingPlans(JSON.stringify([VALID_PLAN]));
    const projected = publicBillingPlans(plans);
    expect(projected[0]).toEqual({
      id: "starter",
      kind: "subscription",
      credits: 500,
      name: { ja: "スターター", en: "Starter" },
      priceDisplay: { ja: "¥1,000 / 月", en: "$8 / mo" },
    });
    expect(
      (projected[0] as Record<string, unknown>).stripePriceId,
    ).toBeUndefined();
  });
});

describe("stripeInvoiceCreditReconciliationInput", () => {
  const invoiceEvent = (overrides?: {
    type?: string;
    metadata?: Record<string, unknown> | undefined;
  }) =>
    JSON.stringify({
      id: "evt_invoice_1",
      type: overrides?.type ?? "invoice.paid",
      data: {
        object: {
          object: "invoice",
          subscription: "sub_1",
          subscription_details: {
            metadata:
              overrides && "metadata" in overrides
                ? overrides.metadata
                : { space_id: "space_a", plan_code: "starter", credits: "500" },
          },
        },
      },
    });

  test("grants the plan credits to the metadata Space for invoice.paid", () => {
    expect(stripeInvoiceCreditReconciliationInput(invoiceEvent())).toEqual({
      spaceId: "space_a",
      credits: 500,
      stripeEventId: "evt_invoice_1",
    });
  });

  test("accepts invoice.payment_succeeded as the grant trigger too", () => {
    expect(
      stripeInvoiceCreditReconciliationInput(
        invoiceEvent({ type: "invoice.payment_succeeded" }),
      ),
    ).toEqual({
      spaceId: "space_a",
      credits: 500,
      stripeEventId: "evt_invoice_1",
    });
  });

  test("ignores other event types and incomplete metadata", () => {
    expect(
      stripeInvoiceCreditReconciliationInput(
        invoiceEvent({ type: "invoice.payment_failed" }),
      ),
    ).toBeUndefined();
    expect(
      stripeInvoiceCreditReconciliationInput(
        invoiceEvent({ metadata: { space_id: "space_a" } }),
      ),
    ).toBeUndefined();
    expect(
      stripeInvoiceCreditReconciliationInput(
        invoiceEvent({ metadata: undefined }),
      ),
    ).toBeUndefined();
    expect(
      stripeInvoiceCreditReconciliationInput(
        invoiceEvent({
          metadata: { space_id: "space_a", credits: "-10" },
        }),
      ),
    ).toBeUndefined();
  });
});
