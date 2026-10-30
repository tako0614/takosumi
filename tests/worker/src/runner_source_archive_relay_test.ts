import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import type {
  CloudflareWorkerEnv,
  R2Bucket,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "../../../worker/src/bindings.ts";
import {
  type ContainerRequestFetcher,
  OpenTofuRunnerObject,
} from "../../../worker/src/durable/OpenTofuRunnerObject.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const ARCHIVE_BYTES = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03,
]);
const ARCHIVE_KEY =
  "workspaces/spc_1/sources/src_1/snapshots/snap_1/source.tar.zst";
const RESOLVED_COMMIT = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";

test("source archive cleanup deletes only the terminal Run's unreferenced allocation", async () => {
  const db = new SqliteFakeD1();
  await db.exec("create table runs (id text, space_id text, source_id text, type text, status text, lease_token text, run_json text); create table source_snapshots (id text, source_id text, record_json text)");
  const runId = "sync_cleanup";
  const allocated = "workspaces/spc_1/sources/src_1/snapshots/snap_new/source.tar.zst";
  const canonical = ARCHIVE_KEY;
  const run = { id: runId, workspaceId: "spc_1", sourceId: "src_1", kind: "source_sync",
    status: "succeeded", archiveRef: allocated, requestedSnapshotId: "snap_new",
    snapshotId: "snap_1", finishedAt: "2026-06-06T00:00:10.000Z" };
  await db.prepare("insert into runs values (?, ?, ?, ?, ?, ?, ?)")
    .bind(runId, "spc_1", "src_1", "source_sync", "succeeded", null, JSON.stringify(run)).run();
  await db.prepare("insert into source_snapshots values (?, ?, ?)")
    .bind("snap_1", "src_1", JSON.stringify({ id: "snap_1", sourceId: "src_1", workspaceId: "spc_1", archiveRef: canonical })).run();
  const source = new FakeR2Bucket();
  await source.put(allocated, ARCHIVE_BYTES, { customMetadata: { "takosumi-run-id": runId } });
  await source.put(canonical, ARCHIVE_BYTES, { customMetadata: { "takosumi-run-id": "sync_old" } });
  const runner = runnerWithContainer(new FakeR2Bucket(), source, {
    async containerFetch() { throw new Error("cleanup must not start container"); },
  }, { TAKOSUMI_CONTROL_DB: db });
  const request = (archiveRef: string) => new Request(`https://runner/runs/${runId}/source-archive/cleanup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, workspaceId: "spc_1", sourceId: "src_1", archiveRef, canonicalSnapshotId: "snap_1" }),
  });
  expect((await runner.fetch(request(canonical))).status).toBe(503);
  expect(source.body(canonical)).toBeDefined();
  expect((await runner.fetch(request(allocated))).status).toBe(204);
  expect(source.body(allocated)).toBeUndefined();
  expect(source.body(canonical)).toBeDefined();
  expect((await runner.fetch(request(allocated))).status).toBe(204);
  await source.put(allocated, ARCHIVE_BYTES, { customMetadata: { "takosumi-run-id": runId } });
  await db.prepare("insert into source_snapshots values (?, ?, ?)")
    .bind("snap_shared", "src_1", JSON.stringify({ id: "snap_shared", sourceId: "src_1", workspaceId: "spc_1", archiveRef: allocated })).run();
  expect((await runner.fetch(request(allocated))).status).toBe(503);
  expect(source.body(allocated)).toBeDefined();
});

test("Source retirement deletes only owned R2 archives and preserves shared historical refs", async () => {
  const db = new SqliteFakeD1();
  await db.exec(`create table sources (id text, space_id text, status text, record_json text);
    create table capsules (id text, space_id text, source_id text, status text, record_json text);
    create table runs (id text, space_id text, source_id text, installation_id text, type text, status text, lease_token text, run_json text);
    create table source_snapshots (id text, source_id text, record_json text);
    create table audit_events (id text, action text, target_type text, target_id text)`);
  const sourceRecord = { id: "src_1", workspaceId: "spc_1", status: "disabled", autoSync: false,
    retiringAt: "2026-10-28T00:00:00.000Z", ownerCapsuleId: "cap_1" };
  await db.prepare("insert into sources values (?, ?, ?, ?)")
    .bind("src_1", "spc_1", "disabled", JSON.stringify(sourceRecord)).run();
  await db.prepare("insert into capsules (id, space_id, source_id, status, record_json) values (?, ?, ?, ?, ?)")
    .bind("cap_1", "spc_1", "src_1", "destroyed", JSON.stringify({ id: "cap_1", workspaceId: "spc_1",
      sourceId: "src_1", status: "destroyed" })).run();
  const archive = ARCHIVE_KEY;
  const orphan = "workspaces/spc_1/sources/src_1/snapshots/snap_orphan/source.tar.zst";
  await db.prepare("insert into source_snapshots values (?, ?, ?)")
    .bind("snap_1", "src_1", JSON.stringify({ id: "snap_1", sourceId: "src_1", workspaceId: "spc_1", archiveRef: archive })).run();
  await db.prepare("insert into runs (id, space_id, source_id, type, status, lease_token, run_json) values (?, ?, ?, ?, ?, ?, ?)")
    .bind("sync_orphan", "spc_1", "src_1", "source_sync", "failed", null,
      JSON.stringify({ id: "sync_orphan", workspaceId: "spc_1", sourceId: "src_1", kind: "source_sync", archiveRef: orphan })).run();
  const bucket = new FakeR2Bucket();
  await bucket.put(archive, ARCHIVE_BYTES);
  await bucket.put(orphan, ARCHIVE_BYTES);
  const runner = runnerWithContainer(new FakeR2Bucket(), bucket, {
    async containerFetch() { throw new Error("retirement must not start container"); },
  }, { TAKOSUMI_CONTROL_DB: db });
  const retire = (archiveRef: string) => runner.fetch(new Request("https://runner/sources/src_1/archive/retire", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "spc_1", sourceId: "src_1", archiveRef }),
  }));
  expect((await retire(orphan)).status).toBe(204);
  expect(bucket.body(orphan)).toBeUndefined();
  expect((await retire(orphan)).status).toBe(204);
  await db.prepare("insert into source_snapshots values (?, ?, ?)")
    .bind("foreign", "src_other", JSON.stringify({ id: "foreign", sourceId: "src_other", workspaceId: "spc_2", archiveRef: archive })).run();
  expect((await retire(archive)).status).toBe(503);
  expect(bucket.body(archive)).toBeDefined();
  await db.prepare("delete from source_snapshots where id = ?").bind("foreign").run();
  await db.prepare("insert into runs (id, space_id, source_id, type, status, lease_token, run_json) values (?, ?, ?, ?, ?, ?, ?)")
    .bind("sync_foreign", "spc_2", "src_other", "source_sync", "succeeded", null,
      JSON.stringify({ id: "sync_foreign", workspaceId: "spc_2", sourceId: "src_other", kind: "source_sync", archiveRef: archive })).run();
  expect((await retire(archive)).status).toBe(503);
  expect(bucket.body(archive)).toBeDefined();
  await db.prepare("delete from runs where id = ?").bind("sync_foreign").run();
  expect((await retire(archive)).status).toBe(204);
  expect(bucket.body(archive)).toBeUndefined();
});

test("an app-owned Source's apps-prefixed archives are in its retirement and cleanup custody (TASK-0118 P9.1-f)", async () => {
  const db = new SqliteFakeD1();
  await db.exec(`create table sources (id text, space_id text, status text, record_json text);
    create table capsules (id text, space_id text, source_id text, status text, record_json text);
    create table runs (id text, space_id text, source_id text, installation_id text, type text, status text, lease_token text, run_json text);
    create table source_snapshots (id text, source_id text, record_json text);
    create table audit_events (id text, action text, target_type text, target_id text)`);
  const sourceRecord = { id: "src_1", workspaceId: "spc_1", status: "disabled", autoSync: false,
    retiringAt: "2026-10-28T00:00:00.000Z", ownerCapsuleId: "cap_1" };
  await db.prepare("insert into sources values (?, ?, ?, ?)")
    .bind("src_1", "spc_1", "disabled", JSON.stringify(sourceRecord)).run();
  await db.prepare("insert into capsules (id, space_id, source_id, status, record_json) values (?, ?, ?, ?, ?)")
    .bind("cap_1", "spc_1", "src_1", "destroyed", JSON.stringify({ id: "cap_1", workspaceId: "spc_1",
      sourceId: "src_1", status: "destroyed" })).run();
  const appArchive = "apps/cap_1/sources/src_1/snapshots/snap_app/source.tar.zst";
  const legacyArchive = ARCHIVE_KEY;
  for (const [id, archiveRef] of [["snap_app", appArchive], ["snap_1", legacyArchive]] as const) {
    await db.prepare("insert into source_snapshots values (?, ?, ?)")
      .bind(id, "src_1", JSON.stringify({ id, sourceId: "src_1", workspaceId: "spc_1", archiveRef })).run();
  }
  const bucket = new FakeR2Bucket();
  await bucket.put(appArchive, ARCHIVE_BYTES);
  await bucket.put(legacyArchive, ARCHIVE_BYTES);
  const runner = runnerWithContainer(new FakeR2Bucket(), bucket, {
    async containerFetch() { throw new Error("retirement must not start container"); },
  }, { TAKOSUMI_CONTROL_DB: db });
  const retire = (archiveRefs: readonly string[]) => runner.fetch(new Request("https://runner/sources/src_1/archive/retire", {
    method: "POST", headers: { "content-type": "application/json" },
    // The request names no owner; the persisted Source supplies it.
    body: JSON.stringify({ workspaceId: "spc_1", sourceId: "src_1", archiveRefs }),
  }));
  // Another Capsule's apps prefix is outside this Source's custody.
  expect((await retire(["apps/cap_2/sources/src_1/snapshots/snap_app/source.tar.zst"])).status).toBe(503);
  // A foreign live reference to the apps-prefixed key still blocks deletion.
  await db.prepare("insert into source_snapshots values (?, ?, ?)")
    .bind("foreign", "src_other", JSON.stringify({ id: "foreign", sourceId: "src_other", workspaceId: "spc_1", archiveRef: appArchive })).run();
  expect((await retire([appArchive, legacyArchive])).status).toBe(503);
  expect(bucket.body(appArchive)).toBeDefined();
  await db.prepare("delete from source_snapshots where id = ?").bind("foreign").run();
  expect((await retire([appArchive, legacyArchive])).status).toBe(204);
  expect(bucket.body(appArchive)).toBeUndefined();
  expect(bucket.body(legacyArchive)).toBeUndefined();
  // Without an owner on the Source, its apps prefix is not in custody.
  await bucket.put(appArchive, ARCHIVE_BYTES);
  const { ownerCapsuleId: _owner, ...unowned } = sourceRecord;
  await db.prepare("update sources set record_json = ? where id = ?").bind(JSON.stringify(unowned), "src_1").run();
  expect((await retire([appArchive])).status).toBe(503);
  expect(bucket.body(appArchive)).toBeDefined();

  // Cleanup of an unused apps-prefixed allocation reads the owner from the Source.
  await db.prepare("update sources set record_json = ? where id = ?").bind(JSON.stringify(sourceRecord), "src_1").run();
  const allocated = "apps/cap_1/sources/src_1/snapshots/snap_new/source.tar.zst";
  const run = { id: "sync_cleanup", workspaceId: "spc_1", sourceId: "src_1", kind: "source_sync",
    status: "succeeded", archiveRef: allocated, requestedSnapshotId: "snap_new",
    snapshotId: "snap_app", finishedAt: "2026-06-06T00:00:10.000Z" };
  await db.prepare("insert into runs (id, space_id, source_id, type, status, lease_token, run_json) values (?, ?, ?, ?, ?, ?, ?)")
    .bind(run.id, "spc_1", "src_1", "source_sync", "succeeded", null, JSON.stringify(run)).run();
  await bucket.put(allocated, ARCHIVE_BYTES, { customMetadata: { "takosumi-run-id": run.id } });
  const cleanup = (archiveRef: string) => runner.fetch(new Request(`https://runner/runs/${run.id}/source-archive/cleanup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: run.id, workspaceId: "spc_1", sourceId: "src_1", archiveRef, canonicalSnapshotId: "snap_app" }),
  }));
  expect((await cleanup(allocated)).status).toBe(204);
  expect(bucket.body(allocated)).toBeUndefined();
});

test("the Runner capability probe reports what the image's health advertises and dispatches nothing (TASK-0118 P9.1-f)", async () => {
  for (const capabilities of [["takosumi.app-source-archive-roots@v1"], []]) {
    const calls: string[] = [];
    const runner = runnerWithContainer(new FakeR2Bucket(), new FakeR2Bucket(), {
      async containerFetch(request) {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ ok: true, capabilities });
      },
    });
    const response = await runner.fetch(new Request("https://runner/runner-capabilities"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ capabilities });
    expect(calls.every((call) => call === "GET /healthz")).toBe(true);
  }
});

test("Source retirement refuses live owners, active sync and unreferenced keys", async () => {
  const db = new SqliteFakeD1();
  await db.exec(`create table sources (id text, space_id text, status text, record_json text);
    create table capsules (id text, space_id text, source_id text, status text, record_json text);
    create table runs (id text, space_id text, source_id text, installation_id text, type text, status text, lease_token text, run_json text);
    create table source_snapshots (id text, source_id text, record_json text);
    create table audit_events (id text, action text, target_type text, target_id text)`);
  const sourceRecord = { id: "src_1", workspaceId: "spc_1", status: "disabled", autoSync: false,
    retiringAt: "2026-10-28T00:00:00.000Z", ownerCapsuleId: "cap_1" };
  await db.prepare("insert into sources values (?, ?, ?, ?)")
    .bind("src_1", "spc_1", "disabled", JSON.stringify(sourceRecord)).run();
  await db.prepare("insert into capsules (id, space_id, source_id, status, record_json) values (?, ?, ?, ?, ?)")
    .bind("cap_1", "spc_1", "src_1", "active", JSON.stringify({ id: "cap_1", workspaceId: "spc_1",
      sourceId: "src_1", status: "active" })).run();
  await db.prepare("insert into source_snapshots values (?, ?, ?)")
    .bind("snap_1", "src_1", JSON.stringify({ id: "snap_1", sourceId: "src_1", workspaceId: "spc_1", archiveRef: ARCHIVE_KEY })).run();
  const bucket = new FakeR2Bucket();
  await bucket.put(ARCHIVE_KEY, ARCHIVE_BYTES);
  const runner = runnerWithContainer(new FakeR2Bucket(), bucket, {
    async containerFetch() { throw new Error("retirement must not start container"); },
  }, { TAKOSUMI_CONTROL_DB: db });
  const retire = (archiveRef: string) => runner.fetch(new Request("https://runner/sources/src_1/archive/retire", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "spc_1", sourceId: "src_1", archiveRef }),
  }));
  expect((await retire(ARCHIVE_KEY)).status).toBe(503);
  await db.prepare("update capsules set status = ? where id = ?").bind("destroyed", "cap_1").run();
  await db.prepare("insert into runs (id, space_id, source_id, type, status, lease_token, run_json) values (?, ?, ?, ?, ?, ?, ?)")
    .bind("sync_live", "spc_1", "src_1", "source_sync", "running", "lease",
      JSON.stringify({ id: "sync_live", workspaceId: "spc_1", sourceId: "src_1", kind: "source_sync", archiveRef: ARCHIVE_KEY })).run();
  expect((await retire(ARCHIVE_KEY)).status).toBe(503);
  await db.prepare("delete from runs where id = ?").bind("sync_live").run();
  await db.prepare("update sources set status = ?, record_json = ? where id = ?")
    .bind("active", JSON.stringify({ ...sourceRecord, status: "active" }), "src_1").run();
  expect((await retire(ARCHIVE_KEY)).status).toBe(503);
  await db.prepare("update sources set status = ?, record_json = ? where id = ?")
    .bind("disabled", JSON.stringify(sourceRecord), "src_1").run();
  expect((await retire("workspaces/spc_1/sources/src_1/snapshots/unowned/source.tar.zst")).status).toBe(503);
  expect((await retire("workspaces/spc_1/sources/src_other/snapshots/snap_1/source.tar.zst")).status).toBe(503);
  expect(bucket.body(ARCHIVE_KEY)).toBeDefined();
});

test("Source retirement batch checks the whole prefix and resumes when objects are missing", async () => {
  const db = new SqliteFakeD1();
  await db.exec(`create table sources (id text, space_id text, status text, record_json text);
    create table capsules (id text, space_id text, source_id text, status text, record_json text);
    create table runs (id text, space_id text, source_id text, installation_id text, type text, status text, lease_token text, run_json text);
    create table source_snapshots (id text, source_id text, record_json text);
    create table audit_events (id text, action text, target_type text, target_id text)`);
  await db.prepare("insert into sources values (?, ?, ?, ?)")
    .bind("src_1", "spc_1", "disabled", JSON.stringify({ id: "src_1", workspaceId: "spc_1",
      status: "disabled", autoSync: false, retiringAt: "2026-10-28T00:00:00.000Z" })).run();
  const missing = "workspaces/spc_1/sources/src_1/snapshots/snap_missing/source.tar.zst";
  const foreign = "workspaces/spc_1/sources/src_1/snapshots/snap_foreign/source.tar.zst";
  const longRefs = Array.from({ length: 30 }, (_, i) => {
    const id = `snap_long_${String(i).padStart(2, "0")}_${"x".repeat(110)}`;
    return { id, archiveRef: `workspaces/spc_1/sources/src_1/snapshots/${id}/source.tar.zst` };
  });
  const records = [{ id: "snap_1", archiveRef: ARCHIVE_KEY },
    { id: "snap_missing", archiveRef: missing }, ...longRefs];
  for (const { id, archiveRef } of records) {
    await db.prepare("insert into source_snapshots values (?, ?, ?)")
      .bind(id, "src_1", JSON.stringify({ id, sourceId: "src_1", workspaceId: "spc_1", archiveRef })).run();
  }
  const bucket = new FakeR2Bucket();
  await bucket.put(ARCHIVE_KEY, ARCHIVE_BYTES);
  const runner = runnerWithContainer(new FakeR2Bucket(), bucket, {
    async containerFetch() { throw new Error("retirement must not start container"); },
  }, { TAKOSUMI_CONTROL_DB: db });
  const retire = () => runner.fetch(new Request("https://runner/sources/src_1/archive/retire", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "spc_1", sourceId: "src_1",
      archiveRefs: records.map((record) => record.archiveRef) }),
  }));
  await db.prepare("insert into source_snapshots values (?, ?, ?)")
    .bind("foreign", "src_other", JSON.stringify({ id: "foreign", sourceId: "src_other",
      workspaceId: "spc_2", archiveRef: foreign })).run();
  expect((await retire()).status).toBe(503);
  expect(bucket.body(ARCHIVE_KEY)).toBeDefined();
  await db.prepare("delete from source_snapshots where id = ?").bind("foreign").run();
  expect((await retire()).status).toBe(204);
  expect(bucket.body(ARCHIVE_KEY)).toBeUndefined();
  expect((await retire()).status).toBe(204);
});

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Both agreed layouts: a Workspace Source, and an app-owned Source of a Capsule
// with an `apps/` root (TASK-0118 P9.1-f).
for (const archiveKey of [ARCHIVE_KEY, "apps/cap_1/sources/src_1/snapshots/snap_1/source.tar.zst"]) {
test(`source_sync run promotes the runner-local source archive to R2_SOURCE (${archiveKey.split("/")[0]})`, async () => {
  const calls: string[] = [];
  const archiveDigest = await digestOf(ARCHIVE_BYTES);
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "GET" && path === "/healthz") {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/sync_1") {
        return Response.json({
          runId: "sync_1",
          action: "source_sync",
          status: "succeeded",
          exitCode: 0,
          resolvedCommit: RESOLVED_COMMIT,
          archiveDigest,
          archiveSizeBytes: ARCHIVE_BYTES.byteLength,
          sourceArchive: {
            kind: "runner-local",
            ref: archiveKey,
            digest: archiveDigest,
            contentType: "application/zstd",
            sizeBytes: ARCHIVE_BYTES.byteLength,
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/sync_1/artifacts/source-archive"
      ) {
        return new Response(ARCHIVE_BYTES, {
          headers: { "content-type": "application/zstd" },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/sync_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "source_sync",
        runId: "sync_1",
        request: {
          action: "source_sync",
          source: {
            url: "https://github.com/octocat/Hello-World.git",
            ref: "main",
          },
          archiveRef: archiveKey,
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  // The DO dispatches the run, then pulls and persists the archive. No state
  // routes are exercised for a source_sync run.
  assert.deepEqual(calls, [
    "GET /healthz",
    "POST /runs/sync_1",
    "GET /runs/sync_1/artifacts/source-archive",
  ]);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.resolvedCommit, RESOLVED_COMMIT);
  const archive = payload.sourceArchive as Record<string, unknown>;
  assert.equal(archive.kind, "object-storage");
  assert.equal(archive.ref, archiveKey);
  assert.equal(archive.digest, archiveDigest);
  assert.deepEqual(source.body(archiveKey), ARCHIVE_BYTES);
  // The plan/state bucket must be untouched by a source_sync run.
  assert.equal(artifacts.body(archiveKey), undefined);
});
}

test("source_sync rejects one-byte-oversized chunked archives without an R2 object", async () => {
  const archiveDigest = await digestOf(ARCHIVE_BYTES);
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const runner = runnerWithContainer(
    artifacts,
    source,
    {
      async containerFetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/healthz") {
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && path === "/runs/sync_limit") {
          return Response.json({
            status: "succeeded",
            exitCode: 0,
            resolvedCommit: RESOLVED_COMMIT,
            sourceArchive: {
              kind: "runner-local",
              ref: ARCHIVE_KEY,
              digest: archiveDigest,
            },
          });
        }
        if (
          request.method === "GET" &&
          path === "/runs/sync_limit/artifacts/source-archive"
        ) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(ARCHIVE_BYTES.slice(0, 3));
                controller.enqueue(ARCHIVE_BYTES.slice(3));
                controller.close();
              },
            }),
          );
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    },
    {
      TAKOSUMI_RUNNER_SOURCE_ARCHIVE_MAX_BYTES: String(
        ARCHIVE_BYTES.byteLength - 1,
      ),
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/sync_limit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "source_sync",
        runId: "sync_limit",
        request: {
          action: "source_sync",
          source: {
            url: "https://github.com/octocat/Hello-World.git",
            ref: "main",
          },
          archiveRef: ARCHIVE_KEY,
        },
      }),
    }),
  );

  assert.equal(response.status, 413);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.errorCode, "artifact_size_limit_exceeded");
  assert.equal(payload.artifact, "source_archive");
  assert.equal(source.body(ARCHIVE_KEY), undefined);
  assert.equal(artifacts.body(ARCHIVE_KEY), undefined);
});

test("source_sync run reuses an object-storage source archive without re-persisting", async () => {
  const calls: string[] = [];
  const archiveDigest = await digestOf(ARCHIVE_BYTES);
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  await source.put(ARCHIVE_KEY, ARCHIVE_BYTES, {
    customMetadata: { "takosumi-digest": archiveDigest },
  });
  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "GET" && path === "/healthz") {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/sync_reuse") {
        return Response.json({
          runId: "sync_reuse",
          action: "source_sync",
          status: "succeeded",
          exitCode: 0,
          resolvedCommit: RESOLVED_COMMIT,
          archiveDigest,
          archiveSizeBytes: ARCHIVE_BYTES.byteLength,
          sourceArchive: {
            kind: "object-storage",
            ref: ARCHIVE_KEY,
            digest: archiveDigest,
            contentType: "application/zstd",
            sizeBytes: ARCHIVE_BYTES.byteLength,
            reusedFromSnapshotId: "snap_prev",
          },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/sync_reuse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "source_sync",
        runId: "sync_reuse",
        request: {
          action: "source_sync",
          source: {
            url: "https://github.com/octocat/Hello-World.git",
            ref: "main",
          },
          archiveRef: ARCHIVE_KEY,
          reuseSnapshot: {
            id: "snap_prev",
            resolvedCommit: RESOLVED_COMMIT,
            archiveRef: ARCHIVE_KEY,
            archiveDigest,
            archiveSizeBytes: ARCHIVE_BYTES.byteLength,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["GET /healthz", "POST /runs/sync_reuse"]);
  const payload = (await response.json()) as Record<string, unknown>;
  const archive = payload.sourceArchive as Record<string, unknown>;
  assert.equal(archive.kind, "object-storage");
  assert.equal(archive.ref, ARCHIVE_KEY);
  assert.equal(archive.reusedFromSnapshotId, "snap_prev");
  assert.deepEqual(source.body(ARCHIVE_KEY), ARCHIVE_BYTES);
  assert.equal(artifacts.body(ARCHIVE_KEY), undefined);
});

test("source_sync run rejects object-storage reuse without a matching reusable snapshot", async () => {
  const archiveDigest = await digestOf(ARCHIVE_BYTES);
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  await source.put(ARCHIVE_KEY, ARCHIVE_BYTES, {
    customMetadata: { "takosumi-digest": archiveDigest },
  });
  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/healthz") {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/sync_reuse_bad") {
        return Response.json({
          runId: "sync_reuse_bad",
          action: "source_sync",
          status: "succeeded",
          exitCode: 0,
          resolvedCommit: RESOLVED_COMMIT,
          archiveDigest,
          archiveSizeBytes: ARCHIVE_BYTES.byteLength,
          sourceArchive: {
            kind: "object-storage",
            ref: ARCHIVE_KEY,
            digest: archiveDigest,
            contentType: "application/zstd",
            sizeBytes: ARCHIVE_BYTES.byteLength,
            reusedFromSnapshotId: "snap_prev",
          },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/sync_reuse_bad", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "source_sync",
        runId: "sync_reuse_bad",
        request: {
          action: "source_sync",
          source: {
            url: "https://github.com/octocat/Hello-World.git",
            ref: "main",
          },
          archiveRef: ARCHIVE_KEY,
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
});

test("source_sync run fails when the archive digest does not match", async () => {
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/healthz") {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/sync_2") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          resolvedCommit: RESOLVED_COMMIT,
          sourceArchive: {
            kind: "runner-local",
            ref: ARCHIVE_KEY,
            digest: "sha256:" + "0".repeat(64),
            contentType: "application/zstd",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/sync_2/artifacts/source-archive"
      ) {
        return new Response(ARCHIVE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/sync_2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "source_sync",
        runId: "sync_2",
        request: {
          action: "source_sync",
          source: {
            url: "https://github.com/octocat/Hello-World.git",
            ref: "main",
          },
          archiveRef: ARCHIVE_KEY,
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  assert.equal(source.body(ARCHIVE_KEY), undefined);
});

function runnerWithContainer(
  artifacts: R2Bucket,
  sourceBucket: R2Bucket,
  container: ContainerRequestFetcher,
  envOverrides: Readonly<Record<string, unknown>> = {},
): OpenTofuRunnerObject {
  const runner = new OpenTofuRunnerObject(
    { storage: new FakeDoStorage() },
    {
      TAKOSUMI_CONTROL_DB: {} as CloudflareWorkerEnv["TAKOSUMI_CONTROL_DB"],
      R2_ARTIFACTS: artifacts,
      R2_SOURCE: sourceBucket,
      COORDINATION: {} as CloudflareWorkerEnv["COORDINATION"],
      ...envOverrides,
    } as CloudflareWorkerEnv,
  );
  Object.defineProperty(runner, "containerFetch", {
    value(request: Request, _port?: number) {
      return container.containerFetch(request);
    },
  });
  return runner;
}

class FakeDoStorage {
  #values = new Map<string, unknown>();

  get<T = unknown>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.#values.get(key) as T | undefined);
  }

  put<T = unknown>(key: string, value: T): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }

  sync(): Promise<void> {
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#values.delete(key));
  }
}

class FakeR2Bucket implements R2Bucket {
  readonly #objects = new Map<string, FakeR2ObjectBody>();

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const bytes = await bytesFromR2PutValue(value);
    const object = new FakeR2ObjectBody(key, bytes, options);
    this.#objects.set(key, object);
    return object;
  }

  get(key: string): Promise<R2ObjectBody | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  head(key: string): Promise<R2Object | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    return Promise.resolve({
      objects: Array.from(this.#objects.values()).filter((object) =>
        object.key.startsWith(prefix),
      ),
      truncated: false,
    });
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  body(key: string): Uint8Array | undefined {
    return this.#objects.get(key)?.bytes;
  }
}

class FakeR2ObjectBody implements R2ObjectBody {
  readonly size: number;
  readonly etag = "etag";
  readonly uploaded = new Date("2026-06-06T00:00:00.000Z");
  readonly httpMetadata?: R2Object["httpMetadata"];
  readonly customMetadata?: Record<string, string>;

  constructor(
    readonly key: string,
    readonly bytes: Uint8Array,
    options?: R2PutOptions,
  ) {
    this.size = bytes.byteLength;
    this.httpMetadata = options?.httpMetadata;
    this.customMetadata = options?.customMetadata;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new Uint8Array(this.bytes);
    return Promise.resolve(copy.buffer);
  }
}

async function bytesFromR2PutValue(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}
