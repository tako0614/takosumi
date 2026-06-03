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

const PLAN_BYTES = new TextEncoder().encode("reviewed tfplan bytes");
const PLAN_DIGEST =
  "sha256:0fd9817656d95201f5c8073b9b4b4c2d5bfe8468b69e7bf771e5311b122a90e7";
const STATE_BYTES = new TextEncoder().encode('{"serial":1}');
const UPDATED_STATE_BYTES = new TextEncoder().encode('{"serial":2}');

test("OpenTofu runner Durable Object promotes runner-local plan artifact to R2", async () => {
  const calls: string[] = [];
  const r2 = new FakeR2Bucket();
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planDigest: PLAN_DIGEST,
          planArtifact: {
            kind: "runner-local",
            ref: "runner-local://plan_1/tfplan",
            digest: PLAN_DIGEST,
            contentType: "application/vnd.opentofu.plan",
          },
        });
      }
      if (request.method === "GET" && path === "/runs/plan_1/artifacts/tfplan") {
        return new Response(PLAN_BYTES, {
          headers: { "content-type": "application/vnd.opentofu.plan" },
        });
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
      request: {},
    }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfplan",
  ]);
  const payload = await response.json() as Record<string, unknown>;
  const artifact = payload.planArtifact as Record<string, unknown>;
  assert.equal(artifact.kind, "object-storage");
  assert.equal(artifact.ref, "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan");
  assert.equal(artifact.digest, PLAN_DIGEST);
  assert.deepEqual(r2.body("opentofu-plan-runs/plan_1/tfplan"), PLAN_BYTES);
});

test("OpenTofu runner Durable Object restores reviewed R2 plan artifact before apply", async () => {
  const calls: string[] = [];
  const r2 = new FakeR2Bucket();
  await r2.put("opentofu-plan-runs/plan_1/tfplan", PLAN_BYTES, {
    httpMetadata: { contentType: "application/vnd.opentofu.plan" },
    customMetadata: { "takosumi-digest": PLAN_DIGEST },
  });
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const path = new URL(request.url).pathname;
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfplan") {
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), PLAN_BYTES);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(new Request("https://runner/runs/plan_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "apply",
      runId: "plan_1",
      request: {
        planArtifact: {
          kind: "object-storage",
          ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
          digest: PLAN_DIGEST,
        },
      },
    }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/artifacts/tfplan",
    "POST /runs/plan_1",
  ]);
});

test("OpenTofu runner Durable Object restores and persists operator-managed state", async () => {
  const calls: string[] = [];
  const r2 = new FakeR2Bucket();
  const stateBackendRef = "state://takosumi/cloudflare-default";
  const stateKey =
    `${await testStateBackendPrefix(stateBackendRef)}/installations/inst_1/terraform.tfstate`;
  await r2.put(stateKey, STATE_BYTES);
  await r2.put("opentofu-plan-runs/plan_1/tfplan", PLAN_BYTES, {
    httpMetadata: { contentType: "application/vnd.opentofu.plan" },
    customMetadata: { "takosumi-digest": PLAN_DIGEST },
  });
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const path = new URL(request.url).pathname;
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfstate") {
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), STATE_BYTES);
        return Response.json({ ok: true });
      }
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfplan") {
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), PLAN_BYTES);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (request.method === "GET" && path === "/runs/plan_1/artifacts/tfstate") {
        return new Response(UPDATED_STATE_BYTES, {
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(new Request("https://runner/runs/plan_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "apply",
      runId: "plan_1",
      request: {
        planRun: {
          id: "plan_1",
          installationId: "inst_1",
          spaceId: "space_1",
          runnerProfileId: "cloudflare-default",
          source: {
            kind: "git",
            url: "https://github.com/example/app.git",
            ref: "main",
          },
        },
        runnerProfile: {
          id: "cloudflare-default",
          stateBackend: {
            kind: "operator-managed",
            ref: stateBackendRef,
          },
        },
        planArtifact: {
          kind: "object-storage",
          ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
          digest: PLAN_DIGEST,
        },
      },
    }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/artifacts/tfplan",
    "PUT /runs/plan_1/artifacts/tfstate",
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfstate",
  ]);
  assert.deepEqual(r2.body(stateKey), UPDATED_STATE_BYTES);
});

test("OpenTofu runner Durable Object uses the configured R2 bucket name in artifact refs", async () => {
  const r2 = new FakeR2Bucket();
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planDigest: PLAN_DIGEST,
          planArtifact: {
            kind: "runner-local",
            ref: "runner-local://plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        });
      }
      if (request.method === "GET" && path === "/runs/plan_1/artifacts/tfplan") {
        return new Response(PLAN_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  }, { bucketName: "takosumi-proof-artifacts" });

  const response = await runner.fetch(new Request("https://runner/runs/plan_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId: "plan_1",
      request: {},
    }),
  }));

  assert.equal(response.status, 200);
  const payload = await response.json() as Record<string, unknown>;
  const artifact = payload.planArtifact as Record<string, unknown>;
  assert.equal(
    artifact.ref,
    "r2://takosumi-proof-artifacts/opentofu-plan-runs/plan_1/tfplan",
  );
});

async function testStateBackendPrefix(ref: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ref),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `opentofu-state/backends/${hex}`;
}

function runnerWithContainer(
  r2: R2Bucket,
  container: ContainerRequestFetcher,
  options: { readonly bucketName?: string } = {},
): TakosumiOpenTofuRunner {
  const runner = new TakosumiOpenTofuRunner(
    { storage: new FakeDoStorage() },
    {
      TAKOS_D1: {} as CloudflareWorkerEnv["TAKOS_D1"],
      TAKOS_ARTIFACTS: r2,
      ...(options.bucketName
        ? { TAKOS_ARTIFACTS_BUCKET_NAME: options.bucketName }
        : {}),
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
  readonly uploaded = new Date("2026-06-03T00:00:00.000Z");
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
