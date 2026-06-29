import { test, expect } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";
import {
  createInMemoryResourceShapeStores,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../core/domains/resource-shape/mod.ts";
import type { SpacePolicySpec, TargetPoolSpec } from "takosumi-contract";

const POOL: TargetPoolSpec = {
  targets: [
    { name: "cloudflare-main", type: "cloudflare", ref: "cf-acct", priority: 80 },
    { name: "aws-main", type: "aws", region: "ap-northeast-1", priority: 70 },
  ],
};

const POLICY: SpacePolicySpec = {
  resolution: { lockAfterCreate: true, allowAutoMigration: false },
};

async function buildApp() {
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  await service.putTargetPool("space_1", "default", POOL);
  await service.putSpacePolicy("space_1", "default", POLICY);
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    resourceShapeRouteOptions: { service },
    requestCorrelation: false,
  });
  return { app, service };
}

const JSON_HEADERS = { "content-type": "application/json" };

test("PUT /v1/resources/ObjectStore/:name applies and returns id + resolution", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/ObjectStore/assets", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api", "signed_url"] },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:ObjectStore:assets");
  expect(body.status.resolution.selectedImplementation).toBe("cloudflare_r2");
  expect(body.status.resolution.target).toBe("cloudflare-main");
  expect(body.status.phase).toBe("Ready");
});

test("PUT /v1/resources/HttpService/:name applies a first-class service shape", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/HttpService/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        runtime: {
          interface: "web_fetch",
          source: { artifactPath: "/work/dist/worker.js" },
        },
        exposure: { publicHttp: true },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:HttpService:api");
  expect(body.status.resolution.selectedImplementation).toBe("cloudflare_workers");
});

test("PUT /v1/resources/AIEndpoint/:name applies a first-class AI shape", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/AIEndpoint/ai", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "ai",
        interfaces: ["openai_chat_completions", "openai_embeddings"],
        profiles: ["openai_compatible"],
        modelPolicy: {
          defaultModel: "fast/chat",
          allowedModels: ["fast/chat", "embed/text"],
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:AIEndpoint:ai");
  expect(body.status.resolution.selectedImplementation).toBe("cloudflare_ai_gateway");
  expect(body.status.outputs.base_url).toContain("AIEndpoint:ai/base_url");
});

test("PUT /v1/resources/AIEndpoint/:name accepts admin-defined AI profiles", async () => {
  const { app, service } = await buildApp();
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
            },
          },
        ],
      },
    ],
  });
  const res = await app.request("/v1/resources/AIEndpoint/ai", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "ai",
        interfaces: ["openai_chat_completions", "vendor.deepseek.responses.v1"],
        profiles: ["openai_compatible", "provider.deepseek"],
        modelPolicy: { defaultModel: "deepseek/chat" },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status.resolution.selectedImplementation).toBe(
    "deepseek_openai_gateway",
  );
  expect(body.status.resolution.target).toBe("deepseek-main");
});

test("GET /v1/resources/ObjectStore/:name returns the applied resource", async () => {
  const { app } = await buildApp();
  await app.request("/v1/resources/ObjectStore/assets", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    }),
  });
  const res = await app.request("/v1/resources/ObjectStore/assets?space=space_1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.metadata.name).toBe("assets");
  expect(body.status.resolution.target).toBe("cloudflare-main");
});

test("POST /v1/resources/preview resolves without persisting", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "ObjectStore",
      metadata: { space: "space_1", name: "assets" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.selectedImplementation).toBe("cloudflare_r2");
});

test("POST /v1/resources/preview requires an explicit shape kind", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1", name: "assets" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("PUT /v1/resources/:kind/:name rejects body kind mismatch", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/ObjectStore/assets", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "HttpService",
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("PUT /v1/resources/:kind/:name rejects name mismatch", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/ObjectStore/assets", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1", name: "other" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("Queue is not accepted until the planner can materialize it", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/Queue/jobs", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "jobs", interfaces: ["queue_api"] },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("missing space yields a 400 nested error envelope", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/ObjectStore/assets", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ spec: { name: "assets", interfaces: ["s3_api"] } }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
  expect(typeof body.error.requestId).toBe("string");
});

test("GET /v1/capabilities advertises enabled Resource Shapes", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/capabilities");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.resources.ObjectStore).toBe(true);
  expect(body.resources.HttpService).toBe(true);
  expect(body.resources.AIEndpoint).toBe(true);
});
