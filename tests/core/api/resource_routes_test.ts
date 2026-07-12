import { test, expect } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";
import type { RegisterResourceShapeRoutesOptions } from "../../../core/api/resource_routes.ts";
import { createInMemoryAppContext } from "../../../core/app_context.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import {
  createInMemoryResourceShapeStores,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../core/domains/resource-shape/mod.ts";
import type { AdapterDeleteInput } from "../../../core/domains/resource-shape/mod.ts";
import type { SpacePolicySpec, TargetPoolSpec } from "takosumi-contract";

const POOL: TargetPoolSpec = {
  targets: [
    {
      name: "cloudflare-main",
      type: "cloudflare",
      ref: "cf-acct",
      priority: 80,
    },
    {
      name: "k8s-main",
      type: "kubernetes",
      ref: "cluster-prod",
      priority: 70,
    },
  ],
};

const POLICY: SpacePolicySpec = {
  resolution: { lockAfterCreate: true, allowAutoMigration: false },
};

async function buildApp(
  routeOptions?: Partial<RegisterResourceShapeRoutesOptions>,
) {
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  await service.putTargetPool("space_1", "default", POOL);
  await service.putSpacePolicy("space_1", "default", POLICY);
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    resourceShapeRouteOptions: { service, ...routeOptions },
    requestCorrelation: false,
  });
  return { app, service };
}

const JSON_HEADERS = { "content-type": "application/json" };
const AUTH_HEADERS = {
  ...JSON_HEADERS,
  authorization: "Bearer resource-token",
};

class SlowDeleteAdapter extends StubResourceShapeAdapter {
  override async delete(_input: AdapterDeleteInput): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("PUT /v1/resources/EdgeWorker/:name applies a first-class Worker shape", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
        profiles: ["workers_bindings"],
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:EdgeWorker:api");
  expect(body.status.resolution.selectedImplementation).toBe(
    "cloudflare_workers",
  );
  expect(body.status.resolution.target).toBe("cloudflare-main");
  expect(body.status.phase).toBe("Ready");
});

test("Resource Shape API returns 404 for an unresolved same-Space connection", async () => {
  const { app, service } = await buildApp();
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "cloudflare-main",
        type: "cloudflare",
        ref: "cf-acct",
        priority: 100,
        implementations: [
          {
            shape: "EdgeWorker",
            implementation: "cloudflare_workers",
            nativeResourceType: "cloudflare_workers_script",
            interfaces: {
              worker_fetch: "native",
              resource_connection: "native",
              runtime_binding: "native",
              grant_read: "native",
            },
          },
        ],
      },
    ],
  });

  const response = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
        connections: {
          ASSETS: {
            resource: "tkrn:space_1:ObjectBucket:missing",
            permissions: ["read"],
            projection: "runtime_binding",
          },
        },
      },
    }),
  });

  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("connection_not_found");
});

test("Resource Shape API requires bearer when a token is configured", async () => {
  const { app } = await buildApp({
    getResourceShapeBearerToken: () => "resource-token",
  });

  const unauthenticated = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(unauthenticated.status).toBe(401);

  const wrong = await app.request("/v1/resources?space=space_1", {
    headers: { authorization: "Bearer wrong-token" },
  });
  expect(wrong.status).toBe(401);

  const authorized = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(authorized.status).toBe(200);

  const listed = await app.request("/v1/resources?space=space_1", {
    headers: { authorization: "Bearer resource-token" },
  });
  expect(listed.status).toBe(200);
  expect((await listed.json()).resources).toHaveLength(1);
});

test("Resource Shape routes reject shape kinds outside the host allowlist", async () => {
  const { app } = await buildApp({
    enabledResourceShapeKinds: ["EdgeWorker"],
  });

  const accepted = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(accepted.status).toBe(200);

  const rejectedPath = await app.request("/v1/resources/ObjectBucket/assets", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    }),
  });
  expect(rejectedPath.status).toBe(400);
  expect((await rejectedPath.json()).error.message).toContain(
    "resource kind is not enabled: ObjectBucket",
  );

  const rejectedPreview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "Queue",
      metadata: { space: "space_1" },
      spec: { name: "jobs" },
    }),
  });
  expect(rejectedPreview.status).toBe(400);
  expect((await rejectedPreview.json()).error.message).toContain(
    "resource kind is not enabled: Queue",
  );
});

test("bootstrap fails closed when strict runtime exposes Resource Shape API without bearer", async () => {
  const context = createInMemoryAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: { environment: "production" },
      context,
      resourceShapeAdapter: new StubResourceShapeAdapter(),
      startWorkerDaemon: false,
    }),
  ).rejects.toThrow(
    "production runtime exposes the Resource Shape API but no TAKOSUMI_DEPLOY_CONTROL_TOKEN is configured",
  );
});

test("bootstrap wires Resource Shape API bearer from deploy-control token", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    },
    resourceShapeAdapter: new StubResourceShapeAdapter(),
    startWorkerDaemon: false,
  });

  const rejected = await app.request("/v1/resources?space=space_1");
  expect(rejected.status).toBe(401);

  const accepted = await app.request("/v1/capabilities");
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).resources.EdgeWorker).toBe(true);
});

test("bootstrap passes Resource Shape delete timeout to the service", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    resourceShapeAdapter: new SlowDeleteAdapter(),
    resourceShapeDeleteTimeoutMs: 100,
    startWorkerDaemon: false,
  });

  const pool = await app.request("/v1/target-pools/default", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ space: "space_1", spec: POOL }),
  });
  expect(pool.status).toBe(200);
  const policy = await app.request("/v1/space-policies/default", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ space: "space_1", spec: POLICY }),
  });
  expect(policy.status).toBe(200);

  const applied = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(applied.status).toBe(200);

  const deleted = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1",
    {
      method: "DELETE",
    },
  );
  expect(deleted.status).toBe(204);
});

test("PUT /v1/resources/ObjectBucket/:name applies a provider-neutral bucket shape", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/ObjectBucket/assets", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "assets",
        interfaces: ["s3_api", "signed_url"],
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:ObjectBucket:assets");
  expect(body.status.resolution.selectedImplementation).toBe(
    "cloudflare_r2_bucket",
  );
  expect(body.status.outputs.bucket_name).toContain("ObjectBucket:assets");
});

test("PUT /v1/resources/KVStore/:name applies a provider-neutral KV shape", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/KVStore/cache", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "cache",
        consistency: "eventual",
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:KVStore:cache");
  expect(body.status.resolution.selectedImplementation).toBe(
    "cloudflare_kv_namespace",
  );
  expect(body.status.outputs.namespace_id).toContain("KVStore:cache");
});

test("PUT /v1/resources/ContainerService/:name accepts admin-defined implementation capabilities", async () => {
  const { app, service } = await buildApp();
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "containers-main",
        type: "kubernetes",
        ref: "cluster-prod",
        priority: 90,
        implementations: [
          {
            shape: "ContainerService",
            implementation: "custom_container_runtime",
            nativeResourceType: "custom.container_service",
            plugin: "custom-container-plugin",
            interfaces: {
              oci_container: "native",
              public_http: "native",
            },
          },
        ],
      },
    ],
  });
  const res = await app.request("/v1/resources/ContainerService/agent", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "agent",
        image: "ghcr.io/example/agent:1.0.0",
        publicHttp: true,
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status.resolution.selectedImplementation).toBe(
    "custom_container_runtime",
  );
  expect(body.status.resolution.target).toBe("containers-main");
});

test("TargetPool API persists admin-defined capability evidence", async () => {
  const { app } = await buildApp();
  const put = await app.request("/v1/target-pools/containers", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        targets: [
          {
            name: "containers-main",
            type: "kubernetes",
            ref: "cluster-prod",
            priority: 80,
            implementations: [
              {
                shape: "ContainerService",
                implementation: "custom_container_runtime",
                nativeResourceType: "custom.container_service",
                interfaces: {
                  oci_container: "native",
                  public_http: "shim",
                  "custom.mesh": "native",
                },
              },
            ],
          },
        ],
      },
    }),
  });
  expect(put.status).toBe(200);
  const saved = await put.json();
  expect(saved.id).toBe("tkrn:space_1:TargetPool:containers");

  const get = await app.request("/v1/target-pools/containers?space=space_1");
  expect(get.status).toBe(200);
  const body = await get.json();
  expect(body.spec.targets[0].type).toBe("kubernetes");
  expect(body.spec.targets[0].implementations[0].implementation).toBe(
    "custom_container_runtime",
  );
  expect(
    body.spec.targets[0].implementations[0].interfaces["custom.mesh"],
  ).toBe("native");

  const del = await app.request("/v1/target-pools/containers?space=space_1", {
    method: "DELETE",
  });
  expect(del.status).toBe(204);
  const missing = await app.request(
    "/v1/target-pools/containers?space=space_1",
  );
  expect(missing.status).toBe(404);
});

test("TargetPool API rejects invalid capability evidence and secret-looking options", async () => {
  const { app } = await buildApp();
  const badShape = await app.request("/v1/target-pools/bad-shape", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        targets: [
          {
            name: "plugin-main",
            type: "kubernetes",
            priority: 80,
            implementations: [
              {
                shape: "AIGateway",
                implementation: "custom_ai_gateway",
                interfaces: { api: "native" },
              },
            ],
          },
        ],
      },
    }),
  });
  expect(badShape.status).toBe(400);
  expect((await badShape.json()).error.code).toBe("invalid_target_pool");

  const secretOptions = await app.request("/v1/target-pools/secret", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        targets: [
          {
            name: "plugin-main",
            type: "kubernetes",
            priority: 80,
            implementations: [
              {
                shape: "ContainerService",
                implementation: "custom_container_runtime",
                interfaces: { oci_container: "native" },
                options: { clientSecret: "plain-value" },
              },
            ],
          },
        ],
      },
    }),
  });
  expect(secretOptions.status).toBe(400);
  const body = await secretOptions.json();
  expect(body.error.code).toBe("invalid_target_pool");
  expect(body.error.message).toContain("secret-looking");
});

test("GET /v1/resources/EdgeWorker/:name returns the applied resource", async () => {
  const { app } = await buildApp();
  await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  const res = await app.request("/v1/resources/EdgeWorker/api?space=space_1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.metadata.name).toBe("api");
  expect(body.status.resolution.target).toBe("cloudflare-main");
});

test("DELETE /v1/resources/:kind/:name rejects force delete without break-glass hook", async () => {
  const { app } = await buildApp();
  await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });

  const rejected = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1&force=true",
    { method: "DELETE" },
  );
  expect(rejected.status).toBe(403);
  expect((await rejected.json()).error.message).toContain(
    "force delete requires operator break-glass authorization",
  );
});

test("DELETE /v1/resources/:kind/:name allows force delete through explicit break-glass hook", async () => {
  const { app } = await buildApp({
    authorizeResourceShapeForceDelete: ({ actor, kind, name, space }) =>
      actor.actorAccountId === "self-host" &&
      space === "space_1" &&
      kind === "EdgeWorker" &&
      name === "api",
  });
  await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });

  const accepted = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1&force=true",
    { method: "DELETE" },
  );
  expect(accepted.status).toBe(204);
  const missing = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1",
  );
  expect(missing.status).toBe(404);
});

test("POST /v1/resources/preview resolves without persisting", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "Queue",
      metadata: { space: "space_1", name: "delivery" },
      spec: {
        name: "delivery",
        delivery: { maxRetries: 5 },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.selectedImplementation).toBe("cloudflare_queue");
});

test("POST /v1/resources/preview requires an explicit shape kind", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1", name: "api" },
      spec: { name: "api" },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("PUT /v1/resources/:kind/:name rejects body kind mismatch", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "ObjectBucket",
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("PUT /v1/resources/:kind/:name rejects name mismatch", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1", name: "other" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("unknown Resource Shape kind is rejected", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/Machine/box", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "box" },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("AI Gateway is intentionally not a Resource Shape", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/AIGateway/ai", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "ai" },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.message).toContain("unknown resource kind");

  const caps = await app.request("/v1/capabilities");
  expect(caps.status).toBe(200);
  expect((await caps.json()).resources.AIGateway).toBeUndefined();
});

test("missing space yields a 400 nested error envelope", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
  expect(typeof body.error.requestId).toBe("string");
});

test("GET /v1/capabilities advertises enabled Resource Shapes", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/capabilities");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.resources.EdgeWorker).toBe(true);
  expect(body.resources.ObjectBucket).toBe(true);
  expect(body.resources.KVStore).toBe(true);
  expect(body.resources.Queue).toBe(true);
  expect(body.resources.SQLDatabase).toBe(true);
  expect(body.resources.ContainerService).toBe(true);
  expect(body.adapters.opentofu).toBe(true);
  expect(body.adapters.cloudflare).toBe(false);
  expect(body.adapters.takosumi_native).toBe(false);
  expect(Object.keys(body.resources).sort()).toEqual([
    "ContainerService",
    "EdgeWorker",
    "KVStore",
    "ObjectBucket",
    "Queue",
    "SQLDatabase",
    "Stack",
  ]);
});
