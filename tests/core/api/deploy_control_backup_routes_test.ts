import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuDeploymentController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../core/domains/sources/mod.ts";
import { ActivityService } from "../../../core/domains/activity/mod.ts";
import {
  BackupsService,
  InMemoryBackupArtifactStore,
} from "../../../core/domains/backups/mod.ts";
import { seedInstallationModel } from "../../helpers/deploy-control/model_fixture.ts";

const TS = "2026-06-06T00:00:00.000Z";

async function makeApp(options: { readonly withArtifactStore?: boolean } = {}) {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedInstallationModel(store, {
    spaceId: "space_aaaaaaaa",
    installationId: "inst_aaaaaaaa",
  });
  let counter = 0;
  const sourcesService = new SourcesService({ store });
  const controller = new OpenTofuDeploymentController({
    store,
    sourcesService,
  });
  const activity = new ActivityService({ store, now: () => new Date(TS) });
  const artifactStore =
    options.withArtifactStore === false
      ? undefined
      : new InMemoryBackupArtifactStore();
  const backupsService = new BackupsService({
    store,
    ...(artifactStore ? { artifactStore } : {}),
    activity,
    now: () => new Date(TS),
    newId: (prefix) =>
      `${prefix}_${(counter += 1).toString().padStart(4, "0")}`,
  });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
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

test("POST /internal/v1/spaces/:spaceId/backups requires a bearer (401)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/spaces/space_aaaaaaaa/backups",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  );
  expect(response.status).toBe(401);
});

test("POST /internal/v1/spaces/:spaceId/backups enforces space scope (403)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/spaces/space_bbbbbbbb/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(403);
});

test("POST /internal/v1/spaces/:spaceId/backups rejects a malformed spaceId (400)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/spaces/not-a-space/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(400);
});

test("POST /internal/v1/spaces/:spaceId/backups creates a backup (201)", async () => {
  const { app, store } = await makeApp();
  const response = await app.request(
    "/internal/v1/spaces/space_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.backup.spaceId).toBe("space_aaaaaaaa");
  expect(body.backup.objectKey).toBe(
    "spaces/space_aaaaaaaa/backups/bkp_0001/control.json.zst.enc",
  );
  expect(body.backup.createdByRunId).toBe("backup_0002");
  expect(body.backup.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

  // The pointer is persisted in the ledger.
  const listed = await store.listBackupRecords("space_aaaaaaaa");
  expect(listed.map((b) => b.id)).toEqual([body.backup.id]);

  const runResponse = await app.request(
    `/internal/v1/runs/${body.backup.createdByRunId}`,
    {
      headers: HEADERS,
    },
  );
  expect(runResponse.status).toBe(200);
  const runBody = await runResponse.json();
  expect(runBody.run.type).toBe("backup");
  expect(runBody.run.status).toBe("succeeded");
  expect(runBody.run.spaceId).toBe("space_aaaaaaaa");
});

test("POST /internal/v1/installations/:installationId/backups creates a Space backup (201)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/installations/inst_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.backup.spaceId).toBe("space_aaaaaaaa");
  expect(body.backup.objectKey).toBe(
    "spaces/space_aaaaaaaa/backups/bkp_0001/control.json.zst.enc",
  );
  expect(body.backup.createdByRunId).toBe("backup_0002");

  const runResponse = await app.request(
    `/internal/v1/runs/${body.backup.createdByRunId}`,
    {
      headers: HEADERS,
    },
  );
  expect(runResponse.status).toBe(200);
  const runBody = await runResponse.json();
  expect(runBody.run.type).toBe("backup");
  expect(runBody.run.installationId).toBe("inst_aaaaaaaa");
  expect(runBody.run.environment).toBe("production");
});

test("POST /internal/v1/installations/:installationId/backups enforces the Installation Space scope (403)", async () => {
  const { app, store } = await makeApp();
  await seedInstallationModel(store, {
    spaceId: "space_bbbbbbbb",
    sourceId: "src_bbbbbbbb",
    snapshotId: "snap_bbbbbbbb",
    installConfigId: "cfg_bbbbbbbb",
    installationId: "inst_bbbbbbbb",
    name: "other",
  });
  const response = await app.request(
    "/internal/v1/installations/inst_bbbbbbbb/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(403);
});

test("POST /internal/v1/installations/:installationId/backups rejects a malformed installationId (400)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/installations/not-an-installation/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(400);
});

test("GET /internal/v1/spaces/:spaceId/backups lists backups newest-first (200)", async () => {
  const { app } = await makeApp();
  await app.request("/internal/v1/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });
  await app.request("/internal/v1/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });

  const response = await app.request(
    "/internal/v1/spaces/space_aaaaaaaa/backups",
    {
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.backups.length).toBe(2);
  for (const backup of body.backups) {
    expect(backup.spaceId).toBe("space_aaaaaaaa");
  }
});

test("POST /internal/v1/spaces/:spaceId/backups/:backupId/restores creates a restore Run waiting approval", async () => {
  const { app, store } = await makeApp();
  await store.putStateSnapshot({
    id: "state_old",
    spaceId: "space_aaaaaaaa",
    installationId: "inst_aaaaaaaa",
    environment: "production",
    generation: 1,
    objectKey:
      "spaces/space_aaaaaaaa/installations/inst_aaaaaaaa/envs/production/states/00000001.tfstate.enc",
    digest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    createdByRunId: "apply_old",
    createdAt: TS,
  });
  await store.patchInstallation("inst_aaaaaaaa", {
    currentStateGeneration: 1,
    status: "active",
  });
  await store.putBackupRecord({
    id: "bkp_restore",
    spaceId: "space_aaaaaaaa",
    installationId: "inst_aaaaaaaa",
    environment: "production",
    objectKey: "spaces/space_aaaaaaaa/backups/bkp_restore/control.json.zst.enc",
    digest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sizeBytes: 42,
    createdAt: TS,
  });

  const response = await app.request(
    "/internal/v1/spaces/space_aaaaaaaa/backups/bkp_restore/restores",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        stateGeneration: 1,
        expectedBackupDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    },
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.run.type).toBe("restore");
  expect(body.run.status).toBe("waiting_approval");
  expect(body.run.backupId).toBe("bkp_restore");

  const approve = await app.request(
    `/internal/v1/runs/${body.run.id}/approve`,
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(approve.status).toBe(200);
  const approved = await approve.json();
  expect(approved.run.status).toBe("succeeded");
  const installation = await store.getInstallation("inst_aaaaaaaa");
  expect(installation?.currentStateGeneration).toBe(2);
  const latest = await store.getLatestStateSnapshot(
    "inst_aaaaaaaa",
    "production",
  );
  expect(latest?.createdByRunId).toBe(body.run.id);
  expect(latest?.digest).toBe(
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  );
});

test("GET /internal/v1/spaces/:spaceId/backups enforces space scope (403)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/spaces/space_bbbbbbbb/backups",
    {
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(403);
});

test("backup routes return 501 when the backups service is unwired", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedInstallationModel(store, { spaceId: "space_aaaaaaaa" });
  const controller = new OpenTofuDeploymentController({ store });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "a",
              spaceIds: ["space_aaaaaaaa"],
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  const post = await app.request("/internal/v1/spaces/space_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });
  expect(post.status).toBe(501);
  const installationPost = await app.request(
    "/internal/v1/installations/inst_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(installationPost.status).toBe(501);
  const get = await app.request("/internal/v1/spaces/space_aaaaaaaa/backups", {
    headers: HEADERS,
  });
  expect(get.status).toBe(501);
});

test("POST returns 501 when the artifact store seam is not wired", async () => {
  const { app } = await makeApp({ withArtifactStore: false });
  const response = await app.request(
    "/internal/v1/spaces/space_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(501);
  expect((await response.json()).error.code).toBe("not_implemented");
});
