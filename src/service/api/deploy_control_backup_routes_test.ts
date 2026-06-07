import { expect, test } from "bun:test";

import { createApiApp } from "./app.ts";
import { OpenTofuDeploymentController } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import { SourcesService } from "../domains/sources/mod.ts";
import { ActivityService } from "../domains/activity/mod.ts";
import {
  BackupsService,
  InMemoryBackupArtifactStore,
} from "../domains/backups/mod.ts";
import { seedInstallationModel } from "../domains/deploy-control/test_model_fixture.ts";

const TS = "2026-06-06T00:00:00.000Z";

async function makeApp(options: { readonly withArtifactStore?: boolean } = {}) {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedInstallationModel(store, { spaceId: "space_aaaaaaaa" });
  let counter = 0;
  const sourcesService = new SourcesService({ store });
  const controller = new OpenTofuDeploymentController({ store, sourcesService });
  const activity = new ActivityService({ store, now: () => new Date(TS) });
  const artifactStore = options.withArtifactStore === false
    ? undefined
    : new InMemoryBackupArtifactStore();
  const backupsService = new BackupsService({
    store,
    ...(artifactStore ? { artifactStore } : {}),
    activity,
    now: () => new Date(TS),
    newId: (prefix) => `${prefix}_${(counter += 1).toString().padStart(4, "0")}`,
  });
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      controller,
      backupsService,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
            actor: "acct_1",
            spaceIds: ["space_aaaaaaaa"],
            operations: "*",
            runnerProfileIds: "*",
          }
          : undefined,
    },
    requestCorrelation: false,
  });
  return { app, store };
}

const HEADERS = {
  authorization: "Bearer scoped-token",
  "content-type": "application/json",
} as const;

test("POST /api/spaces/:spaceId/backups requires a bearer (401)", async () => {
  const { app } = await makeApp();
  const response = await app.request("/api/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(401);
});

test("POST /api/spaces/:spaceId/backups enforces space scope (403)", async () => {
  const { app } = await makeApp();
  const response = await app.request("/api/spaces/space_bbbbbbbb/backups", {
    method: "POST",
    headers: HEADERS,
  });
  expect(response.status).toBe(403);
});

test("POST /api/spaces/:spaceId/backups rejects a malformed spaceId (400)", async () => {
  const { app } = await makeApp();
  const response = await app.request("/api/spaces/not-a-space/backups", {
    method: "POST",
    headers: HEADERS,
  });
  expect(response.status).toBe(400);
});

test("POST /api/spaces/:spaceId/backups creates a backup (201)", async () => {
  const { app, store } = await makeApp();
  const response = await app.request("/api/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.backup.spaceId).toBe("space_aaaaaaaa");
  expect(body.backup.objectKey).toBe(
    "spaces/space_aaaaaaaa/backups/bkp_0001/control.json.gz.enc",
  );
  expect(body.backup.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

  // The pointer is persisted in the ledger.
  const listed = await store.listBackupRecords("space_aaaaaaaa");
  expect(listed.map((b) => b.id)).toEqual([body.backup.id]);
});

test("GET /api/spaces/:spaceId/backups lists backups newest-first (200)", async () => {
  const { app } = await makeApp();
  await app.request("/api/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });
  await app.request("/api/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });

  const response = await app.request("/api/spaces/space_aaaaaaaa/backups", {
    headers: HEADERS,
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.backups.length).toBe(2);
  for (const backup of body.backups) {
    expect(backup.spaceId).toBe("space_aaaaaaaa");
  }
});

test("GET /api/spaces/:spaceId/backups enforces space scope (403)", async () => {
  const { app } = await makeApp();
  const response = await app.request("/api/spaces/space_bbbbbbbb/backups", {
    headers: HEADERS,
  });
  expect(response.status).toBe(403);
});

test("backup routes return 501 when the backups service is unwired", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedInstallationModel(store, { spaceId: "space_aaaaaaaa" });
  const controller = new OpenTofuDeploymentController({ store });
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      controller,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? { actor: "a", spaceIds: ["space_aaaaaaaa"], operations: "*", runnerProfileIds: "*" }
          : undefined,
    },
    requestCorrelation: false,
  });
  const post = await app.request("/api/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });
  expect(post.status).toBe(501);
  const get = await app.request("/api/spaces/space_aaaaaaaa/backups", {
    headers: HEADERS,
  });
  expect(get.status).toBe(501);
});

test("POST returns 501 when the artifact store seam is not wired", async () => {
  const { app } = await makeApp({ withArtifactStore: false });
  const response = await app.request("/api/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });
  expect(response.status).toBe(501);
  expect((await response.json()).error.code).toBe("not_implemented");
});
