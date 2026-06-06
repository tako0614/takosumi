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
  OpenTofuRunnerObject,
} from "./durable/OpenTofuRunnerObject.ts";

const TEST_PASSPHRASE = "takosumi-source-restore-test-passphrase-0123456789";
const ARCHIVE_BYTES = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x09, 0x08, 0x07]);
const ARCHIVE_KEY =
  "spaces/spc_1/sources/src_1/snapshots/snap_1/source.tar.zst";

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

test("plan dispatch with sourceArchive restores the snapshot archive to the container before dispatch", async () => {
  const calls: string[] = [];
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const digest = await digestOf(ARCHIVE_BYTES);
  await source.put(ARCHIVE_KEY, ARCHIVE_BYTES);

  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/source-archive/restore"
      ) {
        // The DO streams the verified archive bytes to the restore route.
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), ARCHIVE_BYTES);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (request.method === "GET" && path === "/runs/plan_1/artifacts/tfplan-json") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(new Request("https://runner/runs/plan_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId: "plan_1",
      request: {
        sourceArchive: { objectKey: ARCHIVE_KEY, digest },
      },
    }),
  }));

  assert.equal(response.status, 200);
  // The archive is restored FIRST, then the run is dispatched.
  assert.equal(calls[0], "PUT /runs/plan_1/source-archive/restore");
  assert.ok(calls.includes("POST /runs/plan_1"));
});

test("sourceArchive restore fails closed when the R2 object digest does not match", async () => {
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  await source.put(ARCHIVE_KEY, ARCHIVE_BYTES);

  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(_request) {
      // Restore must fail before any container call.
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(new Request("https://runner/runs/plan_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId: "plan_1",
      request: {
        sourceArchive: {
          objectKey: ARCHIVE_KEY,
          digest: `sha256:${"0".repeat(64)}`,
        },
      },
    }),
  }));

  assert.equal(response.status, 500);
});

test("sourceArchive restore rejects an unsafe object key (traversal) and never reads R2", async () => {
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();

  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(_request) {
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(new Request("https://runner/runs/plan_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId: "plan_1",
      request: {
        sourceArchive: {
          objectKey: "spaces/../../etc/passwd",
          digest: `sha256:${"0".repeat(64)}`,
        },
      },
    }),
  }));

  assert.equal(response.status, 500);
});

function runnerWithContainer(
  artifacts: R2Bucket,
  sourceBucket: R2Bucket,
  container: ContainerRequestFetcher,
): OpenTofuRunnerObject {
  const runner = new OpenTofuRunnerObject(
    { storage: new FakeDoStorage() },
    {
      TAKOS_D1: {} as CloudflareWorkerEnv["TAKOS_D1"],
      R2_ARTIFACTS: artifacts,
      R2_SOURCE: sourceBucket,
      COORDINATION: {} as CloudflareWorkerEnv["COORDINATION"],
      TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
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
