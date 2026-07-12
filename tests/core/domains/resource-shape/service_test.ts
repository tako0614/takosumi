import { test, expect } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import {
  type AdapterApplyInput,
  type AdapterDeleteInput,
  type AdapterPreviewResult,
  createInMemoryResourceShapeStores,
  type AdapterApplyResult,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../../core/domains/resource-shape/mod.ts";
import type { SpacePolicySpec, TargetPoolSpec } from "takosumi-contract";

const ACTOR: ActorContext = {
  actorAccountId: "acc_1",
  roles: [],
  requestId: "req_1",
};

const NOW = "2026-01-01T00:00:00.000Z";

function makeService() {
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    now: () => NOW,
  });
  return { stores, service };
}

class PluginSpyAdapter extends StubResourceShapeAdapter {
  previewInputs: AdapterApplyInput[] = [];
  applyInputs: AdapterApplyInput[] = [];
  deleteInputs: AdapterDeleteInput[] = [];

  override async preview(
    input: AdapterApplyInput,
  ): Promise<AdapterPreviewResult> {
    this.previewInputs.push(input);
    return super.preview(input);
  }

  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    return super.apply(input);
  }

  override async delete(input: AdapterDeleteInput): Promise<void> {
    this.deleteInputs.push(input);
    return super.delete(input);
  }
}

class FailingApplyAdapter extends PluginSpyAdapter {
  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    throw new Error("simulated apply failure");
  }
}

class FailingDeleteAdapter extends PluginSpyAdapter {
  override async delete(input: AdapterDeleteInput): Promise<void> {
    this.deleteInputs.push(input);
    throw new Error("simulated delete failure");
  }
}

class SlowDeleteAdapter extends PluginSpyAdapter {
  readonly started: Promise<void>;
  #startDelete!: () => void;
  #finishDelete!: () => void;
  #finishDeletePromise: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#startDelete = resolve;
    });
    this.#finishDeletePromise = new Promise((resolve) => {
      this.#finishDelete = resolve;
    });
  }

  finishDelete(): void {
    this.#finishDelete();
  }

  override async delete(input: AdapterDeleteInput): Promise<void> {
    this.deleteInputs.push(input);
    this.#startDelete();
    await this.#finishDeletePromise;
  }
}

const POOL: TargetPoolSpec = {
  targets: [
    {
      name: "cloudflare-main",
      type: "cloudflare",
      ref: "cf-acct",
      priority: 80,
      implementations: [
        {
          shape: "EdgeWorker",
          implementation: "cloudflare_workers",
          nativeResourceType: "cloudflare_workers_script",
          interfaces: {
            worker_fetch: "native",
            workers_bindings: "native",
            resource_connection: "native",
            runtime_binding: "native",
            grant_read: "native",
            grant_write: "native",
          },
        },
      ],
    },
    {
      name: "k8s-main",
      type: "kubernetes",
      ref: "cluster-prod",
      priority: 70,
      implementations: [
        {
          shape: "ContainerService",
          implementation: "kubernetes_deployment",
          nativeResourceType: "kubernetes_deployment",
          plugin: "kubernetes-container-plugin",
          interfaces: {
            oci_container: "native",
            public_http: "shim",
            env_projection: "native",
          },
        },
      ],
    },
  ],
};

const POLICY: SpacePolicySpec = {
  resolution: { lockAfterCreate: true, allowAutoMigration: false },
};

const PROVIDER_COMPAT_BASE_URL =
  "https://app.takosumi.com/compat/cloudflare/client/v4";

async function seed(service: ResourceShapeService, policy = POLICY) {
  await service.putTargetPool("space_1", "default", POOL);
  await service.putSpacePolicy("space_1", "default", policy);
}

const APPLY = {
  actor: ACTOR,
  space: "space_1",
  kind: "ObjectBucket" as const,
  name: "assets",
  spec: {
    name: "assets",
    interfaces: ["s3_api"],
  },
};

test("apply resolves ObjectBucket to the highest-priority target and locks it", async () => {
  const { service } = makeService();
  await seed(service);

  const result = await service.apply(APPLY);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const status = result.value.status;
  expect(status?.phase).toBe("Ready");
  expect(status?.resolution?.selectedImplementation).toBe(
    "cloudflare_r2_bucket",
  );
  expect(status?.resolution?.target).toBe("cloudflare-main");
  expect(status?.resolution?.locked).toBe(true);
  expect(status?.observedGeneration).toBe(1);
  expect(status?.outputs?.bucket_name).toContain("ObjectBucket:assets");
});

test("apply resolves EdgeWorker as a first-class shape", async () => {
  const { service } = makeService();
  await seed(service);

  const result = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker",
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.kind).toBe("EdgeWorker");
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_workers",
  );
  expect(result.value.status?.resolution?.target).toBe("cloudflare-main");
});

test("EdgeWorker connections resolve Ready resources before preview and apply", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await seed(service);

  const bucket = await service.apply(APPLY);
  expect(bucket.ok).toBe(true);

  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker" as const,
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
      connections: {
        ASSETS: {
          resource: "tkrn:space_1:ObjectBucket:assets",
          permissions: ["read", "write"] as const,
          projection: "runtime_binding" as const,
        },
      },
    },
  };

  const preview = await service.preview(request);
  expect(preview.ok).toBe(true);
  const previewConnection =
    adapter.previewInputs.at(-1)?.resolvedConnections?.ASSETS;
  expect(previewConnection).toMatchObject({
    resourceId: "tkrn:space_1:ObjectBucket:assets",
    kind: "ObjectBucket",
    permissions: ["read", "write"],
    projection: "runtime_binding",
    target: "cloudflare-main",
  });
  expect(previewConnection?.nativeResources).not.toHaveLength(0);
  expect(typeof previewConnection?.outputs.bucket_name).toBe("string");

  const applied = await service.apply(request);
  expect(applied.ok).toBe(true);
  expect(adapter.applyInputs.at(-1)?.resolvedConnections?.ASSETS).toEqual(
    previewConnection,
  );
});

test("connection references fail closed when missing, cross-Space, or not Ready", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await seed(service);

  const edgeRequest = (resource: string) => ({
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker" as const,
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      connections: {
        ASSETS: {
          resource,
          permissions: ["read"] as const,
          projection: "runtime_binding" as const,
        },
      },
    },
  });

  const missing = await service.apply(
    edgeRequest("tkrn:space_1:ObjectBucket:missing"),
  );
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.code).toBe("connection_not_found");
  expect(adapter.applyInputs).toHaveLength(0);

  await service.putTargetPool("space_2", "default", POOL);
  await service.putSpacePolicy("space_2", "default", POLICY);
  const crossSpaceBucket = await service.apply({
    ...APPLY,
    space: "space_2",
  });
  expect(crossSpaceBucket.ok).toBe(true);
  const crossSpace = await service.apply(
    edgeRequest("tkrn:space_2:ObjectBucket:assets"),
  );
  expect(crossSpace.ok).toBe(false);
  if (!crossSpace.ok)
    expect(crossSpace.error.code).toBe("connection_not_found");

  await stores.resources.upsert({
    id: "tkrn:space_1:ObjectBucket:pending",
    spaceId: "space_1",
    kind: "ObjectBucket",
    name: "pending",
    managedBy: "opentofu",
    spec: { name: "pending" },
    phase: "Applying",
    generation: 1,
    observedGeneration: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const pending = await service.apply(
    edgeRequest("tkrn:space_1:ObjectBucket:pending"),
  );
  expect(pending.ok).toBe(false);
  if (!pending.ok) expect(pending.error.code).toBe("connection_not_ready");
});

test("referenced resources cannot be deleted before their consumers", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await seed(service);

  expect((await service.apply(APPLY)).ok).toBe(true);
  expect(
    (
      await service.apply({
        actor: ACTOR,
        space: "space_1",
        kind: "EdgeWorker",
        name: "api",
        spec: {
          name: "api",
          source: { artifactPath: "/work/dist/worker.js" },
          connections: {
            ASSETS: {
              resource: "tkrn:space_1:ObjectBucket:assets",
              permissions: ["read", "write"],
              projection: "runtime_binding",
            },
          },
        },
      })
    ).ok,
  ).toBe(true);

  const blocked = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) {
    expect(blocked.error.code).toBe("delete_blocked");
    expect(blocked.error.message).toContain("tkrn:space_1:EdgeWorker:api");
  }
  expect(adapter.deleteInputs).toHaveLength(0);

  expect((await service.delete("space_1", "EdgeWorker", "api", ACTOR)).ok).toBe(
    true,
  );
  expect(
    (await service.delete("space_1", "ObjectBucket", "assets", ACTOR)).ok,
  ).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(2);
});

test("Resource connections reject dependency cycles on update", async () => {
  const { service } = makeService();
  await seed(service);

  const edgeRequest = (
    name: string,
    connection?: { name: string; resource: string },
  ) => ({
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker" as const,
    name,
    spec: {
      name,
      source: { artifactPath: `/work/dist/${name}.js` },
      ...(connection
        ? {
            connections: {
              [connection.name]: {
                resource: connection.resource,
                permissions: ["read"] as const,
                projection: "runtime_binding" as const,
              },
            },
          }
        : {}),
    },
  });

  expect((await service.apply(edgeRequest("first"))).ok).toBe(true);
  expect(
    (
      await service.apply(
        edgeRequest("second", {
          name: "FIRST",
          resource: "tkrn:space_1:EdgeWorker:first",
        }),
      )
    ).ok,
  ).toBe(true);

  const cycle = await service.apply(
    edgeRequest("first", {
      name: "SECOND",
      resource: "tkrn:space_1:EdgeWorker:second",
    }),
  );
  expect(cycle.ok).toBe(false);
  if (!cycle.ok) {
    expect(cycle.error.code).toBe("invalid_connections");
    expect(cycle.error.message).toContain("dependency cycle");
  }
});

test("apply resolves Queue and SQLDatabase as concrete Cloudflare-backed shapes", async () => {
  const { service } = makeService();
  await seed(service);

  const queue = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "Queue",
    name: "delivery",
    spec: { name: "delivery", delivery: { maxRetries: 5 } },
  });
  expect(queue.ok).toBe(true);
  if (!queue.ok) return;
  expect(queue.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_queue",
  );

  const db = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "SQLDatabase",
    name: "main",
    spec: { name: "main", engine: "sqlite", migrationsPath: "migrations" },
  });
  expect(db.ok).toBe(true);
  if (!db.ok) return;
  expect(db.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_d1_database",
  );
});

test("apply resolves ContainerService with admin-declared implementation", async () => {
  const { service } = makeService();
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "custom-main",
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
  await service.putSpacePolicy("space_1", "default", POLICY);

  const result = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: {
      name: "agent",
      image: "ghcr.io/example/agent:1.0.0",
      publicHttp: true,
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "custom_container_runtime",
  );
  expect(result.value.status?.resolution?.target).toBe("custom-main");
  expect(result.value.status?.outputs?.service_name).toContain(
    "ContainerService:agent",
  );
});

test("ContainerService cannot report Ready without a materializing adapter plugin", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await seed(service);

  const result = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: { name: "agent", image: "ghcr.io/example/agent:1.0.0" },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("no_eligible_target");
    expect(result.error.message).toContain(
      "requires an installed adapter plugin",
    );
  }
  expect(adapter.applyInputs).toHaveLength(0);
  expect(
    await stores.resources.get("tkrn:space_1:ContainerService:agent"),
  ).toBe(undefined);
});

test("apply passes selected implementation plugin metadata to the adapter", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    allowedProviderBaseUrls: [PROVIDER_COMPAT_BASE_URL],
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "custom-main",
        type: "kubernetes",
        ref: "cluster-prod",
        priority: 90,
        implementations: [
          {
            shape: "ContainerService",
            implementation: "custom_container_runtime",
            nativeResourceType: "custom.container_service",
            plugin: "takosumi-container-plugin",
            options: { runtimeClass: "edge", timeoutMs: 30000 },
            interfaces: {
              oci_container: "native",
            },
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const result = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: { name: "agent", image: "ghcr.io/example/agent:1.0.0" },
  });
  expect(result.ok).toBe(true);
  expect(adapter.applyInputs).toHaveLength(1);
  expect(adapter.applyInputs[0]?.implementationPlugin).toBe(
    "takosumi-container-plugin",
  );
  expect(adapter.applyInputs[0]?.implementationOptions).toEqual({
    runtimeClass: "edge",
    timeoutMs: 30000,
  });
});

test("apply and delete pass allowlisted provider transport without a plugin", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    allowedProviderBaseUrls: [PROVIDER_COMPAT_BASE_URL],
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "cloud-managed-edge",
        type: "cloudflare",
        ref: "ts_virtual_account",
        credentialRef: "conn_takosumi_cloud_edge",
        priority: 90,
        implementations: [
          {
            shape: "EdgeWorker",
            implementation: "cloudflare_workers",
            options: { providerBaseUrl: PROVIDER_COMPAT_BASE_URL },
            interfaces: {
              worker_fetch: "native",
              workers_bindings: "native",
            },
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const created = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker",
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
    },
  });
  expect(created.ok).toBe(true);
  expect(adapter.applyInputs[0]?.implementationOptions).toEqual({
    providerBaseUrl: PROVIDER_COMPAT_BASE_URL,
  });
  expect(adapter.applyInputs[0]?.implementationPlugin).toBeUndefined();

  const deleted = await service.delete("space_1", "EdgeWorker", "api", ACTOR);
  expect(deleted.ok).toBe(true);
  expect(adapter.deleteInputs[0]?.implementationOptions).toEqual({
    providerBaseUrl: PROVIDER_COMPAT_BASE_URL,
  });
  expect(adapter.deleteInputs[0]?.implementationPlugin).toBeUndefined();
  expect(adapter.deleteInputs[0]?.credentialRef).toBe(
    "conn_takosumi_cloud_edge",
  );
});

test("apply passes TargetPool credentialRef separately from target ref", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "cloudflare-main",
        type: "cloudflare",
        ref: "cf-account-id",
        credentialRef: "conn_cf_main",
        priority: 90,
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const result = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker",
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
  });

  expect(result.ok).toBe(true);
  expect(adapter.applyInputs).toHaveLength(1);
  expect(adapter.applyInputs[0]?.target.ref).toBe("cf-account-id");
  expect(adapter.applyInputs[0]?.credentialRef).toBe("conn_cf_main");
});

test("putTargetPool rejects malformed capability evidence and secret-like options", async () => {
  const { service } = makeService();

  const empty = await service.putTargetPool("space_1", "empty", {
    targets: [],
  });
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error.code).toBe("invalid_target_pool");

  const badShape = await service.putTargetPool("space_1", "bad-shape", {
    targets: [
      {
        name: "plugin-main",
        type: "kubernetes",
        priority: 90,
        implementations: [
          {
            shape: "AIGateway",
            implementation: "custom_ai_gateway",
            interfaces: { api: "native" },
          },
        ],
      },
    ],
  } as TargetPoolSpec);
  expect(badShape.ok).toBe(false);
  if (!badShape.ok) expect(badShape.error.code).toBe("invalid_target_pool");

  const secretOptions = await service.putTargetPool("space_1", "secret", {
    targets: [
      {
        name: "plugin-main",
        type: "kubernetes",
        priority: 90,
        implementations: [
          {
            shape: "ContainerService",
            implementation: "custom_container_runtime",
            interfaces: { oci_container: "native" },
            options: { apiToken: "sk-secret-should-not-live-here" },
          },
        ],
      },
    ],
  });
  expect(secretOptions.ok).toBe(false);
  if (!secretOptions.ok)
    expect(secretOptions.error.message).toContain("secret-looking");

  const invalidProviderBaseUrl = await service.putTargetPool(
    "space_1",
    "bad-provider-base-url",
    {
      targets: [
        {
          name: "plugin-main",
          type: "cloudflare",
          priority: 90,
          implementations: [
            {
              shape: "EdgeWorker",
              implementation: "cloudflare_workers",
              plugin: "cloud-managed",
              interfaces: { worker_fetch: "native" },
              options: { providerBaseUrl: "not-a-url" },
            },
          ],
        },
      ],
    },
  );
  expect(invalidProviderBaseUrl.ok).toBe(false);
  if (!invalidProviderBaseUrl.ok) {
    expect(invalidProviderBaseUrl.error.message).toContain(
      "providerBaseUrl must be an absolute URL",
    );
  }

  const unallowedProviderBaseUrl = await service.putTargetPool(
    "space_1",
    "unallowed-provider-base-url",
    {
      targets: [
        {
          name: "plugin-main",
          type: "cloudflare",
          priority: 90,
          implementations: [
            {
              shape: "EdgeWorker",
              implementation: "cloudflare_workers",
              plugin: "cloud-managed",
              interfaces: { worker_fetch: "native" },
              options: { providerBaseUrl: PROVIDER_COMPAT_BASE_URL },
            },
          ],
        },
      ],
    },
  );
  expect(unallowedProviderBaseUrl.ok).toBe(false);
  if (!unallowedProviderBaseUrl.ok) {
    expect(unallowedProviderBaseUrl.error.message).toContain(
      "providerBaseUrl is not in the operator allowlist",
    );
  }

  const serviceWithAllowlist = new ResourceShapeService({
    stores: createInMemoryResourceShapeStores(),
    adapter: new StubResourceShapeAdapter(),
    now: () => NOW,
    allowedProviderBaseUrls: [PROVIDER_COMPAT_BASE_URL],
  });
  const allowlistedProviderBaseUrl = await serviceWithAllowlist.putTargetPool(
    "space_1",
    "allowlisted-provider-base-url",
    {
      targets: [
        {
          name: "plugin-main",
          type: "cloudflare",
          priority: 90,
          implementations: [
            {
              shape: "EdgeWorker",
              implementation: "cloudflare_workers",
              interfaces: { worker_fetch: "native" },
              options: { providerBaseUrl: PROVIDER_COMPAT_BASE_URL },
            },
          ],
        },
      ],
    },
  );
  expect(allowlistedProviderBaseUrl.ok).toBe(true);
});

test("delete resolves native target from the non-default TargetPool that created the lock", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await service.putTargetPool("space_1", "storage", {
    targets: [
      {
        name: "native-main",
        type: "takosumi_native",
        ref: "native-prod",
        credentialRef: "conn_native",
        priority: 90,
        implementations: [
          {
            shape: "ObjectBucket",
            implementation: "takosumi_object_bucket",
            nativeResourceType: "takosumi_object_bucket",
            plugin: "native-object-store-plugin",
            interfaces: {
              object_store: "native",
              s3_api: "native",
            },
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const created = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "ObjectBucket",
    name: "assets",
    targetPoolName: "storage",
    spec: {
      name: "assets",
      interfaces: ["s3_api"],
    },
  });
  expect(created.ok).toBe(true);

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(1);
  expect(adapter.deleteInputs[0]?.target.name).toBe("native-main");
  expect(adapter.deleteInputs[0]?.credentialRef).toBe("conn_native");
  expect(adapter.deleteInputs[0]?.plan?.templateId).toBe(
    "takosumi-service-shape",
  );
  expect(adapter.deleteInputs[0]?.plan?.inputs.resourceName).toBe("assets");
  expect(adapter.deleteInputs[0]?.nativeResources).toEqual([
    { type: "takosumi_object_bucket", id: "assets" },
  ]);
});

test("delete is idempotent while adapter-backed destroy is in progress", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new SlowDeleteAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await seed(service);

  const created = await service.apply(APPLY);
  expect(created.ok).toBe(true);

  const firstDelete = service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  await adapter.started;

  const deleting = await service.get("space_1", "ObjectBucket", "assets");
  expect(deleting.ok).toBe(true);
  if (deleting.ok) expect(deleting.value.status?.phase).toBe("Deleting");

  const secondDelete = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(secondDelete.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(1);

  const updateWhileDeleting = await service.apply(APPLY);
  expect(updateWhileDeleting.ok).toBe(false);
  if (!updateWhileDeleting.ok) {
    expect(updateWhileDeleting.error.code).toBe("delete_blocked");
  }

  adapter.finishDelete();
  const completed = await firstDelete;
  expect(completed.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(1);

  const remaining = await service.get("space_1", "ObjectBucket", "assets");
  expect(remaining.ok).toBe(false);
});

test("delete timeout marks the resource failed instead of leaving it deleting forever", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new SlowDeleteAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    deleteTimeoutMs: 5,
  });
  await seed(service);

  const created = await service.apply(APPLY);
  expect(created.ok).toBe(true);

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(false);
  if (!deleted.ok) {
    expect(deleted.error.code).toBe("delete_failed");
    expect(deleted.error.message).toContain("did not complete within 5ms");
  }

  const failed = await service.get("space_1", "ObjectBucket", "assets");
  expect(failed.ok).toBe(true);
  if (failed.ok) {
    expect(failed.value.status?.phase).toBe("Failed");
    expect(failed.value.status?.conditions[0]?.type).toBe("Ready");
    expect(failed.value.status?.conditions[0]?.reason).toBe("DeleteFailed");
  }
  expect(adapter.deleteInputs).toHaveLength(1);

  adapter.finishDelete();
});

test("force delete tombstones a failed resource without re-entering the adapter", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new FailingDeleteAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await seed(service);

  const created = await service.apply(APPLY);
  expect(created.ok).toBe(true);

  const firstDelete = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(firstDelete.ok).toBe(false);
  if (!firstDelete.ok) {
    expect(firstDelete.error.code).toBe("delete_failed");
    expect(firstDelete.error.message).toContain("simulated delete failure");
  }
  expect(adapter.deleteInputs).toHaveLength(1);

  const failed = await service.get("space_1", "ObjectBucket", "assets");
  expect(failed.ok).toBe(true);
  if (failed.ok) expect(failed.value.status?.phase).toBe("Failed");

  const forced = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
    { force: true },
  );
  expect(forced.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(1);
  expect(await stores.locks.get("tkrn:space_1:ObjectBucket:assets")).toBe(
    undefined,
  );

  const remaining = await service.get("space_1", "ObjectBucket", "assets");
  expect(remaining.ok).toBe(false);
});

test("new resource apply failure rolls back the provisional lock so delete only clears the ledger", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new FailingApplyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await seed(service);

  const created = await service.apply(APPLY);
  expect(created.ok).toBe(false);

  const lock = await stores.locks.get("tkrn:space_1:ObjectBucket:assets");
  expect(lock).toBeUndefined();

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(0);

  const remaining = await service.get("space_1", "ObjectBucket", "assets");
  expect(remaining.ok).toBe(false);
});

test("get returns the applied resource with resolution status", async () => {
  const { service } = makeService();
  await seed(service);
  await service.apply(APPLY);

  const got = await service.get("space_1", "ObjectBucket", "assets");
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.value.metadata.name).toBe("assets");
  expect(got.value.status?.resolution?.target).toBe("cloudflare-main");
});

test("a locked resolution is not silently re-targeted on re-apply", async () => {
  const { service } = makeService();
  await seed(service);
  await service.apply(APPLY);

  const reResult = await service.apply(APPLY);
  expect(reResult.ok).toBe(true);
  if (!reResult.ok) return;
  expect(reResult.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_r2_bucket",
  );
  expect(reResult.value.status?.observedGeneration).toBe(2);
});

test("SpacePolicy deniedTargets steers ContainerService to the allowed target", async () => {
  const { service } = makeService();
  await service.putTargetPool("space_1", "default", POOL);
  await service.putSpacePolicy("space_1", "default", {
    deniedTargets: ["cloudflare"],
    resolution: { lockAfterCreate: false, allowAutoMigration: true },
  });

  const result = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: {
      name: "agent",
      image: "ghcr.io/example/agent:1.0.0",
      publicHttp: true,
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "kubernetes_deployment",
  );
  expect(result.value.status?.resolution?.target).toBe("k8s-main");
});

test("preview resolves without persisting", async () => {
  const { service, stores } = makeService();
  await seed(service);

  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.value.selectedImplementation).toBe("cloudflare_r2_bucket");
  expect(preview.value.nativeResourcePlan.length).toBeGreaterThan(0);
  const stored = await stores.resources.get("tkrn:space_1:ObjectBucket:assets");
  expect(stored).toBeUndefined();
});

test("apply without a target pool returns target_pool_not_found", async () => {
  const { service } = makeService();
  const result = await service.apply(APPLY);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("target_pool_not_found");
});

test("invalid spec is rejected before resolution", async () => {
  const { service } = makeService();
  await seed(service);
  const result = await service.apply({
    ...APPLY,
    spec: { name: "assets", interfaces: ["bad interface"] },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("invalid_interface");
});

test("delete respects lifecyclePolicy.delete=block", async () => {
  const { service } = makeService();
  await seed(service);
  const created = await service.apply({
    ...APPLY,
    spec: {
      name: "assets",
      interfaces: ["s3_api"],
      lifecyclePolicy: { delete: "block" },
    },
  });
  expect(created.ok).toBe(true);

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(false);
  if (deleted.ok) return;
  expect(deleted.error.code).toBe("delete_blocked");

  const stillThere = await service.get("space_1", "ObjectBucket", "assets");
  expect(stillThere.ok).toBe(true);
});
