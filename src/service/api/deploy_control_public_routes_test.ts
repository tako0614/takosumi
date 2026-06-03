import { expect, test } from "bun:test";

import { createApiApp } from "./app.ts";
import { OpenTofuDeploymentController } from "../domains/deploy-control/mod.ts";

test("deploy_control_public_routes — OpenTofu endpoints respond with 501 when controller is absent",
  async () => {
    const app = await createApiApp({
      registerInternalRoutes: false,
      registerDeployControlPublicRoutes: true,
      deployControlPublicRouteOptions: {
        getDeployControlToken: () => "deploy-control-token",
      },
      requestCorrelation: false,
    });

    const endpoints = [
      ["GET", "/v1/runner-profiles", undefined],
      ["POST", "/v1/plan-runs", {}],
      ["GET", "/v1/plan-runs/plan_abcdef12", undefined],
      ["POST", "/v1/apply-runs", {}],
      ["GET", "/v1/apply-runs/apply_abcdef12", undefined],
      ["GET", "/v1/installations/ins_abcdef12", undefined],
      ["GET", "/v1/installations/ins_abcdef12/deployments", undefined],
      ["GET", "/v1/installations/ins_abcdef12/deployment-outputs", undefined],
    ] as const;

    for (const [method, path, body] of endpoints) {
      const response = await app.request(path, {
        method,
        headers: {
          "authorization": "Bearer deploy-control-token",
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
  },
);

test("deploy_control_public_routes — disabled without TAKOSUMI_DEPLOY_CONTROL_TOKEN",
  async () => {
    const app = await createApiApp({
      registerInternalRoutes: false,
      registerDeployControlPublicRoutes: true,
      requestCorrelation: false,
    });

    const response = await app.request("/v1/plan-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toEqual(404);
    expect((await response.json()).error.code).toEqual("not_found");
  },
);

test("deploy_control_public_routes — rejects invalid bearer", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      getDeployControlToken: () => "deploy-control-token",
    },
    requestCorrelation: false,
  });

  const response = await app.request("/v1/plan-runs", {
    method: "POST",
    headers: {
      "authorization": "Bearer wrong-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  expect(response.status).toEqual(401);
  expect((await response.json()).error.code).toEqual("unauthenticated");
});

test("deploy_control_public_routes — scoped bearer enforces space and records actor", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      controller: new OpenTofuDeploymentController({
        now: () => 1,
        newId: () => "plan_abcdef12",
      }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
            actor: "acct_123",
            spaceIds: ["space_allowed"],
            operations: ["create"],
            runnerProfileIds: ["cloudflare-default"],
          }
          : undefined,
    },
    requestCorrelation: false,
  });

  const denied = await app.request("/v1/plan-runs", {
    method: "POST",
    headers: {
      "authorization": "Bearer scoped-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_denied",
      source: { kind: "git", url: "https://github.com/example/app.git" },
      runnerProfileId: "cloudflare-default",
    }),
  });
  expect(denied.status).toEqual(403);

  const allowed = await app.request("/v1/plan-runs", {
    method: "POST",
    headers: {
      "authorization": "Bearer scoped-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_allowed",
      source: { kind: "git", url: "https://github.com/example/app.git" },
      runnerProfileId: "cloudflare-default",
    }),
  });
  expect(allowed.status).toEqual(201);
  const payload = await allowed.json();
  expect(payload.planRun.auditEvents[0].actor).toEqual("acct_123");
});

test("deploy_control_public_routes — scoped bearer defaults to deny when scopes are omitted", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      controller: new OpenTofuDeploymentController({
        now: () => 1,
        newId: () => "plan_abcdef12",
      }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "actor-only" ? { actor: "acct_123" } : undefined,
    },
    requestCorrelation: false,
  });

  const response = await app.request("/v1/plan-runs", {
    method: "POST",
    headers: {
      "authorization": "Bearer actor-only",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_allowed",
      source: { kind: "git", url: "https://github.com/example/app.git" },
      runnerProfileId: "cloudflare-default",
    }),
  });

  expect(response.status).toEqual(403);
  expect((await response.json()).error.code).toEqual("permission_denied");
});

test("deploy_control_public_routes — runner profile list is scoped", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      controller: new OpenTofuDeploymentController({
        now: () => 1,
      }),
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
            actor: "acct_123",
            spaceIds: ["space_allowed"],
            operations: ["create"],
            runnerProfileIds: ["cloudflare-default"],
          }
          : undefined,
    },
    requestCorrelation: false,
  });

  const response = await app.request("/v1/runner-profiles", {
    headers: { authorization: "Bearer scoped-token" },
  });

  expect(response.status).toEqual(200);
  const payload = await response.json();
  expect(payload.runnerProfiles.map((profile: { id: string }) => profile.id))
    .toEqual(["cloudflare-default"]);
});
