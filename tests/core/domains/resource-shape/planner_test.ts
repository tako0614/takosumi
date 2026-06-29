import { test, expect } from "bun:test";

import type { ObjectStoreSpec, TargetPoolEntry } from "takosumi-contract";
import {
  AI_ENDPOINT_GENERIC_TEMPLATE_ID,
  AI_ENDPOINT_IMPLEMENTATION_TEMPLATE,
  HTTP_SERVICE_IMPLEMENTATION_TEMPLATE,
  OBJECT_STORE_IMPLEMENTATION_TEMPLATE,
  parseAIEndpointSpec,
  parseHttpServiceSpec,
  parseObjectStoreSpec,
  planAIEndpoint,
  planHttpService,
  planObjectStore,
} from "../../../../core/domains/resource-shape/planner.ts";
import { firstPartyModuleFilesByTemplateId } from "../../../../opentofu-modules/module-files.ts";

// --- parseObjectStoreSpec ----------------------------------------------------

test("parseObjectStoreSpec accepts a valid minimal spec", () => {
  const r = parseObjectStoreSpec({ name: "assets", interfaces: ["s3_api"] });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.spec.name).toBe("assets");
    expect(r.spec.interfaces).toEqual(["s3_api"]);
    expect(r.spec.lifecyclePolicy).toBeUndefined();
  }
});

test("parseObjectStoreSpec accepts a valid lifecyclePolicy", () => {
  const r = parseObjectStoreSpec({
    name: "assets",
    interfaces: ["s3_api", "signed_url"],
    lifecyclePolicy: { delete: "retain" },
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.spec.lifecyclePolicy?.delete).toBe("retain");
});

test("parseObjectStoreSpec rejects a non-object spec", () => {
  expect(parseObjectStoreSpec(null).ok).toBe(false);
  expect(parseObjectStoreSpec("nope").ok).toBe(false);
  expect(parseObjectStoreSpec([]).ok).toBe(false);
});

test("parseObjectStoreSpec rejects a missing/blank name", () => {
  const missing = parseObjectStoreSpec({ interfaces: ["s3_api"] });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.code).toBe("invalid_name");

  const blank = parseObjectStoreSpec({ name: "   ", interfaces: ["s3_api"] });
  expect(blank.ok).toBe(false);
});

test("parseObjectStoreSpec rejects empty interfaces", () => {
  const r = parseObjectStoreSpec({ name: "assets", interfaces: [] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_interfaces");
});

test("parseObjectStoreSpec rejects an unknown interface value", () => {
  const r = parseObjectStoreSpec({ name: "assets", interfaces: ["s3_api", "ftp"] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_interface");
});

test("parseObjectStoreSpec rejects an invalid delete policy", () => {
  const r = parseObjectStoreSpec({
    name: "assets",
    interfaces: ["s3_api"],
    lifecyclePolicy: { delete: "vaporize" },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_delete_policy");
});

// --- planObjectStore ---------------------------------------------------------

const spec: ObjectStoreSpec = { name: "assets", interfaces: ["s3_api", "signed_url"] };

test("implementation->templateId map matches the first-party catalog", () => {
  expect(OBJECT_STORE_IMPLEMENTATION_TEMPLATE.cloudflare_r2).toBe(
    "cloudflare-r2-storage",
  );
  expect(OBJECT_STORE_IMPLEMENTATION_TEMPLATE.aws_s3).toBe("aws-s3-storage");
});

test("planObjectStore maps cloudflare_r2 to cloudflare-r2-storage with real inputs", () => {
  const target: TargetPoolEntry = {
    name: "cf-main",
    type: "cloudflare",
    ref: "cf-account-123",
    region: "weur",
    priority: 10,
  };
  const plan = planObjectStore("cloudflare_r2", spec, target);

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

test("planObjectStore omits location when the target has no region", () => {
  const target: TargetPoolEntry = {
    name: "cf-main",
    type: "cloudflare",
    ref: "cf-account-123",
    priority: 10,
  };
  const plan = planObjectStore("cloudflare_r2", spec, target);
  expect(plan.inputs).toEqual({ bucketName: "assets", accountId: "cf-account-123" });
  expect(plan.inputs.location).toBeUndefined();
});

test("planObjectStore maps aws_s3 to aws-s3-storage with real inputs", () => {
  const target: TargetPoolEntry = {
    name: "aws-main",
    type: "aws",
    region: "us-east-1",
    priority: 5,
  };
  const plan = planObjectStore("aws_s3", spec, target);

  expect(plan.templateId).toBe("aws-s3-storage");
  // Real module variable names (providers/aws/modules/aws-s3-storage).
  expect(plan.inputs).toEqual({ bucketName: "assets", region: "us-east-1" });
  expect(plan.publicOutputs).toEqual(["bucket_name", "bucket_arn", "region"]);
  expect(plan.moduleFiles).toBe(firstPartyModuleFilesByTemplateId["aws-s3-storage"]);
});

test("planObjectStore omits region when the aws target has no region", () => {
  const target: TargetPoolEntry = { name: "aws-main", type: "aws", priority: 5 };
  const plan = planObjectStore("aws_s3", spec, target);
  expect(plan.inputs).toEqual({ bucketName: "assets" });
});

test("planObjectStore throws for an implementation without a first-party module", () => {
  const target: TargetPoolEntry = { name: "k8s", type: "kubernetes", priority: 1 };
  expect(() => planObjectStore("minio", spec, target)).toThrow();
  expect(() => planObjectStore("takosumi_object_store", spec, target)).toThrow();
});

test("planned module files are the real first-party HCL", () => {
  const target: TargetPoolEntry = { name: "aws-main", type: "aws", priority: 5 };
  const plan = planObjectStore("aws_s3", spec, target);
  expect(plan.moduleFiles[0]?.path).toBe("main.tf");
  expect(plan.moduleFiles[0]?.text).toContain('resource "aws_s3_bucket"');
});

// --- HttpService -------------------------------------------------------------

test("parseHttpServiceSpec accepts a Worker-compatible service", () => {
  const r = parseHttpServiceSpec({
    name: "api",
    runtime: {
      interface: "web_fetch",
      language: "typescript",
      profiles: ["workers_bindings"],
      source: { artifactPath: "/work/dist/worker.js" },
    },
    exposure: { publicHttp: true },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.runtime.interface).toBe("web_fetch");
  expect(r.spec.runtime.source?.artifactPath).toBe("/work/dist/worker.js");
  expect(r.spec.exposure?.publicHttp).toBe(true);
});

test("parseHttpServiceSpec rejects an unknown runtime interface", () => {
  const r = parseHttpServiceSpec({
    name: "api",
    runtime: { interface: "cgi" },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_runtime_interface");
});

test("parseHttpServiceSpec requires an explicit artifactPath source", () => {
  const r = parseHttpServiceSpec({
    name: "api",
    runtime: { interface: "web_fetch" },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_source");
});

test("parseHttpServiceSpec rejects source modes the planner cannot materialize", () => {
  const r = parseHttpServiceSpec({
    name: "api",
    runtime: {
      interface: "web_fetch",
      source: { artifactRef: "artifact_123" },
    },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_source");
});

test("parseHttpServiceSpec rejects connections until grant/projection planning lands", () => {
  const r = parseHttpServiceSpec({
    name: "api",
    runtime: {
      interface: "web_fetch",
      source: { artifactPath: "/work/dist/worker.js" },
    },
    connections: {
      ASSETS: {
        resource: "ObjectStore/assets",
        permissions: ["read"],
        projection: "runtime_binding",
      },
    },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_connections");
});

test("planHttpService maps cloudflare_workers to cloudflare-worker-service", () => {
  const target: TargetPoolEntry = {
    name: "cf-main",
    type: "cloudflare",
    ref: "cf-account-123",
    priority: 10,
  };
  const plan = planHttpService("cloudflare_workers", {
    name: "api",
    runtime: {
      interface: "web_fetch",
      source: { artifactPath: "/work/dist/worker.js" },
    },
    exposure: { publicHttp: true },
  }, target);

  expect(HTTP_SERVICE_IMPLEMENTATION_TEMPLATE.cloudflare_workers).toBe(
    "cloudflare-worker-service",
  );
  expect(plan.shape).toBe("HttpService");
  expect(plan.templateId).toBe("cloudflare-worker-service");
  expect(plan.inputs).toEqual({
    appName: "api",
    accountId: "cf-account-123",
    artifactPath: "/work/dist/worker.js",
    publicUrl: "",
  });
  expect(plan.publicOutputs).toEqual(["worker_name", "url"]);
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
  expect(r.spec.modelPolicy?.defaultModel).toBe("fast/chat");
});

test("parseAIEndpointSpec accepts operator-defined AI interface and profile tokens", () => {
  const r = parseAIEndpointSpec({
    name: "ai",
    interfaces: ["openai_chat_completions", "vendor.deepseek.responses.v1"],
    profiles: ["openai_compatible", "provider.deepseek"],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.interfaces).toContain("vendor.deepseek.responses.v1");
  expect(r.spec.profiles).toContain("provider.deepseek");
});

test("parseAIEndpointSpec rejects an invalid AI interface token", () => {
  const r = parseAIEndpointSpec({
    name: "ai",
    interfaces: ["bad interface"],
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_interface");
});

test("planAIEndpoint keeps upstream choice in the selected target", () => {
  const target: TargetPoolEntry = {
    name: "deepseek-main",
    type: "ai_provider",
    ref: "https://api.deepseek.example/v1",
    priority: 10,
  };
  const plan = planAIEndpoint("openai_compatible_ai_endpoint", {
    name: "ai",
    interfaces: ["openai_chat_completions"],
    profiles: ["openai_compatible"],
    modelPolicy: { defaultModel: "deepseek/chat" },
  }, target);

  expect(AI_ENDPOINT_IMPLEMENTATION_TEMPLATE.openai_compatible_ai_endpoint).toBe(
    "takosumi-ai-endpoint",
  );
  expect(plan.shape).toBe("AIEndpoint");
  expect(plan.templateId).toBe("takosumi-ai-endpoint");
  expect(plan.inputs).toEqual({
    endpointName: "ai",
    implementation: "openai_compatible_ai_endpoint",
    targetName: "deepseek-main",
    targetType: "ai_provider",
    interfaces: ["openai_chat_completions"],
    profiles: ["openai_compatible"],
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
  const plan = planAIEndpoint("gemini_openai_compatible", {
    name: "ai",
    interfaces: ["openai_chat_completions"],
    profiles: ["provider.gemini", "openai_compatible"],
  }, target);

  expect(AI_ENDPOINT_GENERIC_TEMPLATE_ID).toBe("takosumi-ai-endpoint");
  expect(plan.templateId).toBe(AI_ENDPOINT_GENERIC_TEMPLATE_ID);
  expect(plan.inputs.implementation).toBe("gemini_openai_compatible");
  expect(plan.inputs.profiles).toEqual(["provider.gemini", "openai_compatible"]);
});
