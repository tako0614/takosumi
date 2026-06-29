import { test, expect } from "bun:test";

import type { ObjectBucketSpec, TargetPoolEntry } from "takosumi-contract";
import {
  AI_ENDPOINT_GENERIC_TEMPLATE_ID,
  AI_ENDPOINT_IMPLEMENTATION_TEMPLATE,
  EDGE_WORKER_IMPLEMENTATION_TEMPLATE,
  OBJECT_BUCKET_IMPLEMENTATION_TEMPLATE,
  parseAIEndpointSpec,
  parseEdgeWorkerSpec,
  parseObjectBucketSpec,
  planAIEndpoint,
  planEdgeWorker,
  planObjectBucket,
} from "../../../../core/domains/resource-shape/planner.ts";
import { firstPartyModuleFilesByTemplateId } from "../../../../opentofu-modules/module-files.ts";

// --- parseObjectBucketSpec ----------------------------------------------------

test("parseObjectBucketSpec accepts a valid minimal spec", () => {
  const r = parseObjectBucketSpec({ name: "assets", interfaces: ["s3_api"] });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.spec.name).toBe("assets");
    expect(r.spec.interfaces).toEqual(["s3_api"]);
    expect(r.spec.lifecyclePolicy).toBeUndefined();
  }
});

test("parseObjectBucketSpec accepts a valid lifecyclePolicy", () => {
  const r = parseObjectBucketSpec({
    name: "assets",
    interfaces: ["s3_api", "signed_url"],
    lifecyclePolicy: { delete: "retain" },
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.spec.lifecyclePolicy?.delete).toBe("retain");
});

test("parseObjectBucketSpec rejects a non-object spec", () => {
  expect(parseObjectBucketSpec(null).ok).toBe(false);
  expect(parseObjectBucketSpec("nope").ok).toBe(false);
  expect(parseObjectBucketSpec([]).ok).toBe(false);
});

test("parseObjectBucketSpec rejects a missing/blank name", () => {
  const missing = parseObjectBucketSpec({ interfaces: ["s3_api"] });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.code).toBe("invalid_name");

  const blank = parseObjectBucketSpec({ name: "   ", interfaces: ["s3_api"] });
  expect(blank.ok).toBe(false);
});

test("parseObjectBucketSpec rejects empty interfaces", () => {
  const r = parseObjectBucketSpec({ name: "assets", interfaces: [] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_interfaces");
});

test("parseObjectBucketSpec rejects an unknown interface value", () => {
  const r = parseObjectBucketSpec({
    name: "assets",
    interfaces: ["s3_api", "ftp"],
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_interface");
});

test("parseObjectBucketSpec rejects an invalid delete policy", () => {
  const r = parseObjectBucketSpec({
    name: "assets",
    interfaces: ["s3_api"],
    lifecyclePolicy: { delete: "vaporize" },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_delete_policy");
});

// --- planObjectBucket ---------------------------------------------------------

const spec: ObjectBucketSpec = {
  name: "assets",
  interfaces: ["s3_api", "signed_url"],
};

test("implementation->templateId map matches the first-party catalog", () => {
  expect(OBJECT_BUCKET_IMPLEMENTATION_TEMPLATE.cloudflare_r2).toBe(
    "cloudflare-r2-storage",
  );
  expect(OBJECT_BUCKET_IMPLEMENTATION_TEMPLATE.aws_s3).toBe("aws-s3-storage");
});

test("planObjectBucket maps cloudflare_r2 to cloudflare-r2-storage with real inputs", () => {
  const target: TargetPoolEntry = {
    name: "cf-main",
    type: "cloudflare",
    ref: "cf-account-123",
    region: "weur",
    priority: 10,
  };
  const plan = planObjectBucket("cloudflare_r2", spec, target);

  expect(plan.templateId).toBe("cloudflare-r2-storage");
  // Real module variable names (providers/cloudflare/modules/cloudflare-r2-storage).
  expect(plan.inputs).toEqual({
    bucketName: "assets",
    accountId: "cf-account-123",
    location: "weur",
  });
  expect(plan.publicOutputs).toEqual(["bucket_name", "location"]);
  expect(plan.moduleFiles).toBe(
    firstPartyModuleFilesByTemplateId["cloudflare-r2-storage"],
  );
});

test("planObjectBucket omits location when the target has no region", () => {
  const target: TargetPoolEntry = {
    name: "cf-main",
    type: "cloudflare",
    ref: "cf-account-123",
    priority: 10,
  };
  const plan = planObjectBucket("cloudflare_r2", spec, target);
  expect(plan.inputs).toEqual({
    bucketName: "assets",
    accountId: "cf-account-123",
  });
  expect(plan.inputs.location).toBeUndefined();
});

test("planObjectBucket maps aws_s3 to aws-s3-storage with real inputs", () => {
  const target: TargetPoolEntry = {
    name: "aws-main",
    type: "aws",
    region: "us-east-1",
    priority: 5,
  };
  const plan = planObjectBucket("aws_s3", spec, target);

  expect(plan.templateId).toBe("aws-s3-storage");
  // Real module variable names (providers/aws/modules/aws-s3-storage).
  expect(plan.inputs).toEqual({ bucketName: "assets", region: "us-east-1" });
  expect(plan.publicOutputs).toEqual(["bucket_name", "bucket_arn", "region"]);
  expect(plan.moduleFiles).toBe(
    firstPartyModuleFilesByTemplateId["aws-s3-storage"],
  );
});

test("planObjectBucket omits region when the aws target has no region", () => {
  const target: TargetPoolEntry = {
    name: "aws-main",
    type: "aws",
    priority: 5,
  };
  const plan = planObjectBucket("aws_s3", spec, target);
  expect(plan.inputs).toEqual({ bucketName: "assets" });
});

test("planObjectBucket throws for an implementation without a first-party module", () => {
  const target: TargetPoolEntry = {
    name: "k8s",
    type: "kubernetes",
    priority: 1,
  };
  expect(() => planObjectBucket("minio", spec, target)).toThrow();
  expect(() =>
    planObjectBucket("takosumi_object_bucket", spec, target),
  ).toThrow();
});

test("planned module files are the real first-party HCL", () => {
  const target: TargetPoolEntry = {
    name: "aws-main",
    type: "aws",
    priority: 5,
  };
  const plan = planObjectBucket("aws_s3", spec, target);
  expect(plan.moduleFiles[0]?.path).toBe("main.tf");
  expect(plan.moduleFiles[0]?.text).toContain('resource "aws_s3_bucket"');
});

// --- EdgeWorker -------------------------------------------------------------

test("parseEdgeWorkerSpec accepts a Worker script artifact", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
    compatibilityDate: "2026-06-29",
    compatibilityFlags: ["nodejs_compat"],
    profiles: ["workers_bindings"],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.source.artifactPath).toBe("/work/dist/worker.js");
  expect(r.spec.compatibilityDate).toBe("2026-06-29");
  expect(r.spec.compatibilityFlags).toEqual(["nodejs_compat"]);
  expect(r.spec.profiles).toEqual(["workers_bindings"]);
});

test("parseEdgeWorkerSpec rejects an unknown profile", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
    profiles: ["lambda_handler"],
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_profile");
});

test("parseEdgeWorkerSpec requires an explicit artifactPath source", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_source");
});

test("parseEdgeWorkerSpec rejects source modes the planner cannot materialize", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactRef: "artifact_123" },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_source");
});

test("parseEdgeWorkerSpec rejects connections until grant/projection planning lands", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
    connections: {
      ASSETS: {
        resource: "ObjectBucket/assets",
        permissions: ["read"],
        projection: "runtime_binding",
      },
    },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_connections");
});

test("planEdgeWorker maps cloudflare_workers to cloudflare-worker-service", () => {
  const target: TargetPoolEntry = {
    name: "cf-main",
    type: "cloudflare",
    ref: "cf-account-123",
    priority: 10,
  };
  const plan = planEdgeWorker(
    "cloudflare_workers",
    {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
    target,
  );

  expect(EDGE_WORKER_IMPLEMENTATION_TEMPLATE.cloudflare_workers).toBe(
    "cloudflare-worker-service",
  );
  expect(plan.shape).toBe("EdgeWorker");
  expect(plan.templateId).toBe("cloudflare-worker-service");
  expect(plan.inputs).toEqual({
    appName: "api",
    accountId: "cf-account-123",
    artifactPath: "/work/dist/worker.js",
  });
  expect(plan.publicOutputs).toEqual(["worker_name"]);
  expect(plan.moduleFiles).toBe(
    firstPartyModuleFilesByTemplateId["cloudflare-worker-service"],
  );
});

// --- AIEndpoint --------------------------------------------------------------

test("parseAIEndpointSpec accepts an OpenAI-compatible endpoint policy", () => {
  const r = parseAIEndpointSpec({
    name: "ai",
    interfaces: ["openai_chat_completions", "openai_embeddings"],
    profiles: ["openai_compatible"],
    providerPreferences: ["provider.deepseek", "provider.gemini"],
    routingPolicy: {
      strategy: "lowest_latency",
      allowFallback: true,
      preferredRegions: ["jp", "us"],
    },
    modelPolicy: {
      defaultModel: "fast/chat",
      allowedModels: ["fast/chat", "embed/text"],
    },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.interfaces).toEqual([
    "openai_chat_completions",
    "openai_embeddings",
  ]);
  expect(r.spec.providerPreferences).toEqual([
    "provider.deepseek",
    "provider.gemini",
  ]);
  expect(r.spec.routingPolicy).toEqual({
    strategy: "lowest_latency",
    allowFallback: true,
    preferredRegions: ["jp", "us"],
  });
  expect(r.spec.modelPolicy?.defaultModel).toBe("fast/chat");
});

test("parseAIEndpointSpec accepts operator-defined AI interface and profile tokens", () => {
  const r = parseAIEndpointSpec({
    name: "ai",
    interfaces: ["openai_chat_completions", "vendor.deepseek.responses.v1"],
    profiles: ["openai_compatible", "provider.deepseek"],
    providerPreferences: ["provider.deepseek"],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.interfaces).toContain("vendor.deepseek.responses.v1");
  expect(r.spec.profiles).toContain("provider.deepseek");
  expect(r.spec.providerPreferences).toContain("provider.deepseek");
});

test("parseAIEndpointSpec rejects an invalid AI interface token", () => {
  const r = parseAIEndpointSpec({
    name: "ai",
    interfaces: ["bad interface"],
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_interface");
});

test("parseAIEndpointSpec rejects an invalid AI routing token", () => {
  const r = parseAIEndpointSpec({
    name: "ai",
    interfaces: ["openai_chat_completions"],
    routingPolicy: {
      strategy: "lowest latency",
    },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_routing_policy");
});

test("planAIEndpoint keeps upstream choice in the selected target", () => {
  const target: TargetPoolEntry = {
    name: "deepseek-main",
    type: "ai_provider",
    ref: "https://api.deepseek.example/v1",
    priority: 10,
  };
  const plan = planAIEndpoint(
    "openai_compatible_ai_endpoint",
    {
      name: "ai",
      interfaces: ["openai_chat_completions"],
      profiles: ["openai_compatible"],
      providerPreferences: ["provider.deepseek"],
      routingPolicy: {
        strategy: "lowest_latency",
        allowFallback: true,
        preferredRegions: ["jp"],
      },
      modelPolicy: { defaultModel: "deepseek/chat" },
    },
    target,
  );

  expect(
    AI_ENDPOINT_IMPLEMENTATION_TEMPLATE.openai_compatible_ai_endpoint,
  ).toBe("takosumi-ai-endpoint");
  expect(plan.shape).toBe("AIEndpoint");
  expect(plan.templateId).toBe("takosumi-ai-endpoint");
  expect(plan.inputs).toEqual({
    endpointName: "ai",
    implementation: "openai_compatible_ai_endpoint",
    targetName: "deepseek-main",
    targetType: "ai_provider",
    interfaces: ["openai_chat_completions"],
    profiles: ["openai_compatible"],
    providerPreferences: ["provider.deepseek"],
    routingStrategy: "lowest_latency",
    allowFallback: true,
    preferredRegions: ["jp"],
    allowedModels: [],
    defaultModel: "deepseek/chat",
    baseUrl: "https://api.deepseek.example/v1",
  });
  expect(plan.publicOutputs).toEqual(["base_url", "default_model"]);
  expect(plan.moduleFiles).toBe(
    firstPartyModuleFilesByTemplateId["takosumi-ai-endpoint"],
  );
});

test("planAIEndpoint uses the generic projection module for admin-defined implementations", () => {
  const target: TargetPoolEntry = {
    name: "gemini-main",
    type: "ai_provider",
    ref: "https://generativelanguage.googleapis.com/v1beta/openai",
    priority: 10,
  };
  const plan = planAIEndpoint(
    "gemini_openai_compatible",
    {
      name: "ai",
      interfaces: ["openai_chat_completions"],
      profiles: ["provider.gemini", "openai_compatible"],
      providerPreferences: ["provider.gemini"],
    },
    target,
  );

  expect(AI_ENDPOINT_GENERIC_TEMPLATE_ID).toBe("takosumi-ai-endpoint");
  expect(plan.templateId).toBe(AI_ENDPOINT_GENERIC_TEMPLATE_ID);
  expect(plan.inputs.implementation).toBe("gemini_openai_compatible");
  expect(plan.inputs.profiles).toEqual([
    "provider.gemini",
    "openai_compatible",
  ]);
  expect(plan.inputs.providerPreferences).toEqual(["provider.gemini"]);
});
