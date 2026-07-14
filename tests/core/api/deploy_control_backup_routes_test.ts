import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../core/domains/sources/mod.ts";
import { ActivityService } from "../../../core/domains/activity/mod.ts";
import {
  BackupsService,
  InMemoryBackupArtifactStore,
} from "../../../core/domains/backups/mod.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";

const TS = "2026-06-06T00:00:00.000Z";

async function makeApp(options: { readonly withArtifactStore?: boolean } = {}) {
  const store = new InMemoryOpenTofuControlStore();
  await seedCapsuleModel(store, {
    workspaceId: "ws_aaaaaaaa",
    capsuleId: "cap_aaaaaaaa",
  });
  let counter = 0;
  const artifactReferenceAllocator = new ObjectKeyArtifactReferenceAllocator();
  const sourcesService = new SourcesService({
    store,
    artifactReferenceAllocator,
  });
  const controller = new OpenTofuController({
    store,
    sourcesService,
    artifactReferenceAllocator,
  });
  const activity = new ActivityService({ store, now: () => new Date(TS) });
  const artifactStore =
    options.withArtifactStore === false
      ? undefined
      : new InMemoryBackupArtifactStore();
  const backupsService = new BackupsService({
    store,
    artifactReferenceAllocator,
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
              workspaceIds: ["ws_aaaaaaaa"],
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

test("POST /internal/v1/workspaces/:workspaceId/backups requires a bearer (401)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/workspaces/ws_aaaaaaaa/backups",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  );
  expect(response.status).toBe(401);
});

test("POST /internal/v1/workspaces/:workspaceId/backups enforces Workspace scope (403)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/workspaces/ws_bbbbbbbb/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(403);
});

test("POST /internal/v1/workspaces/:workspaceId/backups rejects a malformed workspaceId (400)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/workspaces/not-a-space/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(400);
});

test("POST /internal/v1/workspaces/:workspaceId/backups creates a backup (201)", async () => {
  const { app, store } = await makeApp();
  const response = await app.request(
    "/internal/v1/workspaces/ws_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.backup.workspaceId).toBe("ws_aaaaaaaa");
  expect(body.backup.ref).toBe(
    "workspaces/ws_aaaaaaaa/backups/bkp_0001/control.json.zst.enc",
  );
  expect(body.backup.createdByRunId).toBe("backup_0002");
  expect(body.backup.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

  // The pointer is persisted in the ledger.
  const listed = await store.listBackupRecords("ws_aaaaaaaa");
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
  expect(runBody.run.workspaceId).toBe("ws_aaaaaaaa");
});

test("POST /internal/v1/capsules/:capsuleId/backups creates a Workspace backup (201)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/capsules/cap_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.backup.workspaceId).toBe("ws_aaaaaaaa");
  expect(body.backup.ref).toBe(
    "workspaces/ws_aaaaaaaa/backups/bkp_0001/control.json.zst.enc",
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
  expect(runBody.run.capsuleId).toBe("cap_aaaaaaaa");
  expect(runBody.run.environment).toBe("production");
});

test("POST /internal/v1/capsules/:capsuleId/backups enforces the Capsule Workspace scope (403)", async () => {
  const { app, store } = await makeApp();
  await seedCapsuleModel(store, {
    workspaceId: "ws_bbbbbbbb",
    sourceId: "src_bbbbbbbb",
    snapshotId: "snap_bbbbbbbb",
    installConfigId: "cfg_bbbbbbbb",
    capsuleId: "cap_bbbbbbbb",
    name: "other",
  });
  const response = await app.request(
    "/internal/v1/capsules/cap_bbbbbbbb/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(403);
});

test("POST /internal/v1/capsules/:capsuleId/backups rejects a malformed capsuleId (400)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/capsules/not-an-capsule/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(400);
});

test("GET /internal/v1/workspaces/:workspaceId/backups lists backups newest-first (200)", async () => {
  const { app } = await makeApp();
  await app.request("/internal/v1/workspaces/ws_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });
  await app.request("/internal/v1/workspaces/ws_aaaaaaaa/backups", {
    method: "POST",
    headers: HEADERS,
  });

  const response = await app.request(
    "/internal/v1/workspaces/ws_aaaaaaaa/backups",
    {
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.backups.length).toBe(2);
  for (const backup of body.backups) {
    expect(backup.workspaceId).toBe("ws_aaaaaaaa");
  }
});

test("POST /internal/v1/workspaces/:workspaceId/backups/:backupId/restores creates a restore Run waiting approval", async () => {
  const { app, store } = await makeApp();
  await store.putStateVersion({
    id: "state_old",
    workspaceId: "ws_aaaaaaaa",
    capsuleId: "cap_aaaaaaaa",
    environment: "production",
    generation: 1,
    stateRef:
      "workspaces/ws_aaaaaaaa/capsules/cap_aaaaaaaa/environments/production/state-versions/00000001.tfstate.enc",
    digest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    createdByRunId: "apply_old",
    createdAt: TS,
  });
  await store.patchCapsule("cap_aaaaaaaa", {
    currentStateGeneration: 1,
    status: "active",
  });
  await store.putBackupRecord({
    id: "bkp_restore",
    workspaceId: "ws_aaaaaaaa",
    capsuleId: "cap_aaaaaaaa",
    environment: "production",
    ref: "workspaces/ws_aaaaaaaa/backups/bkp_restore/control.json.zst.enc",
    digest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sizeBytes: 42,
    createdAt: TS,
  });

  const response = await app.request(
    "/internal/v1/workspaces/ws_aaaaaaaa/backups/bkp_restore/restores",
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
  const capsule = await store.getCapsule("cap_aaaaaaaa");
  expect(capsule?.currentStateGeneration).toBe(2);
  const latest = await store.getLatestStateVersion(
    "cap_aaaaaaaa",
    "production",
  );
  expect(latest?.createdByRunId).toBe(body.run.id);
  expect(latest?.digest).toBe(
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  );
});

test("GET /internal/v1/workspaces/:workspaceId/backups enforces Workspace scope (403)", async () => {
  const { app } = await makeApp();
  const response = await app.request(
    "/internal/v1/workspaces/ws_bbbbbbbb/backups",
    {
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(403);
});

test("backup routes return 501 when the backups service is unwired", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedCapsuleModel(store, {
    workspaceId: "ws_aaaaaaaa",
    capsuleId: "cap_aaaaaaaa",
  });
  const controller = new OpenTofuController({ store });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "a",
              workspaceIds: ["ws_aaaaaaaa"],
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  const post = await app.request(
    "/internal/v1/workspaces/ws_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(post.status).toBe(501);
  const capsulePost = await app.request(
    "/internal/v1/capsules/cap_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(capsulePost.status).toBe(501);
  const get = await app.request("/internal/v1/workspaces/ws_aaaaaaaa/backups", {
    headers: HEADERS,
  });
  expect(get.status).toBe(501);
});

test("POST returns 501 when the artifact store seam is not wired", async () => {
  const { app } = await makeApp({ withArtifactStore: false });
  const response = await app.request(
    "/internal/v1/workspaces/ws_aaaaaaaa/backups",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(501);
  expect((await response.json()).error.code).toBe("not_implemented");
});
