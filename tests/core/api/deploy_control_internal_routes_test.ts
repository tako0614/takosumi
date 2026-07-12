import { expect, test } from "bun:test";
import type { Context } from "hono";

import { createApiApp } from "../../../core/api/app.ts";
import { runHandler } from "../../../core/api/deploy_control_shared.ts";
import {
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
import { seedInstallationModel } from "../../helpers/deploy-control/model_fixture.ts";
import { OutputSharesService } from "../../../core/domains/output-shares/mod.ts";
import type { Output as OutputSnapshot } from "takosumi-contract/outputs";
import type { Workspace as Space } from "takosumi-contract/workspaces";

class ForeignControllerError extends Error {
  readonly code = "failed_precondition";
}

test("runHandler renders structural controller errors without collapsing to 500", async () => {
  const context = {
    req: {
      path: "/internal/v1/test",
      method: "POST",
      header: () => undefined,
    },
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Context;

  const response = await runHandler(context, async () => {
    throw new ForeignControllerError("foreign controller failure");
  });

  expect(response.status).toEqual(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      message: "foreign controller failure",
    },
  });
});

test("runHandler hides public hostname reservation owner details", async () => {
  const context = {
    req: {
      path: "/internal/v1/test",
      method: "POST",
      header: () => undefined,
    },
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Context;

  const response = await runHandler(context, async () => {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "app_hostname_unavailable: yurucommu.app.takos.jp is already claimed by Capsule yurucommu (inst_1) in Workspace space_1",
    );
  });

  expect(response.status).toEqual(409);
  const body = await response.json();
  expect(body).toMatchObject({
    error: {
      code: "failed_precondition",
      message: "app_hostname_unavailable: already exists",
      details: { reason: "app_hostname_unavailable" },
    },
  });
  expect(JSON.stringify(body)).not.toMatch(
    /\b(?:Workspace|Capsule|inst_1|space_1|yurucommu\.app\.takos\.jp)\b/u,
  );
});

test("deploy_control_internal_routes — internal seam endpoints respond with 501 when controller is absent", async () => {
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      mountInternalLedgerRoutes: true,
      getDeployControlToken: () => "deploy-control-token",
    },
    requestCorrelation: false,
  });

  const endpoints = [
    ["GET", "/internal/v1/workspaces", undefined],
    ["POST", "/internal/v1/workspaces", {}],
    ["GET", "/internal/v1/sources", undefined],
    ["POST", "/internal/v1/sources", {}],
    ["GET", "/internal/v1/capsules/ins_abcdef12", undefined],
    ["POST", "/internal/v1/capsules/ins_abcdef12/plan", {}],
    ["GET", "/internal/v1/runs/plan_abcdef12", undefined],
    ["POST", "/internal/v1/runs/plan_abcdef12/approve", {}],
    ["GET", "/internal/v1/workspaces/space_abcdef12/billing", undefined],
    ["GET", "/internal/v1/workspaces/space_abcdef12/usage", undefined],
    [
      "POST",
      "/internal/v1/workspaces/space_abcdef12/credits/top-up",
      { credits: 1 },
    ],
    [
      "POST",
      "/internal/v1/workspaces/space_abcdef12/subscription/change",
      { billingSettings: { mode: "disabled", provider: "none" } },
    ],
  ] as const;

  for (const [method, path, body] of endpoints) {
    const response = await app.request(path, {
      method,
      headers: {
        authorization: "Bearer deploy-control-token",
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toEqual(501);
    const json = await response.json();
    expect(json.error.code).toEqual("not_implemented");
    expect(typeof json.error.message).toEqual("string");
    expect(typeof json.error.requestId).toEqual("string");
  }
});

test("deploy_control_internal_routes — disabled without TAKOSUMI_DEPLOY_CONTROL_TOKEN", async () => {
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    requestCorrelation: false,
  });

  const response = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toEqual(404);
  expect((await response.json()).error.code).toEqual("not_found");
});

test("deploy_control_internal_routes — rejects invalid bearer", async () => {
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      mountInternalLedgerRoutes: true,
      getDeployControlToken: () => "deploy-control-token",
    },
    requestCorrelation: false,
  });

  const response = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  expect(response.status).toEqual(401);
  expect((await response.json()).error.code).toEqual("unauthenticated");
});

test("deploy_control_internal_routes — scoped bearer enforces space and records actor", async () => {
  // Installation-first model (spec §5): a raw POST /internal/v1/plan-runs
  // targets an existing Installation. Seed one in the allowed space so the controller has a
  // valid plan target; the denied case is rejected by the route's space-scope
  // check before the controller is reached.
  const store = new InMemoryOpenTofuDeploymentStore();
  const { installation } = await seedInstallationModel(store, {
    spaceId: "space_allowed",
    installationId: "inst_allowed1",
  });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      mountInternalLedgerRoutes: true,
      controller: new OpenTofuDeploymentController({
        store,
        now: () => 1,
        newId: () => "plan_abcdef12",
      }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_123",
              spaceIds: ["space_allowed"],
              operations: ["create"],
              runnerProfileIds: ["opentofu-default"],
            }
          : undefined,
    },
    requestCorrelation: false,
  });

  const denied = await app.request("/internal/v1/plan-runs", {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_denied",
      installationId: installation.id,
      operation: "create",
      source: { kind: "git", url: "https://github.com/example/app.git" },
      runnerProfileId: "opentofu-default",
    }),
  });
  expect(denied.status).toEqual(403);

  const allowed = await app.request("/internal/v1/plan-runs", {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_allowed",
      installationId: installation.id,
      // The principal is scoped to `create`; pass it explicitly so the route's
      // permission check matches (installationId would otherwise default to
      // `update`).
      operation: "create",
      source: { kind: "git", url: "https://github.com/example/app.git" },
      runnerProfileId: "opentofu-default",
    }),
  });
  expect(allowed.status).toEqual(201);
  const payload = await allowed.json();
  expect(payload.planRun.auditEvents[0].actor).toEqual("acct_123");
});

test("retired generic-env provider routes are not mounted", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      mountInternalLedgerRoutes: true,
      controller: new OpenTofuDeploymentController({ store }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_123",
              spaceIds: ["space_allowed"],
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });

  const response = await app.request(
    "/api/retired-generic-env-provider/cpp_foreign0001/verify",
    {
      method: "POST",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(response.status).toBe(404);
});

test("deploy_control_internal_routes — scoped bearer defaults to deny when scopes are omitted", async () => {
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      mountInternalLedgerRoutes: true,
      controller: new OpenTofuDeploymentController({
        now: () => 1,
        newId: () => "plan_abcdef12",
      }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "actor-only" ? { actor: "acct_123" } : undefined,
    },
    requestCorrelation: false,
  });

  const response = await app.request("/internal/v1/plan-runs", {
    method: "POST",
    headers: {
      authorization: "Bearer actor-only",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_allowed",
      source: { kind: "git", url: "https://github.com/example/app.git" },
      runnerProfileId: "opentofu-default",
    }),
  });

  expect(response.status).toEqual(403);
  expect((await response.json()).error.code).toEqual("permission_denied");
});

test("deploy_control_internal_routes — runner profile list is scoped", async () => {
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      mountInternalLedgerRoutes: true,
      controller: new OpenTofuDeploymentController({
        now: () => 1,
      }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_123",
              spaceIds: ["space_allowed"],
              operations: ["create"],
              runnerProfileIds: ["opentofu-default"],
            }
          : undefined,
    },
    requestCorrelation: false,
  });

  const response = await app.request("/internal/v1/runner-profiles", {
    headers: { authorization: "Bearer scoped-token" },
  });

  expect(response.status).toEqual(200);
  const payload = await response.json();
  expect(
    payload.runnerProfiles.map((profile: { id: string }) => profile.id),
  ).toEqual(["opentofu-default"]);
});

// --- OutputShares scoped-principal permission tests (§18) ---------------------

const SHARE_TS = "2026-06-06T00:00:00.000Z";

/**
 * Wires the internal routes over a store seeded with a producer Installation in
 * `space_allowed`, a consumer Space `space_consume1`, and a latest
 * OutputSnapshot projecting `bucket_name`. The bearer `scoped-token` maps to a
 * principal scoped to `space_allowed` only.
 */
async function outputShareApp() {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedInstallationModel(store, {
    spaceId: "space_allowed",
    installationId: "inst_producer1",
    name: "producer",
  });
  const consumer: Space = {
    id: "space_consume1",
    handle: "consumer",
    displayName: "Consumer",
    type: "personal",
    ownerUserId: "user_consumer",
    createdAt: SHARE_TS,
    updatedAt: SHARE_TS,
  };
  await store.putSpace(consumer);
  const snapshot: OutputSnapshot = {
    id: "out_scoped01",
    spaceId: "space_allowed",
    installationId: "inst_producer1",
    stateGeneration: 1,
    rawOutputArtifactKey: "k",
    publicOutputs: {},
    spaceOutputs: { bucket_name: "my-bucket" },
    outputDigest: "sha256:o",
    createdAt: SHARE_TS,
  };
  await store.putOutputSnapshot(snapshot);
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      mountInternalLedgerRoutes: true,
      controller: new OpenTofuDeploymentController({ store, now: () => 1 }),
      outputSharesService: new OutputSharesService({
        store,
        now: () => SHARE_TS,
        newId: () => "oshare_scoped01",
      }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_123",
              spaceIds: ["space_allowed"],
              operations: ["create"],
              runnerProfileIds: ["opentofu-default"],
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  return app;
}

test("output-shares create — scoped bearer allowed on its fromSpace (§18)", async () => {
  const app = await outputShareApp();
  const res = await app.request("/internal/v1/output-shares", {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fromSpaceId: "space_allowed",
      toSpaceId: "space_consume1",
      producerInstallationId: "inst_producer1",
      outputs: [{ name: "bucket_name" }],
    }),
  });
  expect(res.status).toEqual(201);
  expect((await res.json()).share.status).toEqual("pending");
});

test("output-shares create — scoped bearer denied on a foreign fromSpace (§18)", async () => {
  const app = await outputShareApp();
  const res = await app.request("/internal/v1/output-shares", {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fromSpaceId: "space_denied",
      toSpaceId: "space_consume1",
      producerInstallationId: "inst_producer1",
      outputs: [{ name: "bucket_name" }],
    }),
  });
  expect(res.status).toEqual(403);
  expect((await res.json()).error.code).toEqual("permission_denied");
});

test("output-shares list — scoped bearer denied on a foreign spaceId (§18)", async () => {
  const app = await outputShareApp();
  // space_denied01 is a valid id shape the scoped principal is NOT allowed.
  const res = await app.request(
    "/internal/v1/output-shares?spaceId=space_denied01",
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(res.status).toEqual(403);
});
