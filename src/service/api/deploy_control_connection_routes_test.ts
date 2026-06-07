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
          : token === "operator-token"
          ? { actor: "op", spaceIds: "*", operations: "*", runnerProfileIds: "*" }
          : undefined,
    },
    requestCorrelation: false,
  });
}

const CF_PATH = "/api/connections/cloudflare/token";
const HTTPS_PATH = "/api/connections/source/https-token";
const SSH_PATH = "/api/connections/source/ssh-key";
const AWS_PATH = "/api/connections/aws/assume-role";

const HEADERS = {
  authorization: "Bearer scoped-token",
  "content-type": "application/json",
} as const;

test("POST /api/connections/cloudflare/token requires a bearer (401)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spaceId: "space_1",
      values: { CLOUDFLARE_API_TOKEN: "cf" },
    }),
  });
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});

test("POST /api/connections/cloudflare/token rejects an unknown body field (400)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      values: { CLOUDFLARE_API_TOKEN: "cf" },
      sneaky: "field",
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});

test("POST /api/connections/cloudflare/token enforces space scope (403)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_denied",
      values: { CLOUDFLARE_API_TOKEN: "cf" },
    }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("POST /api/connections/cloudflare/token happy path returns 201 and never echoes values", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      displayName: "prod",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("cf-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connection.status).toBe("pending");
  expect(payload.connection.provider).toBe("cloudflare");
  expect(payload.connection.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
  expect(payload.connection.values).toBeUndefined();
});

test("POST /api/connections/source/https-token returns 201 with the source kind", async () => {
  const app = await makeApp();
  const response = await app.request(HTTPS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      displayName: "github",
      scopeHints: { username: "git" },
      values: { GIT_HTTPS_TOKEN: "ghp-secret" },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("ghp-secret");
  const payload = JSON.parse(text);
  expect(payload.connection.kind).toBe("source_git_https_token");
});

test("POST /api/connections/source/ssh-key requires knownHosts (400)", async () => {
  const app = await makeApp();
  const response = await app.request(SSH_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      values: { GIT_SSH_PRIVATE_KEY: "-----BEGIN KEY-----" },
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("knownHostsEntry");
});

test("POST /api/connections/source/ssh-key with knownHosts returns 201", async () => {
  const app = await makeApp();
  const response = await app.request(SSH_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      scopeHints: { knownHostsEntry: "github.com ssh-ed25519 AAAA..." },
      values: {
        GIT_SSH_PRIVATE_KEY: "-----BEGIN KEY-----\nprivatekeymaterial\n-----END KEY-----",
      },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("privatekeymaterial");
  expect(JSON.parse(text).connection.kind).toBe("source_git_ssh_key");
});

test("POST /api/connections/aws/assume-role requires a role ARN hint (400)", async () => {
  const app = await makeApp();
  const response = await app.request(AWS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      values: {
        AWS_ACCESS_KEY_ID: "akid",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("awsRoleArn");
});

test("POST /api/connections/aws/assume-role returns 201 and never echoes values", async () => {
  const app = await makeApp();
  const response = await app.request(AWS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      displayName: "prod aws",
      scopeHints: {
        awsRoleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
        awsExternalId: "space_1",
        awsRegion: "us-east-1",
      },
      values: {
        AWS_ACCESS_KEY_ID: "akid",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("aws-secret");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe("aws");
  expect(payload.connection.kind).toBe("provider");
  expect(payload.connection.authMethod).toBe("static_secret");
  expect(payload.connection.scopeHints.awsRoleArn).toBe(
    "arn:aws:iam::123456789012:role/takosumi-prod",
  );
  expect(payload.connection.envNames).toEqual([
    "AWS_ACCESS_KEY_ID",
    "AWS_REGION",
    "AWS_ROLE_ARN",
    "AWS_SECRET_ACCESS_KEY",
  ]);
  expect(payload.connection.values).toBeUndefined();
});

test("GET /api/connections lists connections without secret values", async () => {
  const app = await makeApp();
  await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });

  const response = await app.request("/api/connections?spaceId=space_1", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("cf-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connections).toHaveLength(1);
  expect(payload.connections[0].provider).toBe("cloudflare");
});

test("GET /api/connections with no spaceId lists operator-scoped connections for the unrestricted bearer", async () => {
  const app = await makeApp();
  // Operator-scoped connection (no spaceId): only the unrestricted bearer.
  await app.request(CF_PATH, {
    method: "POST",
    headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
    body: JSON.stringify({
      scope: "operator",
      values: { CLOUDFLARE_API_TOKEN: "op-secret-token" },
    }),
  });

  const response = await app.request("/api/connections", {
    headers: { authorization: "Bearer operator-token" },
  });
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.connections).toHaveLength(1);
  expect(payload.connections[0].scope).toBe("operator");
});

test("GET /api/connections with no spaceId is denied for a scoped bearer (403)", async () => {
  const app = await makeApp();
  const response = await app.request("/api/connections", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("POST /api/connections/{id}/test verifies via injected fetch (200 verified)", async () => {
  const fakeFetch = (): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({ success: true, result: { status: "active" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const app = await makeApp({ fetch: fakeFetch as never });
  const created = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  const { connection } = await created.json();

  const tested = await app.request(`/api/connections/${connection.id}/test`, {
    method: "POST",
    headers: HEADERS,
  });
  expect(tested.status).toBe(200);
  expect((await tested.json()).status).toBe("verified");
});

test("POST /api/connections/{id}/revoke revokes and returns 204", async () => {
  const app = await makeApp();
  const created = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  const { connection } = await created.json();

  const revoked = await app.request(`/api/connections/${connection.id}/revoke`, {
    method: "POST",
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(revoked.status).toBe(204);

  const list = await app.request("/api/connections?spaceId=space_1", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect((await list.json()).connections).toHaveLength(0);
});

test("connection id with an unsupported shape is rejected (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/api/connections/not-a-conn-id/test", {
    method: "POST",
    headers: HEADERS,
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});
