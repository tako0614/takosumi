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
      name: "aws-main",
      type: "aws",
      region: "ap-northeast-1",
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
  kind: "AIEndpoint" as const,
  name: "ai",
  spec: {
    name: "ai",
    interfaces: ["openai_chat_completions", "openai_embeddings"],
    profiles: ["openai_compatible"],
  },
};

test("apply resolves AIEndpoint to the highest-priority target and locks it", async () => {
  const { service } = makeService();
  await seed(service);

  const result = await service.apply(APPLY);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const status = result.value.status;
  expect(status?.phase).toBe("Ready");
  expect(status?.resolution?.selectedImplementation).toBe(
    "cloudflare_ai_gateway",
  );
  expect(status?.resolution?.target).toBe("cloudflare-main");
  expect(status?.resolution?.locked).toBe(true);
  expect(status?.observedGeneration).toBe(1);
  expect(Object.keys(status?.outputs ?? {}).length).toBeGreaterThan(0);
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
      providerPreferences: ["provider.deepseek"],
      routingPolicy: {
        strategy: "lowest_latency",
        allowFallback: true,
        preferredRegions: ["jp"],
      },
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
  expect(result.value.status?.outputs?.base_url).toContain(
    "AIEndpoint:ai/base_url",
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
        name: "glm-main",
        type: "ai_provider",
        ref: "https://glm.example/v1",
        priority: 90,
        implementations: [
          {
            shape: "AIEndpoint",
            implementation: "glm_openai_gateway",
            nativeResourceType: "ai.glm_endpoint",
            plugin: "takosumi-ai-provider-glm",
            options: { route: "jp", timeoutMs: 30000 },
            interfaces: {
              openai_chat_completions: "native",
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
      interfaces: ["openai_chat_completions"],
      profiles: ["openai_compatible", "provider.glm"],
    },
  });
  expect(result.ok).toBe(true);
  expect(adapter.applyInputs).toHaveLength(1);
  expect(adapter.applyInputs[0]?.implementationPlugin).toBe(
    "takosumi-ai-provider-glm",
  );
  expect(adapter.applyInputs[0]?.implementationOptions).toEqual({
    route: "jp",
    timeoutMs: 30000,
  });
});

test("get returns the applied resource with resolution status", async () => {
  const { service } = makeService();
  await seed(service);
  await service.apply(APPLY);

  const got = await service.get("space_1", "AIEndpoint", "ai");
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.value.metadata.name).toBe("ai");
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
    "cloudflare_ai_gateway",
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
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "aws_bedrock_openai_gateway",
  );
  expect(result.value.status?.resolution?.target).toBe("aws-main");
});

test("preview resolves without persisting", async () => {
  const { service, stores } = makeService();
  await seed(service);

  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.value.selectedImplementation).toBe("cloudflare_ai_gateway");
  expect(preview.value.nativeResourcePlan.length).toBeGreaterThan(0);
  const stored = await stores.resources.get("tkrn:space_1:AIEndpoint:ai");
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
    spec: { name: "ai", interfaces: [] },
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
      name: "ai",
      interfaces: ["openai_chat_completions"],
      lifecyclePolicy: { delete: "block" },
    },
  });
  expect(created.ok).toBe(true);

  const deleted = await service.delete("space_1", "AIEndpoint", "ai", ACTOR);
  expect(deleted.ok).toBe(false);
  if (deleted.ok) return;
  expect(deleted.error.code).toBe("delete_blocked");

  const stillThere = await service.get("space_1", "AIEndpoint", "ai");
  expect(stillThere.ok).toBe(true);
});
