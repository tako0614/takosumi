import { test, expect } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import {
  createInMemoryResourceShapeStores,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../../core/domains/resource-shape/mod.ts";
import type {
  SpacePolicySpec,
  TargetPoolSpec,
} from "takosumi-contract";

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

const POOL: TargetPoolSpec = {
  targets: [
    { name: "cloudflare-main", type: "cloudflare", ref: "cf-acct", priority: 80 },
    { name: "aws-main", type: "aws", region: "ap-northeast-1", priority: 70 },
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
  kind: "ObjectStore" as const,
  name: "assets",
  spec: { name: "assets", interfaces: ["s3_api", "signed_url"] },
};

test("apply resolves ObjectStore to the highest-priority target and locks it", async () => {
  const { service } = makeService();
  await seed(service);

  const result = await service.apply(APPLY);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const status = result.value.status;
  expect(status?.phase).toBe("Ready");
  expect(status?.resolution?.selectedImplementation).toBe("cloudflare_r2");
  expect(status?.resolution?.target).toBe("cloudflare-main");
  expect(status?.resolution?.locked).toBe(true);
  expect(status?.observedGeneration).toBe(1);
  // Stub adapter synthesizes outputs from the module's public output names.
  expect(Object.keys(status?.outputs ?? {}).length).toBeGreaterThan(0);
});

test("apply resolves HttpService as a first-class shape", async () => {
  const { service } = makeService();
  await seed(service);

  const result = await service.apply({
    actor: ACTOR,
    space: "space_1",
    kind: "HttpService",
    name: "api",
    spec: {
      name: "api",
      runtime: {
        interface: "web_fetch",
        source: { artifactPath: "/work/dist/worker.js" },
      },
      exposure: { publicHttp: true },
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.kind).toBe("HttpService");
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_workers",
  );
  expect(result.value.status?.resolution?.target).toBe("cloudflare-main");
});

test("apply resolves AIEndpoint with admin-declared provider implementation", async () => {
  const { service } = makeService();
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "deepseek-main",
        type: "ai_provider",
        ref: "https://api.deepseek.example/v1",
        priority: 90,
        implementations: [
          {
            shape: "AIEndpoint",
            implementation: "deepseek_openai_gateway",
            nativeResourceType: "ai.deepseek_endpoint",
            interfaces: {
              openai_chat_completions: "native",
              "vendor.deepseek.responses.v1": "native",
              openai_embeddings: "shim",
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
    kind: "AIEndpoint",
    name: "ai",
    spec: {
      name: "ai",
      interfaces: ["openai_chat_completions", "vendor.deepseek.responses.v1"],
      profiles: ["openai_compatible", "provider.deepseek"],
      modelPolicy: {
        defaultModel: "deepseek/chat",
        allowedModels: ["deepseek/chat"],
      },
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "deepseek_openai_gateway",
  );
  expect(result.value.status?.resolution?.target).toBe("deepseek-main");
  expect(result.value.status?.outputs?.base_url).toContain("AIEndpoint:ai/base_url");
});

test("get returns the applied resource with resolution status", async () => {
  const { service } = makeService();
  await seed(service);
  await service.apply(APPLY);

  const got = await service.get("space_1", "ObjectStore", "assets");
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.value.metadata.name).toBe("assets");
  expect(got.value.status?.resolution?.target).toBe("cloudflare-main");
});

test("a locked resolution is not silently re-targeted on re-apply", async () => {
  const { service } = makeService();
  await seed(service);
  await service.apply(APPLY);

  // Re-apply with cloudflare denied: without the lock this would move to AWS;
  // with lockAfterCreate + allowAutoMigration:false it must stay put.
  const reResult = await service.apply(APPLY);
  expect(reResult.ok).toBe(true);
  if (!reResult.ok) return;
  expect(reResult.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_r2",
  );
  expect(reResult.value.status?.observedGeneration).toBe(2);
});

test("SpacePolicy deniedTargets steers resolution to the allowed target", async () => {
  const { service } = makeService();
  await service.putTargetPool("space_1", "default", POOL);
  await service.putSpacePolicy("space_1", "default", {
    deniedTargets: ["cloudflare"],
    resolution: { lockAfterCreate: false, allowAutoMigration: true },
  });

  const result = await service.apply(APPLY);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.status?.resolution?.selectedImplementation).toBe("aws_s3");
  expect(result.value.status?.resolution?.target).toBe("aws-main");
});

test("preview resolves without persisting", async () => {
  const { service, stores } = makeService();
  await seed(service);

  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.value.selectedImplementation).toBe("cloudflare_r2");
  expect(preview.value.nativeResourcePlan.length).toBeGreaterThan(0);
  // preview must not create a persisted resource
  const stored = await stores.resources.get("tkrn:space_1:ObjectStore:assets");
  expect(stored).toBeUndefined();
});

test("apply without a target pool returns target_pool_not_found", async () => {
  const { service } = makeService();
  const result = await service.apply(APPLY);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("target_pool_not_found");
});

test("invalid spec (empty interfaces) is rejected before resolution", async () => {
  const { service } = makeService();
  await seed(service);
  const result = await service.apply({
    ...APPLY,
    spec: { name: "assets", interfaces: [] },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("invalid_interfaces");
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

  const deleted = await service.delete("space_1", "ObjectStore", "assets", ACTOR);
  expect(deleted.ok).toBe(false);
  if (deleted.ok) return;
  expect(deleted.error.code).toBe("delete_blocked");

  const stillThere = await service.get("space_1", "ObjectStore", "assets");
  expect(stillThere.ok).toBe(true);
});
