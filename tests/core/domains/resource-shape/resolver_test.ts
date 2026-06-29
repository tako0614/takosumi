import { test, expect } from "bun:test";

import {
  TAKOSUMI_API_VERSION,
  type ResolutionLock,
  type ResolverInput,
  type ResourceObject,
  type SpacePolicy,
  type TargetPoolImplementation,
  type TargetPool,
  type TargetPoolEntry,
} from "takosumi-contract";
import {
  DEFAULT_RESOURCE_SHAPE_CAPABILITIES,
  OBJECT_BUCKET_TARGET_IMPLEMENTATION,
  SHAPE_INTERFACE_REQUIREMENTS,
  resolve,
} from "../../../../core/domains/resource-shape/resolver.ts";

// --- fixtures ----------------------------------------------------------------

function objectBucketResource(
  name = "assets",
  interfaces: readonly string[] = ["s3_api", "signed_url"],
): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "ObjectBucket",
    metadata: { name, space: "prod", managedBy: "api" },
    spec: { name, interfaces: [...interfaces] },
  };
}

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

function aiEndpointResource(name = "ai"): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "AIEndpoint",
    metadata: { name, space: "prod", managedBy: "api" },
    spec: {
      name,
      interfaces: ["openai_chat_completions", "openai_embeddings"],
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

const cloudflareObjectBucketImplementation: TargetPoolImplementation = {
  shape: "ObjectBucket",
  implementation: "cloudflare_r2",
  nativeResourceType: "cloudflare.r2_bucket",
  interfaces: {
    s3_api: "native",
    signed_url: "native",
    object_events: "shim",
  },
};

const awsObjectBucketImplementation: TargetPoolImplementation = {
  shape: "ObjectBucket",
  implementation: "aws_s3",
  nativeResourceType: "aws.s3_bucket",
  interfaces: {
    s3_api: "native",
    signed_url: "native",
    object_events: "native",
  },
};

const minioObjectBucketImplementation: TargetPoolImplementation = {
  shape: "ObjectBucket",
  implementation: "minio",
  nativeResourceType: "minio.s3_bucket",
  interfaces: {
    s3_api: "native",
    signed_url: "native",
    object_events: "emulated",
  },
};

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
    resource: objectBucketResource(),
    interfaces: ["s3_api", "signed_url"],
    targetPool: targetPool([
      {
        name: "cf-main",
        type: "cloudflare",
        ref: "acct-cf",
        priority: 10,
        implementations: [cloudflareObjectBucketImplementation],
      },
      {
        name: "aws-main",
        type: "aws",
        region: "us-east-1",
        priority: 5,
        implementations: [awsObjectBucketImplementation],
      },
    ]),
    ...over,
  };
}

function expectOk(outcome: ReturnType<typeof resolve>) {
  if (!outcome.ok)
    throw new Error(`expected ok, got error: ${outcome.error.code}`);
  return outcome.output;
}

// --- mapping / table sanity --------------------------------------------------

test("ObjectBucket has no implicit target-type implementation mapping", () => {
  expect(OBJECT_BUCKET_TARGET_IMPLEMENTATION.cloudflare).toBeUndefined();
  expect(OBJECT_BUCKET_TARGET_IMPLEMENTATION.aws).toBeUndefined();
  expect(OBJECT_BUCKET_TARGET_IMPLEMENTATION.takosumi_native).toBeUndefined();
  expect(OBJECT_BUCKET_TARGET_IMPLEMENTATION.kubernetes).toBeUndefined();
});

test("ObjectBucket requires s3_api", () => {
  expect(SHAPE_INTERFACE_REQUIREMENTS.ObjectBucket?.required).toContain(
    "s3_api",
  );
});

test("AIEndpoint uses requested capability tokens instead of a fixed OpenAI-chat requirement", () => {
  expect(SHAPE_INTERFACE_REQUIREMENTS.AIEndpoint?.required).toEqual([]);
  expect(SHAPE_INTERFACE_REQUIREMENTS.AIEndpoint?.preferred).toContain(
    "openai_chat_completions",
  );
});

// --- selection ---------------------------------------------------------------

test("resolve picks the highest-priority eligible target with explicit implementation evidence", () => {
  const out = expectOk(resolve(input()));
  expect(out.selectedTarget).toBe("cf-main");
  expect(out.selectedImplementation).toBe("cloudflare_r2");
});

test("plain cloud targets do not become ObjectBucket unless the operator opts in", () => {
  const outcome = resolve(
    input({
      targetPool: targetPool([
        { name: "cf-main", type: "cloudflare", ref: "acct-cf", priority: 10 },
        { name: "aws-main", type: "aws", region: "us-east-1", priority: 5 },
      ]),
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("no_eligible_target");
});

test("resolve tie-breaks equal priority by name ascending", () => {
  const out = expectOk(
    resolve(
      input({
        targetPool: targetPool([
          {
            name: "zeta",
            type: "aws",
            region: "us-east-1",
            priority: 7,
            implementations: [awsObjectBucketImplementation],
          },
          {
            name: "alpha",
            type: "aws",
            region: "us-east-1",
            priority: 7,
            implementations: [awsObjectBucketImplementation],
          },
        ]),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("alpha");
});

test("denied target (by name) is excluded", () => {
  const out = expectOk(
    resolve(
      input({ spacePolicy: spacePolicy({ deniedTargets: ["cf-main"] }) }),
    ),
  );
  expect(out.selectedTarget).toBe("aws-main");
});

test("denied target (by type) is excluded", () => {
  const out = expectOk(
    resolve(
      input({ spacePolicy: spacePolicy({ deniedTargets: ["cloudflare"] }) }),
    ),
  );
  expect(out.selectedTarget).toBe("aws-main");
});

test("allowedTargets keeps only allowed entries (matched by type or name)", () => {
  const out = expectOk(
    resolve(input({ spacePolicy: spacePolicy({ allowedTargets: ["aws"] }) })),
  );
  expect(out.selectedTarget).toBe("aws-main");
});

test("a target whose implementation lacks required s3_api is excluded", () => {
  const out = expectOk(
    resolve(
      input({
        targetPool: targetPool([
          {
            name: "cf-main",
            type: "cloudflare",
            ref: "acct-cf",
            priority: 10,
            implementations: [
              {
                ...cloudflareObjectBucketImplementation,
                interfaces: { s3_api: "unsupported", signed_url: "native" },
              },
            ],
          },
          {
            name: "aws-main",
            type: "aws",
            region: "us-east-1",
            priority: 5,
            implementations: [awsObjectBucketImplementation],
          },
        ]),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("aws-main");
  expect(out.selectedImplementation).toBe("aws_s3");
});

test("a target whose implementation lacks a requested interface is excluded", () => {
  const outcome = resolve(
    input({
      targetPool: targetPool([
        {
          name: "cf-main",
          type: "cloudflare",
          ref: "acct-cf",
          priority: 10,
          implementations: [
            {
              ...cloudflareObjectBucketImplementation,
              interfaces: { s3_api: "native", signed_url: "unsupported" },
            },
          ],
        },
      ]),
      interfaces: ["s3_api", "signed_url"],
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("no_eligible_target");
});

test("no eligible target returns a no_eligible_target error", () => {
  const outcome = resolve(
    input({
      targetPool: targetPool([
        // gcp has no ObjectBucket implementation mapping in Phase 2.
        { name: "gcp-main", type: "gcp", priority: 9 },
      ]),
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("no_eligible_target");
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

test("resolve maps AIEndpoint to an operator-selected AI target", () => {
  const out = expectOk(
    resolve(
      input({
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
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("openai_compatible_ai_endpoint");
  expect(out.selectedTarget).toBe("deepseek-main");
  expect(out.nativeResourcePlan).toEqual([
    { type: "ai.openai_compatible_endpoint", id: "ai" },
  ]);
});

test("resolve can select an embeddings-only AIEndpoint", () => {
  const out = expectOk(
    resolve(
      input({
        resource: aiEndpointResource(),
        interfaces: ["openai_embeddings"],
        targetPool: targetPool([
          {
            name: "embeddings-main",
            type: "ai_provider",
            ref: "https://provider.example/v1",
            priority: 20,
            implementations: [
              {
                shape: "AIEndpoint",
                implementation: "embedding_only_gateway",
                nativeResourceType: "ai.embedding_endpoint",
                interfaces: {
                  openai_embeddings: "native",
                },
              },
            ],
          },
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("embedding_only_gateway");
  expect(out.selectedTarget).toBe("embeddings-main");
  expect(out.capabilityScores).toEqual([
    { interface: "openai_embeddings", level: "native" },
  ]);
});

test("resolve uses admin-declared AI provider implementations from TargetPool", () => {
  const out = expectOk(
    resolve(
      input({
        resource: aiEndpointResource(),
        interfaces: ["openai_chat_completions", "vendor.deepseek.responses.v1"],
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
          { name: "cf-ai", type: "cloudflare", ref: "cf-acct", priority: 10 },
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
        resource: aiEndpointResource(),
        interfaces: ["openai_chat_completions"],
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

// --- native plan / lock fields ----------------------------------------------

test("cloudflare_r2 plans a cloudflare.r2_bucket native resource", () => {
  const out = expectOk(resolve(input()));
  expect(out.nativeResourcePlan).toEqual([
    { type: "cloudflare.r2_bucket", id: "assets" },
  ]);
});

test("aws_s3 plans an aws.s3_bucket native resource", () => {
  const out = expectOk(
    resolve(input({ spacePolicy: spacePolicy({ allowedTargets: ["aws"] }) })),
  );
  expect(out.nativeResourcePlan).toEqual([
    { type: "aws.s3_bucket", id: "assets" },
  ]);
});

test("resolutionLock carries resourceId and does NOT stamp lockedAt", () => {
  const out = expectOk(
    resolve(
      input({
        spacePolicy: spacePolicy({ resolution: { lockAfterCreate: true } }),
      }),
    ),
  );
  expect(out.resolutionLock.resourceId).toBe("tkrn:prod:ObjectBucket:assets");
  expect(out.resolutionLock.locked).toBe(true);
  expect(out.resolutionLock.lockedAt).toBeUndefined();
  expect(out.resolutionLock.reason.length).toBeGreaterThan(0);
});

test("locked defaults to false when policy does not lock after create", () => {
  const out = expectOk(resolve(input()));
  expect(out.resolutionLock.locked).toBe(false);
});

// --- portability -------------------------------------------------------------

test("portability is portable when every interface is native", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["s3_api", "signed_url", "object_events"],
        spacePolicy: spacePolicy({ allowedTargets: ["aws"] }),
      }),
    ),
  );
  expect(out.portability).toBe("portable");
});

test("portability is mostly_portable when an interface is a shim", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["s3_api", "object_events"], // object_events is shim on R2
        spacePolicy: spacePolicy({ allowedTargets: ["cloudflare"] }),
      }),
    ),
  );
  expect(out.portability).toBe("mostly_portable");
  expect(out.riskNotes.some((n) => n.includes("object_events"))).toBe(true);
});

test("portability is partial when an interface is emulated", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["s3_api", "object_events"], // object_events is emulated on minio
        targetPool: targetPool([
          {
            name: "k8s-main",
            type: "kubernetes",
            ref: "cluster-1",
            priority: 3,
            implementations: [minioObjectBucketImplementation],
          },
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("minio");
  expect(out.portability).toBe("partial");
});

// --- locked resolution (§3.5) ------------------------------------------------

function existingAwsLock(): ResolutionLock {
  return {
    resourceId: "tkrn:prod:ObjectBucket:assets",
    selectedImplementation: "aws_s3",
    target: "aws-main",
    locked: true,
    reason: ["initial resolution"],
    portability: "portable",
    nativeResources: [{ type: "aws.s3_bucket", id: "assets" }],
    lockedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("a locked resolution is returned unchanged and is NOT re-targeted", () => {
  const lock = existingAwsLock();
  const out = expectOk(
    resolve(
      input({
        existingLock: lock,
        // Fresh selection would prefer cf-main (priority 10) over aws-main.
        spacePolicy: spacePolicy({ resolution: { allowAutoMigration: false } }),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("aws-main");
  expect(out.selectedImplementation).toBe("aws_s3");
  expect(out.resolutionLock).toBe(lock); // returned verbatim, lockedAt preserved
  expect(out.resolutionLock.lockedAt).toBe("2026-01-01T00:00:00.000Z");
  // divergence recorded as a risk note, but the decision is kept.
  expect(out.riskNotes.some((n) => n.includes("cf-main"))).toBe(true);
});

test("allowAutoMigration lets the resolver re-target a locked resolution", () => {
  const out = expectOk(
    resolve(
      input({
        existingLock: existingAwsLock(),
        spacePolicy: spacePolicy({ resolution: { allowAutoMigration: true } }),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-main");
  expect(out.selectedImplementation).toBe("cloudflare_r2");
});

test("resolve is deterministic across repeated calls", () => {
  const a = JSON.stringify(resolve(input()));
  const b = JSON.stringify(resolve(input()));
  expect(a).toBe(b);
});

test("DEFAULT_RESOURCE_SHAPE_CAPABILITIES omits ObjectBucket implementations", () => {
  const impls = DEFAULT_RESOURCE_SHAPE_CAPABILITIES.filter(
    (c) => c.shape === "ObjectBucket",
  )
    .map((c) => c.implementation)
    .sort();
  expect(impls).toEqual([]);
});

test("DEFAULT_RESOURCE_SHAPE_CAPABILITIES does not advertise half-materialized shapes", () => {
  expect(
    DEFAULT_RESOURCE_SHAPE_CAPABILITIES.some((c) => c.shape === "Queue"),
  ).toBe(false);
});
