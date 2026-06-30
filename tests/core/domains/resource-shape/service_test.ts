import { test, expect } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import {
  type AdapterApplyInput,
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
  applyInputs: AdapterApplyInput[] = [];

  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    return super.apply(input);
  }
}

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

test("apply resolves PushNotification on a native target", async () => {
  const { service } = makeService();
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "native-main",
        type: "takosumi_native",
        ref: "native-prod",
        priority: 90,
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const result = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "PushNotification",
    name: "push",
    spec: {
      name: "push",
      protocols: ["web_push", "fcm"],
      delivery: { ttlSeconds: 600 },
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.kind).toBe("PushNotification");
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "takosumi_push_notification",
  );
  expect(result.value.status?.outputs?.resource_name).toContain(
    "PushNotification:push",
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

test("apply passes selected implementation plugin metadata to the adapter", async () => {
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
