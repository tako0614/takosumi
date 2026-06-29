import { test, expect } from "bun:test";

import type { TargetPoolEntry } from "takosumi-contract";
import {
  AI_ENDPOINT_GENERIC_TEMPLATE_ID,
  AI_ENDPOINT_IMPLEMENTATION_TEMPLATE,
  EDGE_WORKER_IMPLEMENTATION_TEMPLATE,
  parseAIEndpointSpec,
  parseEdgeWorkerSpec,
  planAIEndpoint,
  planEdgeWorker,
} from "../../../../core/domains/resource-shape/planner.ts";
import { firstPartyModuleFilesByTemplateId } from "../../../../opentofu-modules/module-files.ts";

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
      AI: {
        resource: "AIEndpoint/main",
        permissions: ["connect"],
        projection: "env",
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
  expect(r.spec.routingPolicy?.strategy).toBe("lowest_latency");
  expect(r.spec.modelPolicy?.defaultModel).toBe("fast/chat");
});

test("parseAIEndpointSpec keeps vendor interface/profile tokens extensible", () => {
  const r = parseAIEndpointSpec({
    name: "ai",
    interfaces: ["openai_chat_completions", "vendor.glm.responses.v1"],
    profiles: ["openai_compatible", "provider.glm"],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.interfaces).toContain("vendor.glm.responses.v1");
  expect(r.spec.profiles).toContain("provider.glm");
});

test("parseAIEndpointSpec rejects empty interfaces", () => {
  const r = parseAIEndpointSpec({ name: "ai", interfaces: [] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_interfaces");
});

test("planAIEndpoint uses a generic endpoint module for known and custom implementations", () => {
  const target: TargetPoolEntry = {
    name: "deepseek-main",
    type: "ai_provider",
    ref: "https://api.deepseek.example/v1",
    priority: 90,
  };
  const plan = planAIEndpoint(
    "deepseek_openai_gateway",
    {
      name: "ai",
      interfaces: ["openai_chat_completions"],
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
    target,
  );

  expect(
    AI_ENDPOINT_IMPLEMENTATION_TEMPLATE.cloudflare_ai_gateway,
  ).toBe(AI_ENDPOINT_GENERIC_TEMPLATE_ID);
  expect(plan.templateId).toBe(AI_ENDPOINT_GENERIC_TEMPLATE_ID);
  expect(plan.shape).toBe("AIEndpoint");
  expect(plan.inputs).toEqual({
    endpointName: "ai",
    implementation: "deepseek_openai_gateway",
    targetName: "deepseek-main",
    targetType: "ai_provider",
    interfaces: ["openai_chat_completions"],
    profiles: ["openai_compatible", "provider.deepseek"],
    providerPreferences: ["provider.deepseek"],
    routingStrategy: "lowest_latency",
    allowFallback: true,
    preferredRegions: ["jp"],
    allowedModels: ["deepseek/chat"],
    defaultModel: "deepseek/chat",
    baseUrl: "https://api.deepseek.example/v1",
  });
  expect(plan.publicOutputs).toEqual(["base_url", "default_model"]);
  expect(plan.moduleFiles).toBe(
    firstPartyModuleFilesByTemplateId[AI_ENDPOINT_GENERIC_TEMPLATE_ID],
  );
});
