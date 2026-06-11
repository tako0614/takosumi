import { expect, test } from "bun:test";

import { createApiApp } from "./app.ts";
import { OpenTofuDeploymentController } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import { seedInstallationModel } from "../domains/deploy-control/test_model_fixture.ts";
import { OutputSharesService } from "../domains/output-shares/mod.ts";
import type { OutputSnapshot } from "takosumi-contract/output-snapshots";
import type { Space } from "takosumi-contract/spaces";

test("deploy_control_internal_routes — public /api endpoints respond with 501 when controller is absent",
  async () => {
    const app = await createApiApp({
      registerDeployControlPublicRoutes: true,
      deployControlPublicRouteOptions: {
      mountInternalLedgerRoutes: true,
        getDeployControlToken: () => "deploy-control-token",
      },
      requestCorrelation: false,
    });

    const endpoints = [
      ["GET", "/api/spaces", undefined],
      ["POST", "/api/spaces", {}],
      ["GET", "/api/sources", undefined],
      ["POST", "/api/sources", {}],
      ["GET", "/api/installations/ins_abcdef12", undefined],
      ["POST", "/api/installations/ins_abcdef12/plan", {}],
      ["GET", "/api/runs/plan_abcdef12", undefined],
      ["POST", "/api/runs/plan_abcdef12/approve", {}],
      ["GET", "/api/spaces/space_abcdef12/billing", undefined],
      ["GET", "/api/spaces/space_abcdef12/usage", undefined],
      ["POST", "/api/spaces/space_abcdef12/credits/top-up", { credits: 1 }],
      [
        "POST",
        "/api/spaces/space_abcdef12/subscription/change",
        { billingSettings: { mode: "disabled", provider: "none" } },
      ],
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

test("deploy_control_internal_routes — disabled without TAKOSUMI_DEPLOY_CONTROL_TOKEN",
  async () => {
    const app = await createApiApp({
      registerDeployControlPublicRoutes: true,
      requestCorrelation: false,
    });

    const response = await app.request("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toEqual(404);
    expect((await response.json()).error.code).toEqual("not_found");
  },
);

test("deploy_control_internal_routes — rejects invalid bearer", async () => {
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      mountInternalLedgerRoutes: true,
      getDeployControlToken: () => "deploy-control-token",
    },
    requestCorrelation: false,
  });

  const response = await app.request("/api/spaces", {
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

test("deploy_control_internal_routes — scoped bearer enforces space and records actor", async () => {
  // Installation-first model (spec §5): a raw POST /v1/plan-runs targets an
  // existing Installation. Seed one in the allowed space so the controller has a
  // valid plan target; the denied case is rejected by the route's space-scope
  // check before the controller is reached.
  const store = new InMemoryOpenTofuDeploymentStore();
  const { installation } = await seedInstallationModel(store, {
    spaceId: "space_allowed",
    installationId: "inst_allowed1",
  });
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
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
      installationId: installation.id,
      operation: "create",
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
      installationId: installation.id,
      // The principal is scoped to `create`; pass it explicitly so the route's
      // permission check matches (installationId would otherwise default to
      // `update`).
      operation: "create",
      source: { kind: "git", url: "https://github.com/example/app.git" },
      runnerProfileId: "cloudflare-default",
    }),
  });
  expect(allowed.status).toEqual(201);
  const payload = await allowed.json();
  expect(payload.planRun.auditEvents[0].actor).toEqual("acct_123");
});

test("retired provider env set compatibility routes are not mounted", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
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
    "/api/retired-provider-env-set-compat/cpp_foreign0001/verify",
    {
      method: "POST",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(response.status).toBe(404);
});

test("deploy_control_internal_routes — scoped bearer defaults to deny when scopes are omitted", async () => {
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
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

test("deploy_control_internal_routes — runner profile list is scoped", async () => {
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
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

// --- OutputShares scoped-principal permission tests (§18) ---------------------

const SHARE_TS = "2026-06-06T00:00:00.000Z";

/**
 * Wires the public routes over a store seeded with a producer Installation in
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
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
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
            runnerProfileIds: ["cloudflare-default"],
          }
          : undefined,
    },
    requestCorrelation: false,
  });
  return app;
}

test("output-shares create — scoped bearer allowed on its fromSpace (§18)", async () => {
  const app = await outputShareApp();
  const res = await app.request("/api/output-shares", {
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
  const res = await app.request("/api/output-shares", {
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
  const res = await app.request("/api/output-shares?spaceId=space_denied01", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(res.status).toEqual(403);
});
