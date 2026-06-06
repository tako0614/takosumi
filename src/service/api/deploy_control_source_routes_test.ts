import { expect, test } from "bun:test";

import { createApiApp } from "./app.ts";
import { OpenTofuDeploymentController } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import { SourcesService } from "../domains/sources/mod.ts";

function makeApp() {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_route${(counter += 1).toString().padStart(10, "0")}`,
    newHookSecret: () => "whk_route_secret",
  });
  const controller = new OpenTofuDeploymentController({
    store,
    sourcesService,
  });
  return createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      controller,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
            actor: "acct_1",
            spaceIds: ["space_1"],
            operations: "*",
            runnerProfileIds: "*",
          }
          : undefined,
    },
    requestCorrelation: false,
  });
}

const HEADERS = {
  authorization: "Bearer scoped-token",
  "content-type": "application/json",
} as const;

test("POST /api/sources requires a bearer (401)", async () => {
  const app = await makeApp();
  const response = await app.request("/api/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spaceId: "space_1",
      name: "r",
      url: "https://github.com/a/b",
    }),
  });
  expect(response.status).toBe(401);
});

test("POST /api/sources rejects an unknown field (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/api/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      name: "r",
      url: "https://github.com/a/b",
      sneaky: 1,
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});

test("POST /api/sources enforces space scope (403)", async () => {
  const app = await makeApp();
  const response = await app.request("/api/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_denied",
      name: "r",
      url: "https://github.com/a/b",
    }),
  });
  expect(response.status).toBe(403);
});

test("POST /api/sources rejects a forbidden URL (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/api/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      name: "r",
      url: "git://github.com/a/b",
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toMatch(/not allowed/);
});

test("source register -> sync -> snapshots flow", async () => {
  const app = await makeApp();
  const created = await app.request("/api/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      name: "r",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  // The hook secret is returned exactly once at creation.
  expect(createdBody.hookSecret).toBe("whk_route_secret");
  const sourceId = createdBody.source.id;

  const list = await app.request("/api/sources?spaceId=space_1", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect((await list.json()).sources).toHaveLength(1);

  const got = await app.request(`/api/sources/${sourceId}`, {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(got.status).toBe(200);
  // The hook secret hash is never projected.
  expect(await got.text()).not.toContain("hookSecretHash");

  const synced = await app.request(`/api/sources/${sourceId}/sync`, {
    method: "POST",
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(synced.status).toBe(201);
  expect((await synced.json()).run.status).toBe("queued");

  const snaps = await app.request(`/api/sources/${sourceId}/snapshots`, {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(snaps.status).toBe(200);
  expect((await snaps.json()).snapshots).toEqual([]);
});

test("PATCH /api/sources updates fields", async () => {
  const app = await makeApp();
  const created = await app.request("/api/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      name: "r",
      url: "https://github.com/acme/repo.git",
    }),
  });
  const { source } = await created.json();
  const patched = await app.request(`/api/sources/${source.id}`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ status: "disabled", defaultRef: "release" }),
  });
  expect(patched.status).toBe(200);
  const body = await patched.json();
  expect(body.source.status).toBe("disabled");
  expect(body.source.defaultRef).toBe("release");
});

test("source id with an unsupported shape is rejected (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/api/sources/not-a-source/snapshots", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(400);
});

test("GET /api/sources requires spaceId (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/api/sources", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(400);
});
