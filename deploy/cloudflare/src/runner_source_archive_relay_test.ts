import assert from "node:assert/strict";
import { test } from "bun:test";
import type {
  CloudflareWorkerEnv,
  R2Bucket,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "./bindings.ts";
import {
  type ContainerRequestFetcher,
  TakosumiOpenTofuRunner,
} from "./opentofu_runner_container.ts";

const ARCHIVE_BYTES = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03]);
const ARCHIVE_KEY =
  "spaces/spc_1/sources/src_1/snapshots/snap_1/source.tar.zst";
const RESOLVED_COMMIT = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

test("source_sync run promotes the runner-local source archive to R2_SOURCE", async () => {
  const calls: string[] = [];
  const archiveDigest = await digestOf(ARCHIVE_BYTES);
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
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
            ref: "runner-local://sync_1/source-archive",
            archiveObjectKey: ARCHIVE_KEY,
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

  const response = await runner.fetch(new Request("https://runner/runs/sync_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "source_sync",
      runId: "sync_1",
      request: {
        action: "source_sync",
        source: { url: "https://github.com/octocat/Hello-World.git", ref: "main" },
        archiveObjectKey: ARCHIVE_KEY,
      },
    }),
  }));

  assert.equal(response.status, 200);
  // The DO dispatches the run, then pulls and persists the archive. No state
  // routes are exercised for a source_sync run.
  assert.deepEqual(calls, [
    "POST /runs/sync_1",
    "GET /runs/sync_1/artifacts/source-archive",
  ]);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.resolvedCommit, RESOLVED_COMMIT);
  const archive = payload.sourceArchive as Record<string, unknown>;
  assert.equal(archive.kind, "object-storage");
  assert.equal(archive.archiveObjectKey, ARCHIVE_KEY);
  assert.equal(archive.digest, archiveDigest);
  assert.deepEqual(source.body(ARCHIVE_KEY), ARCHIVE_BYTES);
  // The plan/state bucket must be untouched by a source_sync run.
  assert.equal(artifacts.body(ARCHIVE_KEY), undefined);
});

test("source_sync run fails when the archive digest does not match", async () => {
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/runs/sync_2") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          resolvedCommit: RESOLVED_COMMIT,
          sourceArchive: {
            kind: "runner-local",
            archiveObjectKey: ARCHIVE_KEY,
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

  const response = await runner.fetch(new Request("https://runner/runs/sync_2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "source_sync",
      runId: "sync_2",
      request: {
        action: "source_sync",
        source: { url: "https://github.com/octocat/Hello-World.git", ref: "main" },
        archiveObjectKey: ARCHIVE_KEY,
      },
    }),
  }));

  assert.equal(response.status, 500);
  assert.equal(source.body(ARCHIVE_KEY), undefined);
});

function runnerWithContainer(
  artifacts: R2Bucket,
  sourceBucket: R2Bucket,
  container: ContainerRequestFetcher,
): TakosumiOpenTofuRunner {
  const runner = new TakosumiOpenTofuRunner(
    { storage: new FakeDoStorage() },
    {
      TAKOS_D1: {} as CloudflareWorkerEnv["TAKOS_D1"],
      TAKOS_ARTIFACTS: artifacts,
      R2_SOURCE: sourceBucket,
      TAKOS_COORDINATION: {} as CloudflareWorkerEnv["TAKOS_COORDINATION"],
    },
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
        object.key.startsWith(prefix)
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
