import { expect, test } from "bun:test";

import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { createApiApp } from "../../../core/api/app.ts";
import {
  OpenTofuController,
  type OpenTofuRunner,
} from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import {
  SourcesService,
  type ReadCapsuleSourceFiles,
} from "../../../core/domains/sources/mod.ts";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { SourceSnapshot } from "takosumi-contract/sources";

function makeApp() {
  return makeAppWithStore().then(({ app }) => app);
}

async function makeAppWithStore(
  options: {
    readonly readCapsuleSourceFiles?: ReadCapsuleSourceFiles;
    readonly runner?: OpenTofuRunner;
  } = {},
) {
  const store = new InMemoryOpenTofuControlStore();
  let counter = 0;
  const sourcesService = new SourcesService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    readCapsuleSourceFiles: options.readCapsuleSourceFiles,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    newId: (prefix) =>
      `${prefix}_route${(counter += 1).toString().padStart(10, "0")}`,
    newHookSecret: () => "whk_route_secret",
  });
  const controller = new OpenTofuController({
    store,
    sourcesService,
    ...(options.runner ? { runner: options.runner } : {}),
  });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_1",
              workspaceIds: ["ws_001"],
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
      workspaceId: "ws_001",
      name: "r",
      url: "https://github.com/a/b",
    }),
  });
  expect(response.status).toBe(401);
});

test("stable tag and SourceSnapshot presentation-file routes are authenticated and runner-backed", async () => {
  const stableJobs: unknown[] = [];
  const fileJobs: unknown[] = [];
  const runner: OpenTofuRunner = {
    plan: () => {
      throw new Error("not used");
    },
    apply: () => {
      throw new Error("not used");
    },
    resolveStableSourceTag: (job) => {
      stableJobs.push(job);
      return Promise.resolve({
        tag: "v1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
      });
    },
    readSourceSnapshotPresentationFile: (job) => {
      fileJobs.push(job);
      return Promise.resolve({
        path: job.path,
        text: '{"kind":"CapsuleSourceOptions"}\n',
        digest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 32,
      });
    },
  };
  const { app, store } = await makeAppWithStore({ runner });
  const created = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: "ws_001",
      name: "options",
      url: "https://github.com/acme/catalog.git",
    }),
  });
  const { source } = await created.json();
  const snapshot: SourceSnapshot = {
    id: "snap_options00000001",
    origin: "git",
    workspaceId: "ws_001",
    sourceId: source.id,
    url: source.url,
    ref: "0123456789abcdef0123456789abcdef01234567",
    resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
    path: ".",
    archiveRef: "workspaces/ws_001/options/source.tar.zst",
    archiveDigest:
      "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    archiveSizeBytes: 123,
    fetchedByRunId: "ssr_options00000001",
    fetchedAt: "2026-07-19T00:00:00.000Z",
  };
  await store.putSourceSnapshot(snapshot);

  const unauthenticated = await app.request(
    `/internal/v1/sources/${source.id}/snapshots/${snapshot.id}/file?path=install/options.json`,
  );
  expect(unauthenticated.status).toBe(401);

  const file = await app.request(
    `/internal/v1/sources/${source.id}/snapshots/${snapshot.id}/file?path=install/options.json`,
    { headers: { authorization: "Bearer scoped-token" } },
  );
  expect(file.status).toBe(200);
  expect(await file.json()).toMatchObject({
    sourceSnapshotId: snapshot.id,
    path: "install/options.json",
    digest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 32,
  });
  expect(fileJobs).toHaveLength(1);

  const stable = await app.request(
    "/internal/v1/workspaces/ws_001/source-ref-resolutions/stable-semver",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ url: "https://github.com/acme/catalog.git" }),
    },
  );
  expect(stable.status).toBe(200);
  expect(await stable.json()).toEqual({
    tag: "v1.2.3",
    commit: "0123456789abcdef0123456789abcdef01234567",
  });
  expect(stableJobs).toHaveLength(1);

  const denied = await app.request(
    "/internal/v1/workspaces/ws_denied/source-ref-resolutions/stable-semver",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ url: "https://github.com/acme/catalog.git" }),
    },
  );
  expect(denied.status).toBe(403);
});

test("POST /internal/v1/sources rejects an unknown field (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: "ws_001",
      name: "r",
      url: "https://github.com/a/b",
      sneaky: 1,
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});

test("POST /internal/v1/sources enforces workspace scope (403)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: "ws_denied",
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
      workspaceId: "ws_001",
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
      workspaceId: "ws_001",
      name: "r",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  // The hook secret is returned exactly once at creation.
  expect(createdBody.hookSecret).toBe("whk_route_secret");
  const sourceId = createdBody.source.id;

  const list = await app.request("/internal/v1/sources?workspaceId=ws_001", {
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

  const snaps = await app.request(
    `/internal/v1/sources/${sourceId}/snapshots`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(snaps.status).toBe(200);
  expect((await snaps.json()).snapshots).toEqual([]);
});

test("source compatibility-check creates and reads a Capsule report", async () => {
  const { app, store } = await makeAppWithStore();
  const created = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: "ws_001",
      name: "r",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(created.status).toBe(201);
  const { source } = await created.json();
  const snapshot: SourceSnapshot = {
    id: "snap_route0000000001",
    origin: "git",
    sourceId: source.id,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "abc123",
    path: source.defaultPath,
    archiveRef: `workspaces/ws_001/sources/${source.id}/snapshots/snap_route0000000001/source.tar.zst`,
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
  });
  expect(checkedBody.report).not.toHaveProperty("normalizedObjectKey");
  expect(checkedBody.report).not.toHaveProperty("normalizedDigest");
  const compatibilityRunId = checkedBody.run.id;
  expect(compatibilityRunId).toMatch(/^ccr_/);
  expect(checkedBody.run).toMatchObject({
    id: compatibilityRunId,
    workspaceId: "ws_001",
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

  const logs = await app.request(
    `/internal/v1/runs/${compatibilityRunId}/logs`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(logs.status).toBe(200);
  expect(await logs.json()).toEqual({ diagnostics: [], auditEvents: [] });

  const events = await app.request(
    `/internal/v1/runs/${compatibilityRunId}/events`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
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

  const cancel = await app.request(
    `/internal/v1/runs/${compatibilityRunId}/cancel`,
    {
      method: "POST",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(cancel.status).toBe(409);
  expect((await cancel.json()).error.code).toBe("failed_precondition");
});

test("GET /internal/v1/compatibility-reports resolves owner from sourceSnapshot and enforces workspace scope", async () => {
  const { app, store } = await makeAppWithStore();
  await store.putSource({
    id: "src_denied00000001",
    workspaceId: "ws_002",
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
    sourceId: "src_denied00000001",
    url: "https://github.com/acme/denied.git",
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef:
      "workspaces/ws_002/sources/src_denied00000001/snapshots/snap_denied00000001/source.tar.zst",
    archiveDigest: "sha256:sourcearchive",
    archiveSizeBytes: 42,
    fetchedByRunId: "ssr_denied00000001",
    fetchedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putSourceSnapshot(snapshot);
  const report: CapsuleCompatibilityReport = {
    id: "caprep_denied00000001",
    sourceId: "src_denied00000001",
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

  const got = await app.request(
    `/internal/v1/compatibility-reports/${report.id}`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(got.status).toBe(403);
});

test("source snapshot file read is source-scoped and selects the requested JSON file", async () => {
  const observedJobs: Array<{
    readonly path: string;
    readonly sourceSnapshot: SourceSnapshot;
  }> = [];
  const { app, store } = await makeAppWithStore({
    runner: {
      plan: () => {
        throw new Error("not used");
      },
      apply: () => {
        throw new Error("not used");
      },
      readSourceSnapshotPresentationFile: async (job) => {
        observedJobs.push(job);
        return {
          path: job.path,
          text: '{"kind":"CapsuleComposition"}',
          digest: `sha256:${"c".repeat(64)}`,
          sizeBytes: 29,
        };
      },
    },
  });
  const created = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: "ws_001",
      name: "composition",
      url: "https://github.com/tako0614/takoform.git",
    }),
  });
  expect(created.status).toBe(201);
  const { source } = await created.json();
  const snapshot: SourceSnapshot = {
    id: "snap_composition00001",
    origin: "git",
    sourceId: source.id,
    workspaceId: "ws_001",
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: "workspaces/ws_001/source.tar.zst",
    archiveDigest: "sha256:sourcearchive",
    archiveSizeBytes: 42,
    fetchedByRunId: "ssr_composition00001",
    fetchedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putSourceSnapshot(snapshot);

  const response = await app.request(
    `/internal/v1/sources/${source.id}/snapshots/${snapshot.id}/file?path=compositions/yurucommu-standalone.json`,
    { headers: { authorization: "Bearer scoped-token" } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    sourceSnapshotId: snapshot.id,
    path: "compositions/yurucommu-standalone.json",
    text: '{"kind":"CapsuleComposition"}',
  });
  expect(observedJobs).toHaveLength(1);
  expect(observedJobs[0]?.path).toBe("compositions/yurucommu-standalone.json");
  expect(observedJobs[0]?.sourceSnapshot.id).toBe(snapshot.id);
});

test("source compatibility-check analyzes expanded OpenTofu files at modulePath when available", async () => {
  const sourceFileReadOptions: unknown[] = [];
  const { app, store } = await makeAppWithStore({
    readCapsuleSourceFiles: (_snapshot, options) => {
      sourceFileReadOptions.push(options);
      return Promise.resolve([
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
      ]);
    },
  });
  const created = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: "ws_001",
      name: "r",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(created.status).toBe(201);
  const { source } = await created.json();
  const snapshot: SourceSnapshot = {
    id: "snap_route0000000001",
    origin: "git",
    sourceId: source.id,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "abc123",
    path: source.defaultPath,
    archiveRef: `workspaces/ws_001/sources/${source.id}/snapshots/snap_route0000000001/source.tar.zst`,
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
      body: JSON.stringify({
        sourceSnapshotId: snapshot.id,
        modulePath: "deploy/opentofu",
      }),
    },
  );
  expect(checked.status).toBe(201);
  expect(sourceFileReadOptions).toEqual([
    {
      modulePath: "deploy/opentofu",
      runId: "ccr_route0000000002",
    },
  ]);
  const checkedBody = await checked.json();
  expect(checkedBody.report).toMatchObject({
    level: "ready",
    findings: [],
    providers: [{ source: "hashicorp/aws", aliases: [], allowed: true }],
    resources: [{ type: "aws_s3_bucket", count: 1, allowed: true }],
  });

  sourceFileReadOptions.length = 0;
  const rootChecked = await app.request(
    `/internal/v1/sources/${source.id}/compatibility-check`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        sourceSnapshotId: snapshot.id,
        modulePath: ".",
      }),
    },
  );
  expect(rootChecked.status).toBe(201);
  expect(sourceFileReadOptions).toEqual([
    {
      runId: "ccr_route0000000004",
    },
  ]);
});

test("PATCH /internal/v1/sources updates fields", async () => {
  const app = await makeApp();
  const created = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: "ws_001",
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
  const response = await app.request(
    "/internal/v1/sources/not-a-source/snapshots",
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(response.status).toBe(400);
});

test("GET /internal/v1/sources requires workspaceId (400)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/sources", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(400);
});
