/**
 * Atomic credit-balance ops (audit: CreditBalance was non-atomic
 * read-modify-write). `addCredits` and `reconcileMonthlyCredits` must apply in
 * a single store operation so concurrent grants cannot lose updates, and the
 * monthly reset must be idempotent per period.
 */
import { expect, test } from "bun:test";

import { CloudflareD1OpenTofuDeploymentStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

function freshStore() {
  return new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1());
}

test("addCredits seeds a zero row then grants atomically", async () => {
  const store = freshStore();
  const first = await store.addCredits("space_1", {
    credits: 100,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(first).toMatchObject({
    spaceId: "space_1",
    availableCredits: 100,
    purchasedCredits: 100,
    reservedCredits: 0,
    monthlyIncludedCredits: 0,
  });
  const second = await store.addCredits("space_1", {
    credits: 50,
    updatedAt: "2026-06-07T00:01:00.000Z",
  });
  expect(second.availableCredits).toBe(150);
  expect(second.purchasedCredits).toBe(150);
});

test("concurrent addCredits grants do not lose updates", async () => {
  const store = freshStore();
  // 20 concurrent grants of 10 — a read-modify-write would lose some; the
  // single-UPDATE delta must total exactly 200.
  await Promise.all(
    Array.from({ length: 20 }, (_v, i) =>
      store.addCredits("space_1", {
        credits: 10,
        updatedAt: `2026-06-07T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    ),
  );
  const balance = await store.getCreditBalance("space_1");
  expect(balance?.availableCredits).toBe(200);
  expect(balance?.purchasedCredits).toBe(200);
});

test("reconcileMonthlyCredits resets monthly + carries purchased, idempotent per period", async () => {
  const store = freshStore();
  // Grant 300 purchased, then a 100/mo plan reconcile.
  await store.addCredits("space_1", {
    credits: 300,
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  const r1 = await store.reconcileMonthlyCredits("space_1", {
    newMonthly: 100,
    periodStartIso: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:01.000Z",
  });
  // available = max(0, 300 - 0) + 100 = 400; monthly = 100.
  expect(r1?.availableCredits).toBe(400);
  expect(r1?.monthlyIncludedCredits).toBe(100);

  // Same period, already reconciled → skipped (no double-grant).
  const r2 = await store.reconcileMonthlyCredits("space_1", {
    newMonthly: 100,
    periodStartIso: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:02.000Z",
  });
  expect(r2).toBeUndefined();
  expect((await store.getCreditBalance("space_1"))?.availableCredits).toBe(400);

  // Spend below the monthly floor, then a NEW period reconciles back to full.
  await store.reserveCredits("space_1", {
    credits: 350,
    updatedAt: "2026-06-15T00:00:00.000Z",
  });
  expect((await store.getCreditBalance("space_1"))?.availableCredits).toBe(50);
  const r3 = await store.reconcileMonthlyCredits("space_1", {
    newMonthly: 100,
    periodStartIso: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  // available = max(0, 50 - 100) + 100 = 100 (monthly reset, purchased was
  // already drawn down).
  expect(r3?.availableCredits).toBe(100);
});

test("reconcileMonthlyCredits with newMonthly 0 ends the grant (cancellation)", async () => {
  const store = freshStore();
  await store.addCredits("space_1", {
    credits: 200,
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  await store.reconcileMonthlyCredits("space_1", {
    newMonthly: 100,
    periodStartIso: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:01.000Z",
  });
  // available now 300 (200 purchased + 100 monthly).
  const ended = await store.reconcileMonthlyCredits("space_1", {
    newMonthly: 0,
    periodStartIso: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  });
  // available = max(0, 300 - 100) + 0 = 200 (purchased kept, monthly removed).
  expect(ended?.availableCredits).toBe(200);
  expect(ended?.monthlyIncludedCredits).toBe(0);
});

test("putUsageEventAndSpendCredits spends USD micros once per idempotency key", async () => {
  const store = freshStore();
  await store.addCredits("space_1", {
    usdMicros: 1_500_000,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  const event = {
    id: "usage_1",
    spaceId: "space_1",
    kind: "egress_gb" as const,
    quantity: 1,
    usdMicros: 250_000,
    credits: 0.25,
    source: "resource_meter" as const,
    idempotencyKey: "ai:space_1:chat:1",
    createdAt: "2026-06-07T00:01:00.000Z",
  };
  const first = await store.putUsageEventAndSpendCredits(event, {
    usdMicros: 250_000,
    updatedAt: "2026-06-07T00:01:00.000Z",
  });
  const second = await store.putUsageEventAndSpendCredits(
    { ...event, id: "usage_retry" },
    {
      usdMicros: 250_000,
      updatedAt: "2026-06-07T00:02:00.000Z",
    },
  );

  expect(first?.inserted).toBe(true);
  expect(second).toMatchObject({
    inserted: false,
    usageEvent: { id: "usage_1" },
  });
  expect(await store.listUsageEvents("space_1")).toHaveLength(1);
  expect(await store.getCreditBalance("space_1")).toMatchObject({
    availableUsdMicros: 1_250_000,
  });
});

test("putUsageEventAndSpendCredits rejects insufficient USD balance without inserting usage", async () => {
  const store = freshStore();
  await store.addCredits("space_1", {
    usdMicros: 100_000,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  const result = await store.putUsageEventAndSpendCredits(
    {
      id: "usage_1",
      spaceId: "space_1",
      kind: "egress_gb",
      quantity: 1,
      usdMicros: 250_000,
      credits: 0.25,
      source: "resource_meter",
      idempotencyKey: "cf:space_1:request:1",
      createdAt: "2026-06-07T00:01:00.000Z",
    },
    {
      usdMicros: 250_000,
      updatedAt: "2026-06-07T00:01:00.000Z",
    },
  );

  expect(result).toBeUndefined();
  expect(await store.listUsageEvents("space_1")).toEqual([]);
  expect(await store.getCreditBalance("space_1")).toMatchObject({
    availableUsdMicros: 100_000,
  });
});
