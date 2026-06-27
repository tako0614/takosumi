import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuDeploymentController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";

async function makeApp() {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putSpace({
    id: "space_12345678",
    handle: "billing",
    displayName: "Billing",
    type: "personal",
    ownerUserId: "user_1",
    billingSettings: { mode: "showback", provider: "none" },
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putCreditBalance({
    spaceId: "space_12345678",
    availableCredits: 12,
    reservedCredits: 2,
    monthlyIncludedCredits: 10,
    purchasedCredits: 4,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putBillingPlan({
    id: "pro",
    name: "Pro",
    monthlyBasePrice: 2000,
    includedCredits: 700,
    limits: {
      maxEstimatedCreditsPerRun: 100,
      quota: { gateway_compute: 5 },
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  await store.putBillingAccount({
    id: "bill_space_12345678",
    ownerType: "space",
    ownerId: "space_12345678",
    provider: "stripe",
    stripeCustomerId: "cus_123",
    status: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putSpaceSubscription({
    id: "sub_123",
    spaceId: "space_12345678",
    billingAccountId: "bill_space_12345678",
    planId: "pro",
    status: "active",
    currentPeriodStart: "2026-06-01T00:00:00.000Z",
    currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putUsageEvent({
    id: "usage_1",
    spaceId: "space_12345678",
    runId: "apply_1",
    kind: "operation",
    quantity: 1,
    credits: 1,
    source: "runner",
    idempotencyKey: "apply_1:operation",
    createdAt: "2026-06-07T00:00:01.000Z",
  });
  await store.putCreditReservation({
    id: "cres_1",
    spaceId: "space_12345678",
    runId: "plan_1",
    estimatedCredits: 28,
    status: "reserved",
    mode: "enforce",
    createdAt: "2026-06-07T00:00:02.000Z",
    expiresAt: "2026-06-07T01:00:02.000Z",
  });
  const controller = new OpenTofuDeploymentController({ store });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_1",
              spaceIds: ["space_12345678"],
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  return { app, store };
}

const HEADERS = {
  authorization: "Bearer scoped-token",
  "content-type": "application/json",
} as const;

test("GET /internal/v1/spaces/:spaceId/billing returns settings and balance", async () => {
  const { app } = await makeApp();

  const response = await app.request(
    "/internal/v1/spaces/space_12345678/billing",
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    billing: {
      settings: { mode: "showback", provider: "none" },
      balance: {
        spaceId: "space_12345678",
        availableUsdMicros: 702_000_000,
        reservedUsdMicros: 2_000_000,
        monthlyIncludedUsdMicros: 700_000_000,
        purchasedUsdMicros: 4_000_000,
        availableCredits: 702,
        reservedCredits: 2,
        monthlyIncludedCredits: 700,
        purchasedCredits: 4,
        updatedAt: expect.any(String),
      },
      account: {
        id: "bill_space_12345678",
        ownerType: "space",
        ownerId: "space_12345678",
        provider: "stripe",
        stripeCustomerId: "cus_123",
        status: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
      },
      subscription: {
        id: "sub_123",
        spaceId: "space_12345678",
        billingAccountId: "bill_space_12345678",
        planId: "pro",
        status: "active",
        currentPeriodStart: "2026-06-01T00:00:00.000Z",
        currentPeriodEnd: "2026-07-01T00:00:00.000Z",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
      },
      plan: {
        id: "pro",
        name: "Pro",
        monthlyBasePrice: 2000,
        includedUsdMicros: 700_000_000,
        includedCredits: 700,
        limits: {
          maxEstimatedCreditsPerRun: 100,
          quota: { gateway_compute: 5 },
        },
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    },
  });
});

test("GET /internal/v1/spaces/:spaceId/usage lists usage events", async () => {
  const { app } = await makeApp();

  const response = await app.request(
    "/internal/v1/spaces/space_12345678/usage",
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );

  expect(response.status).toBe(200);
  expect((await response.json()).usageEvents).toEqual([
    expect.objectContaining({
      id: "usage_1",
      kind: "operation",
      credits: 1,
    }),
  ]);
});

test("GET /internal/v1/spaces/:spaceId/credit-reservations lists reservation history", async () => {
  const { app } = await makeApp();

  const response = await app.request(
    "/internal/v1/spaces/space_12345678/credit-reservations",
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );

  expect(response.status).toBe(200);
  expect((await response.json()).creditReservations).toEqual([
    expect.objectContaining({
      id: "cres_1",
      runId: "plan_1",
      estimatedCredits: 28,
      status: "reserved",
      mode: "enforce",
    }),
  ]);
});

test("POST /internal/v1/spaces/:spaceId/credits/top-up adds purchased credits", async () => {
  const { app } = await makeApp();

  const response = await app.request(
    "/internal/v1/spaces/space_12345678/credits/top-up",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ credits: 8 }),
    },
  );

  expect(response.status).toBe(200);
  expect((await response.json()).balance).toMatchObject({
    availableCredits: 710,
    reservedCredits: 2,
    monthlyIncludedCredits: 700,
    purchasedCredits: 12,
  });
});

test("POST /internal/v1/spaces/:spaceId/credits/top-up rejects invalid credits", async () => {
  const { app } = await makeApp();

  for (const credits of [0, "8"]) {
    const response = await app.request(
      "/internal/v1/spaces/space_12345678/credits/top-up",
      {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ credits }),
      },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_argument");
  }
  const invalidMicros = await app.request(
    "/internal/v1/spaces/space_12345678/credits/top-up",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ usdMicros: 1.5 }),
    },
  );
  expect(invalidMicros.status).toBe(400);
  expect((await invalidMicros.json()).error.code).toBe("invalid_argument");
});

test("billing routes reject an unknown Space", async () => {
  const { app } = await makeApp();

  for (const path of [
    "/internal/v1/spaces/space_99999999/billing",
    "/internal/v1/spaces/space_99999999/usage",
    "/internal/v1/spaces/space_99999999/credit-reservations",
  ]) {
    const response = await app.request(path, {
      headers: { authorization: "Bearer scoped-token" },
    });
    expect(response.status).toBe(403);
  }

  const appWithWideScope = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller: new OpenTofuDeploymentController({
        store: new InMemoryOpenTofuDeploymentStore(),
      }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "wide-token"
          ? {
              actor: "acct_1",
              spaceIds: "*",
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });

  const response = await appWithWideScope.request(
    "/internal/v1/spaces/space_99999999/credits/top-up",
    {
      method: "POST",
      headers: {
        authorization: "Bearer wide-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ credits: 1 }),
    },
  );
  expect(response.status).toBe(404);
});

test("POST /internal/v1/spaces/:spaceId/subscription/change updates billing settings", async () => {
  const { app, store } = await makeApp();

  const response = await app.request(
    "/internal/v1/spaces/space_12345678/subscription/change",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        billingSettings: {
          mode: "showback",
          provider: "manual",
        },
      }),
    },
  );

  expect(response.status).toBe(200);
  expect((await response.json()).billing.settings).toEqual({
    mode: "showback",
    provider: "manual",
  });
  expect((await store.getSpace("space_12345678"))?.billingSettings).toEqual({
    mode: "showback",
    provider: "manual",
  });
});

test("POST /internal/v1/spaces/:spaceId/subscription/change rejects invalid billing settings", async () => {
  const { app } = await makeApp();

  for (const billingSettings of [
    // enforce is a Takosumi Cloud-only mode; OSS rejects it outright.
    { mode: "enforce", provider: "none", reservationRequired: true },
    { mode: "enforce", provider: "manual", reservationRequired: true },
    { mode: "disabled", provider: "manual" },
    { mode: "showback", provider: "manual", reservationRequired: true },
    { mode: "showback", provider: "bogus" },
    { mode: "bogus", provider: "none" },
  ]) {
    const response = await app.request(
      "/internal/v1/spaces/space_12345678/subscription/change",
      {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ billingSettings }),
      },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_argument");
  }
});

test("billing routes enforce space scope", async () => {
  const { app } = await makeApp();

  const response = await app.request(
    "/internal/v1/spaces/space_87654321/billing",
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );

  expect(response.status).toBe(403);
});
