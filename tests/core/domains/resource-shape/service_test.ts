import { test, expect } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import {
  type AdapterApplyInput,
  type AdapterDeleteInput,
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
  deleteInputs: AdapterDeleteInput[] = [];

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
    { type: "takosumi.object_bucket", id: "assets" },
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
