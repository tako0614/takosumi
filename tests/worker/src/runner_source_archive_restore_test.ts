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
} from "../../../worker/src/bindings.ts";
import {
  type ContainerRequestFetcher,
  OpenTofuRunnerObject,
} from "../../../worker/src/durable/OpenTofuRunnerObject.ts";

const TEST_PASSPHRASE = "takosumi-source-restore-test-passphrase-0123456789";
const ARCHIVE_BYTES = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x09, 0x08, 0x07,
]);
const ARCHIVE_KEY =
  "workspaces/spc_1/sources/src_1/snapshots/snap_1/source.tar.zst";
const LEGACY_ARCHIVE_KEY =
  "spaces/space_00000001/sources/src_00000001/snapshots/snap_00000001/source.tar.zst";

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
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
      if (request.method === "GET" && path === "/healthz") {
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/source-archive/restore"
      ) {
        // The DO streams the verified archive bytes to the restore route.
        assert.deepEqual(
          new Uint8Array(await request.arrayBuffer()),
          ARCHIVE_BYTES,
        );
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfplan-json"
      ) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {
          sourceArchive: { ref: ARCHIVE_KEY, digest },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  // The archive is restored FIRST, then the run is dispatched.
  assert.equal(calls[0], "GET /healthz");
  assert.equal(calls[1], "PUT /runs/plan_1/source-archive/restore");
  assert.ok(calls.includes("POST /runs/plan_1"));
});

test("source archive restore starts the runner while its bounded R2 body is read", async () => {
  const calls: string[] = [];
  const source = new DeferredBodyR2Bucket();
  const artifacts = new FakeR2Bucket();
  const digest = await digestOf(ARCHIVE_BYTES);
  await source.put(ARCHIVE_KEY, ARCHIVE_BYTES);
  let healthStarted = false;

  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "GET" && path === "/healthz") {
        healthStarted = true;
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/plan_overlap/source-archive/restore"
      ) {
        assert.deepEqual(
          new Uint8Array(await request.arrayBuffer()),
          ARCHIVE_BYTES,
        );
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_overlap") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_overlap/artifacts/tfplan-json"
      ) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const responsePromise = runner.fetch(
    new Request("https://runner/runs/plan_overlap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_overlap",
        request: {
          sourceArchive: { ref: ARCHIVE_KEY, digest },
        },
      }),
    }),
  );

  let healthStartedDuringRead: boolean;
  try {
    await source.bodyReadStarted;
    healthStartedDuringRead = healthStarted;
  } finally {
    source.releaseBody();
  }
  const response = await responsePromise;

  assert.equal(healthStartedDuringRead, true);
  assert.equal(response.status, 200);
  assert.ok(
    calls.indexOf("GET /healthz") <
      calls.indexOf("PUT /runs/plan_overlap/source-archive/restore"),
  );
  assert.ok(
    calls.indexOf("PUT /runs/plan_overlap/source-archive/restore") <
      calls.indexOf("POST /runs/plan_overlap"),
  );
});

for (const mode of [
  "invalid_archive",
  "caller_abort",
  "invalid_archive_health_error_body",
  "caller_abort_health_error_body",
  "caller_abort_health_cancel_held",
] as const) {
  test(`source archive preparation settles held readiness on ${mode}`, async () => {
    const source = new FakeR2Bucket();
    const artifacts = new FakeR2Bucket();
    const calls: string[] = [];
    await source.put(ARCHIVE_KEY, ARCHIVE_BYTES);
    const healthStarted = deferred<void>();
    const heldHealth = deferred<Response>();
    const heldHealthFailureResponse = deferred<Response>();
    const healthFailureCancelGate = deferred<void>();
    const caller = new AbortController();
    let healthFailureBodyController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let healthFailureBodyCanceled = false;
    const digest = await digestOf(ARCHIVE_BYTES);
    const runner = runnerWithContainer(artifacts, source, {
      async containerFetch(request) {
        const path = new URL(request.url).pathname;
        calls.push(`${request.method} ${path}`);
        if (request.method === "GET" && path === "/healthz") {
          healthStarted.resolve();
          if (mode === "caller_abort_health_cancel_held") {
            return await heldHealthFailureResponse.promise;
          }
          if (mode.endsWith("health_error_body")) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  healthFailureBodyController = controller;
                },
                cancel() {
                  healthFailureBodyCanceled = true;
                },
              }),
              { status: 503 },
            );
          }
          return await new Promise<Response>((resolve, reject) => {
            const signal = request.signal;
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
            heldHealth.promise.then(resolve, reject);
          });
        }
        return Response.json({ status: "succeeded", exitCode: 0 });
      },
    });
    const requestSignal = mode.startsWith("caller_abort")
      ? caller.signal
      : undefined;
    const responsePromise = runner.fetch(
      new Request("https://runner/runs/held_health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "plan",
          runId: "held_health",
          request: {
            sourceArchive: {
              ref: ARCHIVE_KEY,
              digest:
                mode.startsWith("invalid_archive")
                  ? `sha256:${"0".repeat(64)}`
                  : digest,
            },
          },
        }),
        ...(requestSignal ? { signal: requestSignal } : {}),
      }),
    ).then(
      (response) => ({ kind: "response" as const, response }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    let outcome:
      | Awaited<typeof responsePromise>
      | { readonly kind: "pending" };
    try {
      await healthStarted.promise;
      if (mode.startsWith("caller_abort")) {
        caller.abort(new DOMException("test caller canceled", "AbortError"));
        if (mode === "caller_abort_health_cancel_held") {
          heldHealthFailureResponse.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  healthFailureBodyController = controller;
                },
                cancel() {
                  healthFailureBodyCanceled = true;
                  return healthFailureCancelGate.promise;
                },
              }),
              { status: 503 },
            ),
          );
        }
      }
      outcome = await Promise.race([
        responsePromise,
        new Promise<{ readonly kind: "pending" }>((resolve) => {
          setTimeout(() => resolve({ kind: "pending" }), 50);
        }),
      ]);
    } finally {
      // The pre-fix implementation leaves health unobserved after the timeout;
      // release it so this red test itself never leaks a pending request.
      heldHealth.resolve(Response.json({ ok: true }));
      healthFailureCancelGate.resolve();
      if (!healthFailureBodyCanceled) {
        healthFailureBodyController?.enqueue(
          new TextEncoder().encode("held failure detail"),
        );
        healthFailureBodyController?.close();
      }
    }
    if (outcome.kind === "pending") await responsePromise;

    assert.notEqual(outcome.kind, "pending");
    assert.deepEqual(
      calls.filter((call) => call.includes("source-archive/restore") || call.includes("POST /runs/")),
      [],
    );
    if (
      mode.endsWith("health_error_body") ||
      mode.endsWith("health_cancel_held")
    ) {
      assert.equal(healthFailureBodyCanceled, true);
    }
  });
}

test("sourceArchive restore fails closed when the R2 object digest does not match", async () => {
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const calls: string[] = [];
  await source.put(ARCHIVE_KEY, ARCHIVE_BYTES);

  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {
          sourceArchive: {
            ref: ARCHIVE_KEY,
            digest: `sha256:${"0".repeat(64)}`,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  // Startup may overlap the body read, but invalid bytes are never restored or
  // dispatched, even when readiness fails at the same time.
  assert.deepEqual(calls, ["GET /healthz"]);
});

test("sourceArchive restore rejects an oversized declared object before runner startup", async () => {
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  await source.put(ARCHIVE_KEY, ARCHIVE_BYTES);
  const calls: string[] = [];

  const runner = runnerWithContainer(
    artifacts,
    source,
    {
      async containerFetch(request) {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    },
    { env: { TAKOSUMI_RUNNER_SOURCE_ARCHIVE_MAX_BYTES: "6" } },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_oversized", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_oversized",
        request: {
          sourceArchive: {
            ref: ARCHIVE_KEY,
            digest: await digestOf(ARCHIVE_BYTES),
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(calls, []);
});

test("sourceArchive restore fails on missing R2 object without starting the runner", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_missing_archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_missing_archive",
        request: {
          sourceArchive: {
            ref: ARCHIVE_KEY,
            digest: await digestOf(ARCHIVE_BYTES),
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(calls, []);
});

test("sourceArchive restore stops before handoff when readiness fails", async () => {
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const calls: string[] = [];
  await source.put(ARCHIVE_KEY, ARCHIVE_BYTES);
  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "GET" && path === "/healthz") {
        return Response.json({ error: "runner unavailable" }, { status: 503 });
      }
      return Response.json({ error: "runner unavailable" }, { status: 503 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_readiness_failure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_readiness_failure",
        request: {
          sourceArchive: {
            ref: ARCHIVE_KEY,
            digest: await digestOf(ARCHIVE_BYTES),
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(calls, ["GET /healthz"]);
});

test("sourceArchive restore accepts a digest-pinned pre-Workspace persisted key", async () => {
  const calls: string[] = [];
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();
  const digest = await digestOf(ARCHIVE_BYTES);
  await source.put(LEGACY_ARCHIVE_KEY, ARCHIVE_BYTES);
  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "GET" && path === "/healthz") {
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/plan_legacy/source-archive/restore"
      ) {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_legacy") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_legacy/artifacts/tfplan-json"
      ) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_legacy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_legacy",
        request: {
          sourceArchive: { ref: LEGACY_ARCHIVE_KEY, digest },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls[0], "GET /healthz");
  assert.equal(calls[1], "PUT /runs/plan_legacy/source-archive/restore");
  assert.ok(calls.includes("POST /runs/plan_legacy"));
});

test("sourceArchive restore rejects an unsafe ref (traversal) and never reads R2", async () => {
  const source = new FakeR2Bucket();
  const artifacts = new FakeR2Bucket();

  const runner = runnerWithContainer(artifacts, source, {
    async containerFetch(_request) {
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {
          sourceArchive: {
            ref: "workspaces/../../etc/passwd",
            digest: `sha256:${"0".repeat(64)}`,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
});

function runnerWithContainer(
  artifacts: R2Bucket,
  sourceBucket: R2Bucket,
  container: ContainerRequestFetcher,
  options: { readonly env?: Partial<CloudflareWorkerEnv> } = {},
): OpenTofuRunnerObject {
  const runner = new OpenTofuRunnerObject({ storage: new FakeDoStorage() }, {
    TAKOSUMI_CONTROL_DB: {} as CloudflareWorkerEnv["TAKOSUMI_CONTROL_DB"],
    R2_ARTIFACTS: artifacts,
    R2_SOURCE: sourceBucket,
    COORDINATION: {} as CloudflareWorkerEnv["COORDINATION"],
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
    ...(options.env ?? {}),
  } as CloudflareWorkerEnv);
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

class DeferredBodyR2Bucket extends FakeR2Bucket {
  readonly bodyReadStarted: Promise<void>;
  readonly #bodyReadStartedResolve: () => void;
  readonly #bodyGate: Promise<void>;
  readonly #bodyGateResolve: () => void;

  constructor() {
    super();
    let bodyReadStartedResolve!: () => void;
    this.bodyReadStarted = new Promise<void>((resolve) => {
      bodyReadStartedResolve = resolve;
    });
    this.#bodyReadStartedResolve = bodyReadStartedResolve;
    let bodyGateResolve!: () => void;
    this.#bodyGate = new Promise<void>((resolve) => {
      bodyGateResolve = resolve;
    });
    this.#bodyGateResolve = bodyGateResolve;
  }

  override async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const object = await super.put(key, value, options);
    if (key === ARCHIVE_KEY) {
      Object.defineProperty(object, "body", {
        get: () =>
          new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              this.#bodyReadStartedResolve();
              await this.#bodyGate;
              controller.enqueue(ARCHIVE_BYTES);
              controller.close();
            },
          }),
      });
    }
    return object;
  }

  releaseBody(): void {
    this.#bodyGateResolve();
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
