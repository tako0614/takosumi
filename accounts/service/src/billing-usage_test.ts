import { expect, test } from "bun:test";

import { aggregateBillingUsage } from "./billing-usage.ts";
import type { BillingUsageRecord } from "./store.ts";

test("aggregateBillingUsage returns empty for empty input", () => {
  expect(aggregateBillingUsage([])).toEqual([]);
  expect(aggregateBillingUsage([], {
      billingAccountId: "bill_1",
      windowStart: 0,
      windowEnd: 1_000,
    })).toEqual([]);
});

test("aggregateBillingUsage window boundaries are inclusive on both ends",
  () => {
    const baseRecord = (
      overrides: Partial<BillingUsageRecord>,
    ): BillingUsageRecord => ({
      usageReportId: overrides.usageReportId ?? "u",
      installationId: "inst_1",
      billingAccountId: "bill_1",
      meter: "agent.compute.seconds",
      quantity: overrides.quantity ?? 1,
      unit: "seconds",
      requestDigest: "sha256:test",
      metadata: {},
      reportedAt: overrides.reportedAt ?? 0,
      ...overrides,
    });

    // exact-equal boundary: periodStart === windowStart and periodEnd === windowEnd.
    const rollups = aggregateBillingUsage([
      baseRecord({
        usageReportId: "u_lower",
        periodStart: 100,
        periodEnd: 150,
        reportedAt: 100,
        quantity: 2,
      }),
      baseRecord({
        usageReportId: "u_upper",
        periodStart: 150,
        periodEnd: 200,
        reportedAt: 150,
        quantity: 3,
      }),
      // just below windowStart -> excluded
      baseRecord({
        usageReportId: "u_before",
        periodStart: 99,
        periodEnd: 100,
        reportedAt: 99,
        quantity: 11,
      }),
      // just above windowEnd -> excluded
      baseRecord({
        usageReportId: "u_after",
        periodStart: 200,
        periodEnd: 201,
        reportedAt: 200,
        quantity: 13,
      }),
    ], { windowStart: 100, windowEnd: 200 });

    expect(rollups.length).toEqual(1);
    expect(rollups[0]?.quantity).toEqual(5);
    expect(rollups[0]?.usageReportIds).toEqual(["u_lower", "u_upper"]);
  },
);

test("aggregateBillingUsage partitions rollups across billing accounts when no filter is set",
  () => {
    const rollups = aggregateBillingUsage([
      {
        usageReportId: "u1",
        installationId: "inst_1",
        billingAccountId: "bill_1",
        meter: "agent.compute.seconds",
        quantity: 4,
        unit: "seconds",
        requestDigest: "sha256:1",
        metadata: {},
        reportedAt: 10,
      },
      {
        usageReportId: "u2",
        installationId: "inst_2",
        billingAccountId: "bill_2",
        meter: "agent.compute.seconds",
        quantity: 6,
        unit: "seconds",
        requestDigest: "sha256:2",
        metadata: {},
        reportedAt: 20,
      },
      // different unit -> separate rollup even on bill_1.
      {
        usageReportId: "u3",
        installationId: "inst_1",
        billingAccountId: "bill_1",
        meter: "agent.compute.seconds",
        quantity: 5,
        unit: "minutes",
        requestDigest: "sha256:3",
        metadata: {},
        reportedAt: 30,
      },
    ]);

    // expect three distinct rollups; sum is *not* cross-account or cross-unit.
    expect(rollups.length).toEqual(3);
    const bill1Seconds = rollups.find((r) =>
      r.billingAccountId === "bill_1" && r.unit === "seconds"
    );
    const bill1Minutes = rollups.find((r) =>
      r.billingAccountId === "bill_1" && r.unit === "minutes"
    );
    const bill2 = rollups.find((r) => r.billingAccountId === "bill_2");
    expect(bill1Seconds?.quantity).toEqual(4);
    expect(bill1Minutes?.quantity).toEqual(5);
    expect(bill2?.quantity).toEqual(6);
  },
);

test("aggregateBillingUsage falls back to reportedAt when periodStart/periodEnd are absent",
  () => {
    const rollups = aggregateBillingUsage([
      {
        usageReportId: "u_no_period",
        installationId: "inst_1",
        billingAccountId: "bill_1",
        meter: "agent.compute.tokens",
        quantity: 9,
        unit: "tokens",
        requestDigest: "sha256:np",
        metadata: {},
        reportedAt: 150,
      },
    ], { windowStart: 100, windowEnd: 200 });

    expect(rollups.length).toEqual(1);
    expect(rollups[0]?.quantity).toEqual(9);
    // periodStart/periodEnd should remain undefined on the rollup.
    expect(rollups[0]?.periodStart).toEqual(undefined);
    expect(rollups[0]?.periodEnd).toEqual(undefined);

    // Same record outside window -> excluded by reportedAt fallback.
    const excluded = aggregateBillingUsage([
      {
        usageReportId: "u_no_period",
        installationId: "inst_1",
        billingAccountId: "bill_1",
        meter: "agent.compute.tokens",
        quantity: 9,
        unit: "tokens",
        requestDigest: "sha256:np",
        metadata: {},
        reportedAt: 50,
      },
    ], { windowStart: 100, windowEnd: 200 });
    expect(excluded).toEqual([]);
  },
);
