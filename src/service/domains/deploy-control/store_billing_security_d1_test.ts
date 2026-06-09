import { expect, test } from "bun:test";

import { CloudflareD1OpenTofuDeploymentStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "./sqlite_fake_d1.ts";

test("d1 store persists security findings and billing ledger rows", async () => {
  const store = new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1());

  await store.putSecurityFinding({
    id: "sec_1",
    spaceId: "space_1",
    installationId: "inst_1",
    runId: "run_1",
    severity: "error",
    type: "provider_install_denied",
    message: "provider mirror evidence is missing",
    metadata: { code: "provider_mirror_required" },
    createdAt: "2026-06-07T00:00:01.000Z",
  });
  await store.putSecurityFinding({
    id: "sec_2",
    spaceId: "space_1",
    runId: "run_2",
    severity: "warning",
    type: "policy_warning",
    message: "warning",
    metadata: {},
    createdAt: "2026-06-07T00:00:02.000Z",
  });

  expect(
    (await store.listSecurityFindings("space_1")).map((row) => row.id),
  ).toEqual(["sec_2", "sec_1"]);
  expect(
    (await store.listSecurityFindings("space_1", { runId: "run_1" })).map(
      (row) => row.id,
    ),
  ).toEqual(["sec_1"]);

  await store.putBillingAccount({
    id: "bill_1",
    ownerType: "space",
    ownerId: "space_1",
    provider: "stripe",
    stripeCustomerId: "cus_1",
    status: "active",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(
    await store.getBillingAccountForOwner("space", "space_1"),
  ).toMatchObject({ id: "bill_1", provider: "stripe" });

  await store.putBillingPlan({
    id: "pro",
    name: "Pro",
    monthlyBasePrice: 2000,
    includedCredits: 1000,
    limits: {
      maxEstimatedCreditsPerRun: 100,
      quota: { resources: 20 },
    },
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(await store.getBillingPlan("pro")).toMatchObject({
    id: "pro",
    limits: {
      maxEstimatedCreditsPerRun: 100,
      quota: { resources: 20 },
    },
  });

  await store.putSpaceSubscription({
    id: "sub_1",
    spaceId: "space_1",
    billingAccountId: "bill_1",
    planId: "pro",
    status: "active",
    currentPeriodStart: "2026-06-01T00:00:00.000Z",
    currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(await store.getSpaceSubscription("space_1")).toMatchObject({
    id: "sub_1",
    planId: "pro",
  });

  await store.putCreditBalance({
    spaceId: "space_1",
    availableCredits: 20,
    reservedCredits: 5,
    monthlyIncludedCredits: 10,
    purchasedCredits: 15,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(
    await store.reserveCredits("space_1", {
      credits: 7,
      updatedAt: "2026-06-07T00:00:01.000Z",
    }),
  ).toMatchObject({
    availableCredits: 13,
    reservedCredits: 12,
    updatedAt: "2026-06-07T00:00:01.000Z",
  });
  expect(
    await store.reserveCredits("space_1", {
      credits: 99,
      updatedAt: "2026-06-07T00:00:02.000Z",
    }),
  ).toBeUndefined();

  await store.putCreditReservation({
    id: "creditres_1",
    spaceId: "space_1",
    runId: "plan_1",
    estimatedCredits: 7,
    status: "reserved",
    mode: "enforce",
    createdAt: "2026-06-07T00:00:01.000Z",
    expiresAt: "2026-06-08T00:00:01.000Z",
  });
  expect(await store.getCreditReservationForRun("plan_1")).toMatchObject({
    id: "creditres_1",
    mode: "enforce",
  });
  expect(
    (await store.listCreditReservations("space_1")).map((row) => row.id),
  ).toEqual(["creditres_1"]);

  await store.putUsageEvent({
    id: "usage_1",
    spaceId: "space_1",
    installationId: "inst_1",
    runId: "apply_1",
    kind: "operation",
    quantity: 1,
    credits: 7,
    source: "runner",
    idempotencyKey: "apply_1:operation",
    createdAt: "2026-06-07T00:00:03.000Z",
  });
  await store.putUsageEvent({
    id: "usage_duplicate",
    spaceId: "space_1",
    runId: "apply_1",
    kind: "operation",
    quantity: 1,
    credits: 999,
    source: "runner",
    idempotencyKey: "apply_1:operation",
    createdAt: "2026-06-07T00:00:04.000Z",
  });
  expect(await store.listUsageEvents("space_1")).toEqual([
    {
      id: "usage_1",
      spaceId: "space_1",
      installationId: "inst_1",
      runId: "apply_1",
      kind: "operation",
      quantity: 1,
      credits: 7,
      source: "runner",
      idempotencyKey: "apply_1:operation",
      createdAt: "2026-06-07T00:00:03.000Z",
    },
  ]);
});

test("d1 store accepts operator-scoped connections without a space id", async () => {
  const store = new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1());

  await store.putConnection({
    id: "conn_operator_cf",
    provider: "cloudflare",
    scope: "operator",
    owner: "operator",
    authMethod: "static_secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  expect((await store.listOperatorConnections()).map((row) => row.id)).toEqual([
    "conn_operator_cf",
  ]);
});
