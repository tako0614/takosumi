import { test, expect } from "bun:test";

import {
  TAKOSUMI_API_VERSION,
  type ResolutionLock,
  type ResolverInput,
  type ResourceObject,
  type SpacePolicy,
  type TargetPool,
  type TargetPoolEntry,
} from "takosumi-contract";
import {
  DEFAULT_RESOURCE_SHAPE_CAPABILITIES,
  SHAPE_INTERFACE_REQUIREMENTS,
  resolve,
} from "../../../../core/domains/resource-shape/resolver.ts";

function edgeWorkerResource(name = "api"): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "EdgeWorker",
    metadata: { name, space: "prod", managedBy: "api" },
    spec: {
      name,
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
    },
  };
}

function aiEndpointResource(
  name = "ai",
  interfaces: readonly string[] = [
    "openai_chat_completions",
    "openai_embeddings",
  ],
): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "AIEndpoint",
    metadata: { name, space: "prod", managedBy: "api" },
    spec: {
      name,
      interfaces,
      profiles: ["openai_compatible"],
    },
  };
}

function targetPool(targets: readonly TargetPoolEntry[]): TargetPool {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "TargetPool",
    metadata: { name: "default", space: "prod" },
    spec: { targets: [...targets] },
  };
}

function spacePolicy(
  spec: Partial<SpacePolicy["spec"]> & {
    resolution?: Partial<SpacePolicy["spec"]["resolution"]>;
  } = {},
): SpacePolicy {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "SpacePolicy",
    metadata: { name: "prod" },
    spec: {
      ...spec,
      resolution: {
        lockAfterCreate: spec.resolution?.lockAfterCreate ?? false,
        allowAutoMigration: spec.resolution?.allowAutoMigration ?? false,
      },
    },
  };
}

function input(over: Partial<ResolverInput> = {}): ResolverInput {
  return {
    resource: aiEndpointResource(),
    interfaces: ["openai_chat_completions", "openai_embeddings"],
    targetPool: targetPool([
      {
        name: "deepseek-main",
        type: "ai_provider",
        ref: "https://api.deepseek.example/v1",
        priority: 20,
      },
      { name: "cf-ai", type: "cloudflare", ref: "cf-acct", priority: 10 },
    ]),
    ...over,
  };
}

function expectOk(outcome: ReturnType<typeof resolve>) {
  if (!outcome.ok)
    throw new Error(`expected ok, got error: ${outcome.error.code}`);
  return outcome.output;
}

test("EdgeWorker and AIEndpoint carry shape-specific interface requirements", () => {
  expect(SHAPE_INTERFACE_REQUIREMENTS.EdgeWorker?.required).toEqual([
    "worker_fetch",
  ]);
  expect(SHAPE_INTERFACE_REQUIREMENTS.AIEndpoint?.required).toEqual([]);
  expect(SHAPE_INTERFACE_REQUIREMENTS.AIEndpoint?.preferred).toContain(
    "openai_chat_completions",
  );
});

test("resolve maps EdgeWorker to cloudflare_workers on a Cloudflare target", () => {
  const out = expectOk(
    resolve(
      input({
        resource: edgeWorkerResource(),
        interfaces: ["worker_fetch", "workers_bindings"],
        targetPool: targetPool([
          { name: "cf-main", type: "cloudflare", ref: "acct-cf", priority: 10 },
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("cloudflare_workers");
  expect(out.nativeResourcePlan).toEqual([
    { type: "cloudflare.workers_script", id: "api" },
  ]);
});

test("resolve picks the highest-priority eligible AI target", () => {
  const out = expectOk(resolve(input()));
  expect(out.selectedImplementation).toBe("openai_compatible_ai_endpoint");
  expect(out.selectedTarget).toBe("deepseek-main");
  expect(out.nativeResourcePlan).toEqual([
    { type: "ai.openai_compatible_endpoint", id: "ai" },
  ]);
});

test("resolve tie-breaks equal priority by name ascending", () => {
  const out = expectOk(
    resolve(
      input({
        targetPool: targetPool([
          {
            name: "zeta",
            type: "ai_provider",
            ref: "https://z.example/v1",
            priority: 7,
          },
          {
            name: "alpha",
            type: "ai_provider",
            ref: "https://a.example/v1",
            priority: 7,
          },
        ]),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("alpha");
});

test("denied target type is excluded", () => {
  const out = expectOk(
    resolve(
      input({ spacePolicy: spacePolicy({ deniedTargets: ["ai_provider"] }) }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-ai");
  expect(out.selectedImplementation).toBe("cloudflare_ai_gateway");
});

test("allowedTargets keeps only allowed entries", () => {
  const out = expectOk(
    resolve(
      input({ spacePolicy: spacePolicy({ allowedTargets: ["cloudflare"] }) }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-ai");
});

test("a target whose implementation lacks a requested AI interface is excluded", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["openai_chat_completions", "openai_responses"],
        resource: aiEndpointResource("ai", [
          "openai_chat_completions",
          "openai_responses",
        ]),
        targetPool: targetPool([
          {
            name: "deepseek-main",
            type: "ai_provider",
            ref: "https://api.deepseek.example/v1",
            priority: 20,
            implementations: [
              {
                shape: "AIEndpoint",
                implementation: "deepseek_openai_gateway",
                nativeResourceType: "ai.deepseek_endpoint",
                interfaces: {
                  openai_chat_completions: "native",
                  openai_responses: "unsupported",
                },
              },
            ],
          },
          { name: "cf-ai", type: "cloudflare", ref: "cf-acct", priority: 10 },
        ]),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-ai");
});

test("no eligible target returns a no_eligible_target error", () => {
  const outcome = resolve(
    input({
      targetPool: targetPool([
        { name: "k8s-main", type: "kubernetes", priority: 9 },
      ]),
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("no_eligible_target");
});

test("resolve uses admin-declared AI provider implementations from TargetPool", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["openai_chat_completions", "vendor.deepseek.responses.v1"],
        resource: aiEndpointResource("ai", [
          "openai_chat_completions",
          "vendor.deepseek.responses.v1",
        ]),
        targetPool: targetPool([
          {
            name: "deepseek-main",
            type: "ai_provider",
            ref: "https://api.deepseek.example/v1",
            priority: 20,
            implementations: [
              {
                shape: "AIEndpoint",
                implementation: "deepseek_openai_gateway",
                nativeResourceType: "ai.deepseek_endpoint",
                interfaces: {
                  openai_chat_completions: "native",
                  "vendor.deepseek.responses.v1": "native",
                  openai_embeddings: "unsupported",
                },
              },
            ],
          },
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("deepseek_openai_gateway");
  expect(out.selectedTarget).toBe("deepseek-main");
  expect(out.nativeResourcePlan).toEqual([
    { type: "ai.deepseek_endpoint", id: "ai" },
  ]);
});

test("resolve preserves operator implementation plugin metadata", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["openai_chat_completions"],
        resource: aiEndpointResource("ai", ["openai_chat_completions"]),
        targetPool: targetPool([
          {
            name: "glm-main",
            type: "ai_provider",
            ref: "https://glm.example/v1",
            priority: 20,
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
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("glm_openai_gateway");
  expect(out.selectedImplementationPlugin).toBe("takosumi-ai-provider-glm");
  expect(out.selectedImplementationOptions).toEqual({
    route: "jp",
    timeoutMs: 30000,
  });
});

test("resolutionLock carries resourceId and does NOT stamp lockedAt", () => {
  const out = expectOk(
    resolve(
      input({
        spacePolicy: spacePolicy({ resolution: { lockAfterCreate: true } }),
      }),
    ),
  );
  expect(out.resolutionLock.resourceId).toBe("tkrn:prod:AIEndpoint:ai");
  expect(out.resolutionLock.locked).toBe(true);
  expect(out.resolutionLock.lockedAt).toBeUndefined();
  expect(out.resolutionLock.reason.length).toBeGreaterThan(0);
});

test("locked defaults to false when policy does not lock after create", () => {
  const out = expectOk(resolve(input()));
  expect(out.resolutionLock.locked).toBe(false);
});

test("portability is mostly_portable when an interface is a shim", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["openai_chat_completions", "openai_responses"],
        resource: aiEndpointResource("ai", [
          "openai_chat_completions",
          "openai_responses",
        ]),
        spacePolicy: spacePolicy({ allowedTargets: ["cloudflare"] }),
      }),
    ),
  );
  expect(out.portability).toBe("mostly_portable");
  expect(out.riskNotes.some((n) => n.includes("openai_responses"))).toBe(true);
});

function existingCloudflareLock(): ResolutionLock {
  return {
    resourceId: "tkrn:prod:AIEndpoint:ai",
    selectedImplementation: "cloudflare_ai_gateway",
    target: "cf-ai",
    locked: true,
    reason: ["initial resolution"],
    portability: "mostly_portable",
    nativeResources: [{ type: "cloudflare.ai_gateway", id: "ai" }],
    lockedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("a locked resolution is returned unchanged and is NOT re-targeted", () => {
  const lock = existingCloudflareLock();
  const out = expectOk(
    resolve(
      input({
        existingLock: lock,
        spacePolicy: spacePolicy({ resolution: { allowAutoMigration: false } }),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-ai");
  expect(out.selectedImplementation).toBe("cloudflare_ai_gateway");
  expect(out.resolutionLock).toBe(lock);
  expect(out.resolutionLock.lockedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(out.riskNotes.some((n) => n.includes("deepseek-main"))).toBe(true);
});

test("allowAutoMigration lets the resolver re-target a locked resolution", () => {
  const out = expectOk(
    resolve(
      input({
        existingLock: existingCloudflareLock(),
        spacePolicy: spacePolicy({ resolution: { allowAutoMigration: true } }),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("deepseek-main");
  expect(out.selectedImplementation).toBe("openai_compatible_ai_endpoint");
});

test("resolve is deterministic across repeated calls", () => {
  const a = JSON.stringify(resolve(input()));
  const b = JSON.stringify(resolve(input()));
  expect(a).toBe(b);
});

test("DEFAULT_RESOURCE_SHAPE_CAPABILITIES advertises the current public shapes", () => {
  expect(
    [...new Set(DEFAULT_RESOURCE_SHAPE_CAPABILITIES.map((c) => c.shape))].sort(),
  ).toEqual(["AIEndpoint", "EdgeWorker"]);
});
