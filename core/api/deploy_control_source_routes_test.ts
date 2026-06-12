import { expect, test } from "bun:test";

import { createApiApp } from "./app.ts";
import { OpenTofuDeploymentController } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import {
  SourcesService,
  type ReadCapsuleSourceFiles,
} from "../domains/sources/mod.ts";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { SourceSnapshot } from "takosumi-contract/sources";

function makeApp() {
  return makeAppWithStore().then(({ app }) => app);
}

async function makeAppWithStore(
  options: {
    readonly readCapsuleSourceFiles?: ReadCapsuleSourceFiles;
  } = {},
) {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const sourcesService = new SourcesService({
    store,
    readCapsuleSourceFiles: options.readCapsuleSourceFiles,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    newId: (prefix) =>
      `${prefix}_route${(counter += 1).toString().padStart(10, "0")}`,
    newHookSecret: () => "whk_route_secret",
  });
  const controller = new OpenTofuDeploymentController({
    store,
    sourcesService,
  });
  const app = await createApiApp({
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
  return { app, store };
}

const HEADERS = {
  authorization: "Bearer scoped-token",
  "content-type": "application/json",
} as const;

test("POST /internal/v1/sources requires a bearer (401)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/sources", {
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

test("POST /internal/v1/sources rejects an unknown field (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/sources", {
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

test("POST /internal/v1/sources enforces space scope (403)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/sources", {
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

test("POST /internal/v1/sources rejects a forbidden URL (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/sources", {
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
  const created = await app.request("/internal/v1/sources", {
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

  const list = await app.request("/internal/v1/sources?spaceId=space_1", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect((await list.json()).sources).toHaveLength(1);

  const got = await app.request(`/internal/v1/sources/${sourceId}`, {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(got.status).toBe(200);
  // The hook secret hash is never projected.
  expect(await got.text()).not.toContain("hookSecretHash");

  const synced = await app.request(`/internal/v1/sources/${sourceId}/sync`, {
    method: "POST",
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(synced.status).toBe(201);
  expect((await synced.json()).run.status).toBe("queued");

  const snaps = await app.request(`/internal/v1/sources/${sourceId}/snapshots`, {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(snaps.status).toBe(200);
  expect((await snaps.json()).snapshots).toEqual([]);
});

test("source compatibility-check creates and reads a Capsule report", async () => {
  const { app, store } = await makeAppWithStore();
  const created = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      name: "r",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(created.status).toBe(201);
  const { source } = await created.json();
  const snapshot: SourceSnapshot = {
    id: "snap_route0000000001",
    sourceId: source.id,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "abc123",
    path: source.defaultPath,
    archiveObjectKey: `spaces/space_1/sources/${source.id}/snapshots/snap_route0000000001/source.tar.zst`,
    archiveDigest: "sha256:sourcearchive",
    archiveSizeBytes: 42,
    fetchedByRunId: "ssr_route0000000001",
    fetchedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putSourceSnapshot(snapshot);

  const checked = await app.request(
    `/internal/v1/sources/${source.id}/compatibility-check`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ sourceSnapshotId: snapshot.id }),
    },
  );
  expect(checked.status).toBe(201);
  const checkedBody = await checked.json();
  expect(checkedBody.report).toMatchObject({
    sourceId: source.id,
    sourceSnapshotId: snapshot.id,
    level: "needs_patch",
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    normalizedObjectKey: snapshot.archiveObjectKey,
    normalizedDigest: snapshot.archiveDigest,
  });
  const compatibilityRunId = checkedBody.run.id;
  expect(compatibilityRunId).toMatch(/^ccr_/);
  expect(checkedBody.run).toMatchObject({
    id: compatibilityRunId,
    spaceId: "space_1",
    sourceId: source.id,
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: snapshot.id,
    compatibilityReportId: checkedBody.report.id,
  });
  expect(checkedBody.report.findings).toEqual([
    expect.objectContaining({
      severity: "warning",
      code: "capsule_source_files_unavailable",
    }),
  ]);
  expect(checkedBody.report.compatibility).toBeUndefined();
  expect(checkedBody.report.normalizedArtifactKey).toBeUndefined();

  const got = await app.request(
    `/internal/v1/compatibility-reports/${checkedBody.report.id}`,
    { headers: { authorization: "Bearer scoped-token" } },
  );
  expect(got.status).toBe(200);
  expect((await got.json()).report.id).toBe(checkedBody.report.id);

  const run = await app.request(`/internal/v1/runs/${compatibilityRunId}`, {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(run.status).toBe(200);
  const runBody = await run.json();
  expect(runBody.run).toMatchObject({
    id: compatibilityRunId,
    type: "compatibility_check",
    compatibilityReportId: checkedBody.report.id,
  });

  const logs = await app.request(`/internal/v1/runs/${compatibilityRunId}/logs`, {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(logs.status).toBe(200);
  expect(await logs.json()).toEqual({ diagnostics: [], auditEvents: [] });

  const events = await app.request(`/internal/v1/runs/${compatibilityRunId}/events`, {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(events.status).toBe(200);
  expect(await events.json()).toEqual({ auditEvents: [] });

  const approve = await app.request(
    `/internal/v1/runs/${compatibilityRunId}/approve`,
    {
      method: "POST",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(approve.status).toBe(409);
  expect((await approve.json()).error.code).toBe("failed_precondition");

  const cancel = await app.request(`/internal/v1/runs/${compatibilityRunId}/cancel`, {
    method: "POST",
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(cancel.status).toBe(409);
  expect((await cancel.json()).error.code).toBe("failed_precondition");
});

test("GET /internal/v1/compatibility-reports resolves owner from sourceSnapshot and enforces space scope", async () => {
  const { app, store } = await makeAppWithStore();
  await store.putSource({
    id: "src_denied00000001",
    spaceId: "space_2",
    name: "denied",
    url: "https://github.com/acme/denied.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    hookSecretHash: "sha256:hook",
    autoSync: false,
  });
  const snapshot: SourceSnapshot = {
    id: "snap_denied00000001",
    origin: "git",
    spaceId: "space_2",
    sourceId: "src_denied00000001",
    url: "https://github.com/acme/denied.git",
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey:
      "spaces/space_2/sources/src_denied00000001/snapshots/snap_denied00000001/source.tar.zst",
    archiveDigest: "sha256:sourcearchive",
    archiveSizeBytes: 42,
    fetchedByRunId: "ssr_denied00000001",
    fetchedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putSourceSnapshot(snapshot);
  const report: CapsuleCompatibilityReport = {
    id: "caprep_denied00000001",
    sourceSnapshotId: snapshot.id,
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putCapsuleCompatibilityReport(report);

  const got = await app.request(`/internal/v1/compatibility-reports/${report.id}`, {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(got.status).toBe(403);
});

test("source compatibility-check analyzes expanded OpenTofu files when available", async () => {
  const { app, store } = await makeAppWithStore({
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

resource "aws_s3_bucket" "attachments" {
  bucket = "attachments"
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}
`,
        },
      ]),
  });
  const created = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      name: "r",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(created.status).toBe(201);
  const { source } = await created.json();
  const snapshot: SourceSnapshot = {
    id: "snap_route0000000001",
    sourceId: source.id,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "abc123",
    path: source.defaultPath,
    archiveObjectKey: `spaces/space_1/sources/${source.id}/snapshots/snap_route0000000001/source.tar.zst`,
    archiveDigest: "sha256:sourcearchive",
    archiveSizeBytes: 42,
    fetchedByRunId: "ssr_route0000000001",
    fetchedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putSourceSnapshot(snapshot);

  const checked = await app.request(
    `/internal/v1/sources/${source.id}/compatibility-check`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ sourceSnapshotId: snapshot.id }),
    },
  );
  expect(checked.status).toBe(201);
  const checkedBody = await checked.json();
  expect(checkedBody.report).toMatchObject({
    level: "ready",
    findings: [],
    providers: [{ source: "hashicorp/aws", aliases: [], allowed: true }],
    resources: [{ type: "aws_s3_bucket", count: 1, allowed: true }],
  });
});

test("PATCH /internal/v1/sources updates fields", async () => {
  const app = await makeApp();
  const created = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_1",
      name: "r",
      url: "https://github.com/acme/repo.git",
    }),
  });
  const { source } = await created.json();
  const patched = await app.request(`/internal/v1/sources/${source.id}`, {
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
  const response = await app.request("/internal/v1/sources/not-a-source/snapshots", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(400);
});

test("GET /internal/v1/sources requires spaceId (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/sources", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(400);
});
