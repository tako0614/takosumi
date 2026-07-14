import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";

const WORKSPACE_ID = "ws_12345678";

async function makeApp() {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace({
    id: WORKSPACE_ID,
    handle: "billing",
    displayName: "Billing",
    type: "personal",
    ownerUserId: "user_1",
    billingSettings: { mode: "showback" },
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putUsageEvent({
    id: "usage_1",
    workspaceId: WORKSPACE_ID,
    capsuleId: "capsule_1",
    runId: "apply_1",
    kind: "opentofu.apply",
    quantity: 1,
    usdMicros: 1_000_000,
    ratingStatus: "rated",
    source: "runner",
    idempotencyKey: "apply_1:opentofu.apply",
    createdAt: "2026-06-07T00:00:01.000Z",
  });
  const controller = new OpenTofuController({ store });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_1",
              workspaceIds: [WORKSPACE_ID],
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

test("GET /internal/v1/workspaces/:workspaceId/billing returns OSS showback settings only", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/billing`,
    { headers: { authorization: "Bearer scoped-token" } },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    billing: { settings: { mode: "showback" } },
  });
});

test("GET /internal/v1/workspaces/:workspaceId/usage lists USD showback events", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/usage`,
    { headers: { authorization: "Bearer scoped-token" } },
  );

  expect(response.status).toBe(200);
  expect((await response.json()).usageEvents).toEqual([
    expect.objectContaining({
      id: "usage_1",
      workspaceId: WORKSPACE_ID,
      capsuleId: "capsule_1",
      kind: "opentofu.apply",
      usdMicros: 1_000_000,
      ratingStatus: "rated",
    }),
  ]);
});

test("PATCH /internal/v1/workspaces/:workspaceId/billing updates disabled/showback mode", async () => {
  const { app, store } = await makeApp();
  const response = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/billing`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ billingSettings: { mode: "disabled" } }),
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    billing: { settings: { mode: "disabled" } },
  });
  expect((await store.getWorkspace(WORKSPACE_ID))?.billingSettings).toEqual({
    mode: "disabled",
  });
});

test("PATCH /internal/v1/workspaces/:workspaceId/billing rejects commercial fields and modes", async () => {
  const { app } = await makeApp();
  for (const billingSettings of [
    { mode: "enforce" },
    { mode: "showback", provider: "manual" },
    { mode: "disabled", reservationRequired: true },
    { mode: "bogus" },
  ]) {
    const response = await app.request(
      `/internal/v1/workspaces/${WORKSPACE_ID}/billing`,
      {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ billingSettings }),
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_argument");
  }
});

test("billing routes enforce Workspace scope", async () => {
  const { app } = await makeApp();
  for (const path of [
    "/internal/v1/workspaces/ws_87654321/billing",
    "/internal/v1/workspaces/ws_87654321/usage",
  ]) {
    const response = await app.request(path, {
      headers: { authorization: "Bearer scoped-token" },
    });
    expect(response.status).toBe(403);
  }
});

test("removed OSS commercial billing routes are not mounted", async () => {
  const { app } = await makeApp();
  for (const path of [
    `/internal/v1/workspaces/${WORKSPACE_ID}/credit-reservations`,
    `/internal/v1/workspaces/${WORKSPACE_ID}/credits/top-up`,
    `/internal/v1/workspaces/${WORKSPACE_ID}/subscription/change`,
  ]) {
    const response = await app.request(path, {
      method: path.endsWith("credit-reservations") ? "GET" : "POST",
      headers: HEADERS,
      body: path.endsWith("credit-reservations") ? undefined : "{}",
    });
    expect(response.status).toBe(404);
  }
});
