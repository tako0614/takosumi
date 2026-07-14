import { test, expect } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";
import type { RegisterResourceShapeRoutesOptions } from "../../../core/api/resource_routes.ts";
import { createInMemoryAppContext } from "../../../core/app_context.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import {
  createInMemoryResourceShapeStores,
  MapResourceShapeModuleRegistry,
  MapResourceShapeSchemaRegistry,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../core/domains/resource-shape/mod.ts";
import { createInMemoryInterfaceStores } from "../../../core/domains/interfaces/mod.ts";
import type { AdapterDeleteInput } from "../../../core/domains/resource-shape/mod.ts";
import { ActivityService } from "../../../core/domains/activity/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import type { SpacePolicySpec, TargetPoolSpec } from "takosumi-contract";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

const ROUTE_IMPLEMENTATIONS: NonNullable<
  TargetPoolSpec["targets"][number]["implementations"]
> = [
  {
    shape: "EdgeWorker",
    implementation: "cloudflare_workers",
    nativeResourceType: "cloudflare.workers_script",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-worker-service",
    moduleInputMappings: {
      appName: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
      artifactPath: { source: "spec", path: "/source/artifactPath" },
      connections: { source: "spec", path: "/connections", default: {} },
    },
    moduleOutputs: [
      { name: "worker_name", type: "string" },
      { name: "url", type: "url" },
      { name: "connections", type: "json" },
    ],
    interfaces: {
      worker_fetch: "native",
      workers_bindings: "native",
      resource_connection: "native",
      runtime_binding: "native",
      grant_read: "native",
    },
  },
  {
    shape: "ObjectBucket",
    implementation: "cloudflare_r2_bucket",
    nativeResourceType: "cloudflare.r2_bucket",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-r2-bucket",
    moduleImportAddress: "cloudflare_r2_bucket.this",
    moduleInputMappings: {
      bucketName: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
    },
    moduleOutputs: [
      { name: "bucket_name", type: "string" },
      { name: "s3_endpoint", type: "url" },
    ],
    interfaces: {
      object_store: "native",
      s3_api: "native",
      signed_url: "native",
      object_events: "native",
    },
  },
  {
    shape: "KVStore",
    implementation: "cloudflare_kv_namespace",
    nativeResourceType: "cloudflare.kv_namespace",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-kv-store",
    moduleInputMappings: {
      namespaceTitle: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
    },
    moduleOutputs: [{ name: "namespace_id", type: "string" }],
    interfaces: { kv_store: "native", runtime_binding: "native" },
  },
  {
    shape: "Queue",
    implementation: "cloudflare_queue",
    nativeResourceType: "cloudflare.queue",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-queue",
    moduleInputMappings: {
      queueName: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
    },
    moduleOutputs: [{ name: "queue_name", type: "string" }],
    interfaces: { queue: "native", publish: "native", consume: "native" },
  },
];

const POOL: TargetPoolSpec = {
  targets: [
    {
      name: "cloudflare-main",
      type: "cloudflare",
      ref: "cf-acct",
      priority: 80,
      implementations: ROUTE_IMPLEMENTATIONS,
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

const ROUTE_MODULE_REGISTRY = new MapResourceShapeModuleRegistry({
  "cloudflare-worker-service": testOperatorModule(),
  "cloudflare-r2-bucket": testOperatorModule(),
  "cloudflare-kv-store": testOperatorModule(),
  "cloudflare-queue": testOperatorModule(),
});

function testOperatorModule() {
  return {
    files: [{ path: "main.tf", text: "terraform {}\n" }],
  };
}

async function buildApp(
  routeOptions?: Partial<RegisterResourceShapeRoutesOptions>,
) {
  const stores = createInMemoryResourceShapeStores();
  const activityStore = new InMemoryOpenTofuControlStore();
  const activity = new ActivityService({
    store: activityStore,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    activity,
    operationRuns: activityStore,
    moduleRegistry: ROUTE_MODULE_REGISTRY,
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
  return { app, service, activityStore };
}

const JSON_HEADERS = { "content-type": "application/json" };
const AUTH_HEADERS = {
  ...JSON_HEADERS,
  authorization: "Bearer resource-token",
};

type ResourceRouteApp = Awaited<ReturnType<typeof buildApp>>["app"];

async function reviewedResourceApply(
  app: ResourceRouteApp,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<Response> {
  const kind = path.split("/")[3];
  if (!kind) throw new Error(`cannot infer Resource kind from ${path}`);
  const preview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, kind: body.kind ?? kind }),
  });
  if (!preview.ok) return preview;
  const evidence = (await preview.json()) as {
    planDigest: string;
    quote?: { quoteId: string; quoteDigest: string };
  };
  return await app.request(path, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...body,
      review: {
        planDigest: evidence.planDigest,
        ...(evidence.quote
          ? {
              quoteId: evidence.quote.quoteId,
              quoteDigest: evidence.quote.quoteDigest,
            }
          : {}),
      },
    }),
  });
}

class SlowDeleteAdapter extends StubResourceShapeAdapter {
  override async delete(_input: AdapterDeleteInput): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("PUT /v1/resources/EdgeWorker/:name applies a first-class Worker shape", async () => {
  const { app } = await buildApp();
  const res = await reviewedResourceApply(app, "/v1/resources/EdgeWorker/api", {
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
    },
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

test("PUT /v1/resources preserves the caller-declared Resource manager", async () => {
  const { app } = await buildApp();
  const res = await reviewedResourceApply(app, "/v1/resources/KVStore/cache", {
    metadata: {
      space: "space_1",
      managedBy: "compatibility:cloudflare-workers",
    },
    spec: { name: "cache", consistency: "eventual" },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.metadata.managedBy).toBe("compatibility:cloudflare-workers");
});

test("PUT /v1/resources/:kind/:name requires exact preview evidence", async () => {
  const { app } = await buildApp();
  const desired = {
    kind: "EdgeWorker",
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
  };

  const missing = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(desired),
  });
  expect(missing.status).toBe(400);
  expect((await missing.json()).error.message).toContain(
    "deployment review from POST /v1/resources/preview is required",
  );

  const preview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(desired),
  });
  expect(preview.status).toBe(200);
  const evidence = (await preview.json()) as { planDigest: string };

  const changed = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...desired,
      spec: {
        ...desired.spec,
        source: { artifactPath: "/work/dist/worker-v2.js" },
      },
      review: { planDigest: evidence.planDigest },
    }),
  });
  expect(changed.status).toBe(409);
  expect((await changed.json()).error.code).toBe("deployment_plan_changed");
});

test("POST /v1/resources/:kind/:name/observe updates drift conditions through the pinned adapter", async () => {
  const { app } = await buildApp();
  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/assets",
    {
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
  );
  expect(applied.status).toBe(200);

  const observed = await app.request(
    "/v1/resources/ObjectBucket/assets/observe?space=space_1",
    { method: "POST", headers: JSON_HEADERS },
  );
  expect(observed.status).toBe(200);
  const body = await observed.json();
  expect(body.id).toBe("tkrn:space_1:ObjectBucket:assets");
  expect(body.observation.status).toBe("current");
  expect(body.status.conditions).toContainEqual(
    expect.objectContaining({
      type: "Drifted",
      status: "false",
      reason: "BackendInSync",
    }),
  );
});

test("POST /v1/resources/:kind/:name/import adopts an existing native resource with an explicit spec", async () => {
  const { app } = await buildApp();
  const imported = await app.request(
    "/v1/resources/ObjectBucket/assets/import",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        metadata: { space: "space_1" },
        nativeId: "bucket-native-123",
        spec: { name: "assets", interfaces: ["s3_api"] },
      }),
    },
  );
  expect(imported.status).toBe(200);
  const body = await imported.json();
  expect(body.id).toBe("tkrn:space_1:ObjectBucket:assets");
  expect(body.import.summary).toContain("bucket-native-123");
  expect(body.status).toMatchObject({
    phase: "Ready",
    observedGeneration: 1,
  });
  expect(body.status.conditions).toContainEqual(
    expect.objectContaining({ reason: "Imported", status: "true" }),
  );
});

test("POST /v1/resources/:kind/:name/refresh republishes Resource outputs without changing desired generation", async () => {
  const { app } = await buildApp();
  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/assets",
    {
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
  );
  expect(applied.status).toBe(200);

  const refreshed = await app.request(
    "/v1/resources/ObjectBucket/assets/refresh?space=space_1",
    { method: "POST", headers: JSON_HEADERS },
  );
  expect(refreshed.status).toBe(200);
  const body = await refreshed.json();
  expect(body.id).toBe("tkrn:space_1:ObjectBucket:assets");
  expect(body.refresh.summary).toContain("refreshed");
  expect(body.status.phase).toBe("Ready");
  expect(body.status.observedGeneration).toBe(1);
  expect(body.status.conditions).toContainEqual(
    expect.objectContaining({
      type: "Drifted",
      status: "false",
      reason: "StateRefreshed",
    }),
  );
});

test("TargetPool mutation returns 409 while a ResolutionLock references it", async () => {
  const { app } = await buildApp();
  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
  );
  expect(applied.status).toBe(200);

  const updated = await app.request("/v1/target-pools/default", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        targets: POOL.targets.map((target) => ({
          ...target,
          priority: target.priority + 1,
        })),
      },
    }),
  });
  expect(updated.status).toBe(409);
  expect((await updated.json()).error.code).toBe("target_pool_in_use");

  const deleted = await app.request("/v1/target-pools/default?space=space_1", {
    method: "DELETE",
  });
  expect(deleted.status).toBe(409);
  expect((await deleted.json()).error.code).toBe("target_pool_in_use");
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

  const response = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
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
    },
  );

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

  const authorized = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
    AUTH_HEADERS,
  );
  expect(authorized.status).toBe(200);

  const listed = await app.request("/v1/resources?space=space_1", {
    headers: { authorization: "Bearer resource-token" },
  });
  expect(listed.status).toBe(200);
  expect((await listed.json()).resources).toHaveLength(1);
});

test("Resource, TargetPool, and SpacePolicy lists use bounded opaque cursor pagination", async () => {
  const { app, service } = await buildApp();
  const resources = [
    {
      kind: "EdgeWorker",
      name: "api",
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
    {
      kind: "ObjectBucket",
      name: "assets",
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
    {
      kind: "KVStore",
      name: "cache",
      spec: { name: "cache", consistency: "eventual" },
    },
  ] as const;
  for (const resource of resources) {
    const response = await reviewedResourceApply(
      app,
      `/v1/resources/${resource.kind}/${resource.name}`,
      {
        metadata: { space: "space_1" },
        spec: resource.spec,
      },
    );
    expect(response.status).toBe(200);
  }

  const firstResources = await app.request(
    "/v1/resources?space=space_1&limit=2",
  );
  expect(firstResources.status).toBe(200);
  const firstResourcePage = (await firstResources.json()) as {
    resources: readonly { metadata: { name: string } }[];
    nextCursor?: string;
  };
  expect(firstResourcePage.resources).toHaveLength(2);
  expect(firstResourcePage.nextCursor).toBeDefined();

  const secondResources = await app.request(
    `/v1/resources?space=space_1&limit=2&cursor=${encodeURIComponent(firstResourcePage.nextCursor!)}`,
  );
  expect(secondResources.status).toBe(200);
  const secondResourcePage = (await secondResources.json()) as {
    resources: readonly { metadata: { name: string } }[];
    nextCursor?: string;
  };
  expect(secondResourcePage.resources).toHaveLength(1);
  expect(secondResourcePage.nextCursor).toBeUndefined();
  expect(
    [...firstResourcePage.resources, ...secondResourcePage.resources]
      .map((resource) => resource.metadata.name)
      .sort(),
  ).toEqual(["api", "assets", "cache"]);

  await service.putTargetPool("space_1", "secondary", POOL);
  await service.putTargetPool("space_1", "tertiary", POOL);
  const firstPools = await app.request(
    "/v1/target-pools?space=space_1&limit=2",
  );
  expect(firstPools.status).toBe(200);
  const firstPoolPage = (await firstPools.json()) as {
    targetPools: readonly { name: string }[];
    nextCursor?: string;
  };
  expect(firstPoolPage.targetPools).toHaveLength(2);
  expect(firstPoolPage.nextCursor).toBeDefined();
  const secondPools = await app.request(
    `/v1/target-pools?space=space_1&limit=2&cursor=${encodeURIComponent(firstPoolPage.nextCursor!)}`,
  );
  const secondPoolPage = (await secondPools.json()) as {
    targetPools: readonly { name: string }[];
    nextCursor?: string;
  };
  expect(secondPoolPage.targetPools).toHaveLength(1);
  expect(secondPoolPage.nextCursor).toBeUndefined();

  await service.putSpacePolicy("space_1", "secondary", POLICY);
  await service.putSpacePolicy("space_1", "strict", POLICY);
  const firstPolicies = await app.request(
    "/v1/space-policies?space=space_1&limit=2",
  );
  expect(firstPolicies.status).toBe(200);
  const firstPolicyPage = (await firstPolicies.json()) as {
    spacePolicies: readonly { name: string }[];
    nextCursor?: string;
  };
  expect(firstPolicyPage.spacePolicies).toHaveLength(2);
  expect(firstPolicyPage.nextCursor).toBeDefined();
  const secondPolicies = await app.request(
    `/v1/space-policies?space=space_1&limit=2&cursor=${encodeURIComponent(firstPolicyPage.nextCursor!)}`,
  );
  const secondPolicyPage = (await secondPolicies.json()) as {
    spacePolicies: readonly { name: string }[];
    nextCursor?: string;
  };
  expect(secondPolicyPage.spacePolicies).toHaveLength(1);
  expect(secondPolicyPage.nextCursor).toBeUndefined();

  for (const path of [
    "/v1/resources?space=space_1&limit=0",
    "/v1/resources?space=space_1&cursor=not-a-cursor",
    "/v1/target-pools?space=space_1&limit=NaN",
    "/v1/space-policies?space=space_1&cursor=not-a-cursor",
  ]) {
    const rejected = await app.request(path);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("invalid_argument");
  }
});

test("SpacePolicy API supports scoped create, read, list, and idempotent delete", async () => {
  const { app } = await buildApp();
  const put = await app.request("/v1/space-policies/strict", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        deniedTargets: ["public"],
        approvals: { requireForApply: true, requireForDestroy: true },
      },
    }),
  });
  expect(put.status).toBe(200);

  const get = await app.request("/v1/space-policies/strict?space=space_1");
  expect(get.status).toBe(200);
  expect((await get.json()).spec.deniedTargets).toEqual(["public"]);

  const listed = await app.request("/v1/space-policies?space=space_1");
  expect(listed.status).toBe(200);
  expect(
    ((await listed.json()).spacePolicies as readonly { name: string }[]).map(
      (policy) => policy.name,
    ),
  ).toContain("strict");

  expect(
    (
      await app.request("/v1/space-policies/strict?space=space_1", {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await app.request("/v1/space-policies/strict?space=space_1", {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect(
    (await app.request("/v1/space-policies/strict?space=space_1")).status,
  ).toBe(404);
});

test("Resource events are target-scoped, cursor-paged, and remain readable after deletion", async () => {
  const { app } = await buildApp();
  for (const resource of [
    {
      kind: "ObjectBucket",
      name: "assets",
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
    {
      kind: "KVStore",
      name: "cache",
      spec: { name: "cache", consistency: "eventual" },
    },
  ] as const) {
    const applied = await reviewedResourceApply(
      app,
      `/v1/resources/${resource.kind}/${resource.name}`,
      {
        metadata: { space: "space_1" },
        spec: resource.spec,
      },
    );
    expect(applied.status).toBe(200);
  }

  const observed = await app.request(
    "/v1/resources/ObjectBucket/assets/observe?space=space_1",
    { method: "POST", headers: JSON_HEADERS },
  );
  expect(observed.status).toBe(200);
  const refreshed = await app.request(
    "/v1/resources/ObjectBucket/assets/refresh?space=space_1",
    { method: "POST", headers: JSON_HEADERS },
  );
  expect(refreshed.status).toBe(200);

  type EventPage = {
    events: Array<{
      id: string;
      space: string;
      resourceId: string;
      action: string;
      metadata: Record<string, unknown>;
      createdAt: string;
    }>;
    nextCursor?: string;
  };
  const allEvents: EventPage["events"] = [];
  let cursor: string | undefined;
  for (;;) {
    const pageResponse = await app.request(
      `/v1/resources/ObjectBucket/assets/events?space=space_1&limit=2${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    expect(pageResponse.status).toBe(200);
    const page = (await pageResponse.json()) as EventPage;
    expect(page.events.length).toBeLessThanOrEqual(2);
    allEvents.push(...page.events);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  expect(allEvents.map((event) => event.action)).toEqual([
    "resource.refresh.succeeded",
    "resource.refresh.started",
    "resource.observe.succeeded",
    "resource.observe.started",
    "resource.apply.succeeded",
    "resource.apply.started",
  ]);
  expect(new Set(allEvents.map((event) => event.id)).size).toBe(
    allEvents.length,
  );
  expect(
    allEvents.every(
      (event) =>
        event.space === "space_1" &&
        event.resourceId === "tkrn:space_1:ObjectBucket:assets",
    ),
  ).toBe(true);
  expect(JSON.stringify(allEvents)).not.toContain("tkrn:space_1:KVStore:cache");
  expect(JSON.stringify(allEvents)).not.toContain("stub://");

  const deleted = await app.request(
    "/v1/resources/ObjectBucket/assets?space=space_1",
    { method: "DELETE", headers: JSON_HEADERS },
  );
  expect(deleted.status).toBe(204);
  const afterDelete = await app.request(
    "/v1/resources/ObjectBucket/assets/events?space=space_1&limit=2",
  );
  expect(afterDelete.status).toBe(200);
  expect(
    ((await afterDelete.json()) as EventPage).events.map(
      (event) => event.action,
    ),
  ).toEqual(["resource.delete.succeeded", "resource.delete.started"]);

  for (const path of [
    "/v1/resources/ObjectBucket/assets/events?space=space_1&limit=0",
    "/v1/resources/ObjectBucket/assets/events?space=space_1&cursor=bad",
  ]) {
    const rejected = await app.request(path);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("invalid_argument");
  }
});

test("Resource Shape routes reject shape kinds outside the host allowlist", async () => {
  const { app } = await buildApp({
    enabledResourceShapeKinds: ["EdgeWorker"],
  });

  const accepted = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
  );
  expect(accepted.status).toBe(200);

  const rejectedPath = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/assets",
    {
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
  );
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

test("registered operator shape tokens traverse the API, resolver, and plugin plan", async () => {
  const schemas = new MapResourceShapeSchemaRegistry({
    CacheCluster: (raw) => {
      const candidate = raw as Record<string, unknown>;
      if (typeof candidate?.name !== "string") {
        return {
          ok: false as const,
          error: { code: "invalid_name", message: "name is required" },
        };
      }
      return {
        ok: true as const,
        value: {
          spec: {
            name: candidate.name,
            replicas:
              typeof candidate.replicas === "number" ? candidate.replicas : 1,
          },
          interfaces: ["cache.protocol.v1"],
        },
      };
    },
  });
  const stores = createInMemoryResourceShapeStores();
  const operationRuns = new InMemoryOpenTofuControlStore();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    operationRuns,
    activity: new ActivityService({
      store: operationRuns,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }),
    schemaRegistry: schemas,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "operator-cache",
        type: "operator.example/cache",
        priority: 100,
        implementations: [
          {
            shape: "CacheCluster",
            implementation: "operator.cache.v1",
            plugin: "operator-cache-plugin",
            nativeResourceType: "operator.cache_cluster",
            interfaces: { "cache.protocol.v1": "native" },
            moduleOutputs: [{ name: "endpoint", type: "url" }],
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    resourceShapeRouteOptions: {
      service,
      enabledResourceShapeKinds: schemas.kinds(),
    },
    requestCorrelation: false,
  });

  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/CacheCluster/sessions",
    {
      metadata: { space: "space_1" },
      spec: { name: "sessions", replicas: 3 },
    },
  );
  expect(applied.status).toBe(200);
  expect((await applied.json()).kind).toBe("CacheCluster");

  const capabilities = await app.request("/v1/capabilities");
  expect(capabilities.status).toBe(200);
  const body = await capabilities.json();
  expect(body.resources.CacheCluster).toBe(true);
  expect(body.resources.EdgeWorker).toBe(false);
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
    }),
  ).rejects.toThrow(
    "production runtime exposes the Resource Shape API but no TAKOSUMI_DEPLOY_CONTROL_TOKEN or scoped Resource Shape actor resolver is configured",
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
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
    resourceShapeDeleteTimeoutMs: 100,
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

  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
  );
  expect(applied.status).toBe(200);

  const deleted = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1",
    {
      method: "DELETE",
    },
  );
  expect(deleted.status).toBe(204);
});

test("bootstrap projects Resource apply and delete lifecycle into Interfaces", async () => {
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    resourceShapeAdapter: new StubResourceShapeAdapter(),
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
    resolveResourceInterfaceWorkspace: async ({
      resourceSpaceId,
      resourceId: id,
    }) =>
      resourceSpaceId === "space_1" && id === "tkrn:space_1:ObjectBucket:assets"
        ? "workspace_1"
        : undefined,
  });
  const resourceId = "tkrn:space_1:ObjectBucket:assets";
  expect(
    (
      await app.request("/v1/target-pools/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POOL }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/v1/space-policies/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POLICY }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await reviewedResourceApply(app, "/v1/resources/ObjectBucket/assets", {
        metadata: { space: "space_1" },
        spec: { name: "assets", interfaces: ["s3_api"] },
      })
    ).status,
  ).toBe(200);

  const iface = await operations.interfaces.create({
    workspaceId: "workspace_1",
    name: "assets-runtime",
    ownerRef: { kind: "Resource", id: resourceId },
    spec: {
      type: "storage.object",
      version: "v1",
      document: { protocol: "https" },
      inputs: {
        bucketName: {
          source: "resource_output",
          resourceId,
          outputName: "bucket_name",
        },
      },
      access: { visibility: "workspace" },
    },
  });
  expect(iface.status.phase).toBe("Resolved");

  const resolved = await operations.interfaces.get(iface.metadata.id);
  expect(resolved.status.phase).toBe("Resolved");
  expect(resolved.status.resolvedInputs?.bucketName).toContain(
    "ObjectBucket:assets",
  );

  expect(
    (
      await app.request("/v1/resources/ObjectBucket/assets?space=space_1", {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Retired");
});

test("runtime discovery repairs a missed Resource lifecycle observer from the durable ledger", async () => {
  const baseInterfaceStores = createInMemoryInterfaceStores();
  let rejectLifecycleWrites = false;
  const interfaceStores = {
    persistence: baseInterfaceStores.persistence,
    interfaces: {
      create: (
        record: Parameters<typeof baseInterfaceStores.interfaces.create>[0],
      ) => baseInterfaceStores.interfaces.create(record),
      get: (id: string) => baseInterfaceStores.interfaces.get(id),
      getByName: (
        input: Parameters<typeof baseInterfaceStores.interfaces.getByName>[0],
      ) => baseInterfaceStores.interfaces.getByName(input),
      list: (
        filter: Parameters<typeof baseInterfaceStores.interfaces.list>[0],
      ) => baseInterfaceStores.interfaces.list(filter),
      compareAndSet: (
        record: Parameters<
          typeof baseInterfaceStores.interfaces.compareAndSet
        >[0],
        expected: Parameters<
          typeof baseInterfaceStores.interfaces.compareAndSet
        >[1],
      ) => {
        if (rejectLifecycleWrites) {
          throw new Error("simulated Interface lifecycle persistence outage");
        }
        return baseInterfaceStores.interfaces.compareAndSet(record, expected);
      },
    },
    bindings: baseInterfaceStores.bindings,
  };
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    resourceShapeAdapter: new StubResourceShapeAdapter(),
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
    interfaceStores,
    resolveResourceInterfaceWorkspace: async ({ resourceSpaceId }) =>
      resourceSpaceId === "space_1" ? "workspace_1" : undefined,
  });
  const resourceId = "tkrn:space_1:ObjectBucket:assets";
  expect(
    (
      await app.request("/v1/target-pools/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POOL }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/v1/space-policies/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POLICY }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await reviewedResourceApply(app, "/v1/resources/ObjectBucket/assets", {
        metadata: { space: "space_1" },
        spec: { name: "assets", interfaces: ["s3_api"] },
      })
    ).status,
  ).toBe(200);

  const iface = await operations.interfaces.create({
    workspaceId: "workspace_1",
    name: "repairable-assets-runtime",
    ownerRef: { kind: "Resource", id: resourceId },
    spec: {
      type: "storage.object",
      version: "v1",
      document: { protocol: "https" },
      inputs: {
        bucketName: {
          source: "resource_output",
          resourceId,
          outputName: "bucket_name",
        },
      },
      access: { visibility: "workspace" },
    },
  });
  const binding = await operations.interfaces.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_1" },
    permissions: ["storage.read"],
    delivery: { type: "none" },
  });
  expect(binding.status.phase).toBe("Ready");

  rejectLifecycleWrites = true;
  expect(
    (
      await app.request("/v1/resources/ObjectBucket/assets?space=space_1", {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Resolved");

  rejectLifecycleWrites = false;
  expect(
    await operations.interfaces.listAuthorizedForPrincipal(
      { workspaceId: "workspace_1" },
      "principal_1",
      "storage.read",
    ),
  ).toEqual([]);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Retired");
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("Revoked");
});

test("PUT /v1/resources/ObjectBucket/:name applies a provider-neutral bucket shape", async () => {
  const { app } = await buildApp();
  const res = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/assets",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "assets",
        interfaces: ["s3_api", "signed_url"],
      },
    },
  );
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
  const res = await reviewedResourceApply(app, "/v1/resources/KVStore/cache", {
    metadata: { space: "space_1" },
    spec: {
      name: "cache",
      consistency: "eventual",
    },
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
  const res = await reviewedResourceApply(
    app,
    "/v1/resources/ContainerService/agent",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "agent",
        image: "ghcr.io/example/agent:1.0.0",
        publicHttp: true,
      },
    },
  );
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
                plugin: "custom-container-plugin",
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
                shape: "AI Gateway",
                implementation: "custom_ai_gateway",
                plugin: "custom-ai-gateway-plugin",
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
                plugin: "custom-container-plugin",
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
  await reviewedResourceApply(app, "/v1/resources/EdgeWorker/api", {
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
  });
  const res = await app.request("/v1/resources/EdgeWorker/api?space=space_1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.metadata.name).toBe("api");
  expect(body.status.resolution.target).toBe("cloudflare-main");
});

test("DELETE /v1/resources/:kind/:name rejects force delete without break-glass hook", async () => {
  const { app } = await buildApp();
  await reviewedResourceApply(app, "/v1/resources/EdgeWorker/api", {
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
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
  await reviewedResourceApply(app, "/v1/resources/EdgeWorker/api", {
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
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

test("an unregistered Resource Shape kind is not enabled", async () => {
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
  expect(body.error.message).toContain("resource kind is not enabled");

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
  expect(body.adapters.cloudflare).toBeUndefined();
  expect(body.adapters.takosumi_native).toBeUndefined();
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
