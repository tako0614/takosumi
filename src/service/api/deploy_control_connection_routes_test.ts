import { expect, test } from "bun:test";

import { createApiApp } from "./app.ts";
import { OpenTofuDeploymentController } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import { StaticSecretConnectionVault } from "../adapters/vault/mod.ts";
import { MultiCloudSecretBoundaryCrypto } from "../adapters/secret-store/memory.ts";

function makeApp(options: { fetch?: typeof fetch } = {}) {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "route-test-passphrase-0123456789-abcdef",
    }),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => `conn_route${(counter += 1).toString().padStart(11, "0")}`,
    fetch: options.fetch as never,
  });
  const controller = new OpenTofuDeploymentController({ store, vault });
  return createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      controller,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? { actor: "acct_1", spaceIds: ["space_1"], operations: "*", runnerProfileIds: "*" }
          : undefined,
    },
    requestCorrelation: false,
  });
}

const HEADERS = {
  authorization: "Bearer scoped-token",
  "content-type": "application/json",
} as const;

test("POST /v1/connections requires a bearer (401)", async () => {
  const app = await makeApp();
  const response = await app.request("/v1/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf" },
    }),
  });
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});

test("POST /v1/connections rejects an unknown body field (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/v1/connections", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf" },
      sneaky: "field",
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});

test("POST /v1/connections enforces space scope (403)", async () => {
  const app = await makeApp();
  const response = await app.request("/v1/connections", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_denied",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf" },
    }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("POST /v1/connections happy path returns 201 and never echoes values", async () => {
  const app = await makeApp();
  const response = await app.request("/v1/connections", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      displayName: "prod",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("cf-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connection.status).toBe("pending");
  expect(payload.connection.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
  expect(payload.connection.values).toBeUndefined();
});

test("GET /v1/connections lists connections without secret values", async () => {
  const app = await makeApp();
  await app.request("/v1/connections", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });

  const response = await app.request("/v1/connections?spaceId=space_1", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("cf-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connections).toHaveLength(1);
  expect(payload.connections[0].provider).toBe("cloudflare");
});

test("GET /v1/connections requires spaceId (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/v1/connections", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});

test("POST /v1/connections/{id}/test verifies via injected fetch (200 verified)", async () => {
  const fakeFetch = (): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({ success: true, result: { status: "active" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const app = await makeApp({ fetch: fakeFetch as never });
  const created = await app.request("/v1/connections", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  const { connection } = await created.json();

  const tested = await app.request(`/v1/connections/${connection.id}/test`, {
    method: "POST",
    headers: HEADERS,
  });
  expect(tested.status).toBe(200);
  expect((await tested.json()).status).toBe("verified");
});

test("DELETE /v1/connections/{id} revokes and returns 204", async () => {
  const app = await makeApp();
  const created = await app.request("/v1/connections", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  const { connection } = await created.json();

  const deleted = await app.request(`/v1/connections/${connection.id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(deleted.status).toBe(204);

  const list = await app.request("/v1/connections?spaceId=space_1", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect((await list.json()).connections).toHaveLength(0);
});

test("connection id with an unsupported shape is rejected (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/v1/connections/not-a-conn-id/test", {
    method: "POST",
    headers: HEADERS,
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});
