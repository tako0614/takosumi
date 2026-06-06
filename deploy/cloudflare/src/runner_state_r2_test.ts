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
import { StateArtifactCrypto } from "./state_crypto.ts";

const TEST_PASSPHRASE = "takosumi-runner-r2-state-test-passphrase-0123456789";
const PLAN_BYTES = new TextEncoder().encode("reviewed tfplan bytes");
const PLAN_DIGEST =
  "sha256:0fd9817656d95201f5c8073b9b4b4c2d5bfe8468b69e7bf771e5311b122a90e7";
const NEW_STATE_BYTES = new TextEncoder().encode('{"version":4,"serial":2}');

const SCOPE = {
  spaceId: "spc_1",
  appId: "app_1",
  envId: "env_1",
  generation: 2,
};
const STATE_PREFIX = "spaces/spc_1/apps/app_1/envs/env_1/states";
const NEXT_STATE_KEY = `${STATE_PREFIX}/00000002.tfstate.enc`;
const CURRENT_KEY = `${STATE_PREFIX}/current.json`;

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

test("apply with stateScope persists encrypted state to R2_STATE and writes current.json after the object", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  await artifacts.put("opentofu-plan-runs/plan_1/tfplan", PLAN_BYTES);
  // The plan binary is stored encrypted at `.enc`; seed both so restore prefers
  // the encrypted object.
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put("opentofu-plan-runs/plan_1/tfplan.enc", sealedPlan.ciphertext);

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfplan") {
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), PLAN_BYTES);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (request.method === "GET" && path === "/runs/plan_1/artifacts/tfstate") {
        return new Response(NEW_STATE_BYTES, {
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
        stateScope: SCOPE,
        planArtifact: {
          kind: "object-storage",
          ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
          digest: PLAN_DIGEST,
        },
      },
    }),
  }));

  assert.equal(response.status, 200);
  // No existing current.json, so restore is a no-op; apply runs, then the DO
  // pulls the new state and persists it encrypted, then writes current.json.
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/artifacts/tfplan",
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfstate",
  ]);

  // State object is encrypted at rest (not the plaintext).
  const stored = state.body(NEXT_STATE_KEY);
  assert.ok(stored && stored.byteLength > 0);
  assert.notDeepEqual(stored, NEW_STATE_BYTES);

  // current.json points at the generation object with the PLAINTEXT digest.
  const currentBytes = state.body(CURRENT_KEY);
  assert.ok(currentBytes);
  const current = JSON.parse(new TextDecoder().decode(currentBytes)) as {
    generation: number;
    objectKey: string;
    digest: string;
  };
  assert.equal(current.generation, 2);
  assert.equal(current.objectKey, NEXT_STATE_KEY);
  assert.equal(current.digest, await digestOf(NEW_STATE_BYTES));

  // The stored ciphertext decrypts back to the plaintext (digest verified).
  const opened = await crypto.open(stored!, current.digest);
  assert.deepEqual(opened, NEW_STATE_BYTES);

  // The response surfaces the state pointer for the controller's ledger.
  const payload = await response.json() as Record<string, unknown>;
  const stateField = payload.state as Record<string, unknown>;
  assert.equal(stateField.generation, 2);
  assert.equal(stateField.objectKey, NEXT_STATE_KEY);
  assert.equal(stateField.digest, current.digest);
});

test("apply with stateScope restores the encrypted current state before apply", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  // Seed generation 1 as the current state.
  const priorState = new TextEncoder().encode('{"version":4,"serial":1}');
  const priorKey = `${STATE_PREFIX}/00000001.tfstate.enc`;
  const sealedPrior = await crypto.seal(priorState);
  await state.put(priorKey, sealedPrior.ciphertext);
  await state.put(
    CURRENT_KEY,
    JSON.stringify({
      generation: 1,
      objectKey: priorKey,
      digest: sealedPrior.contentDigest,
    }),
  );

  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put("opentofu-plan-runs/plan_1/tfplan.enc", sealedPlan.ciphertext);

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfplan") {
        return Response.json({ ok: true });
      }
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfstate") {
        // The DO must hand the container the DECRYPTED prior state.
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), priorState);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (request.method === "GET" && path === "/runs/plan_1/artifacts/tfstate") {
        return new Response(NEW_STATE_BYTES);
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
        stateScope: SCOPE,
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
});

test("state restore fails closed when the stored ciphertext is tampered", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const priorState = new TextEncoder().encode('{"version":4,"serial":1}');
  const priorKey = `${STATE_PREFIX}/00000001.tfstate.enc`;
  const sealedPrior = await crypto.seal(priorState);
  // Flip a byte in the persisted ciphertext.
  const tampered = new Uint8Array(sealedPrior.ciphertext);
  tampered[tampered.length - 1] ^= 0x01;
  await state.put(priorKey, tampered);
  await state.put(
    CURRENT_KEY,
    JSON.stringify({
      generation: 1,
      objectKey: priorKey,
      digest: sealedPrior.contentDigest,
    }),
  );
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put("opentofu-plan-runs/plan_1/tfplan.enc", sealedPlan.ciphertext);

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfplan") {
        return Response.json({ ok: true });
      }
      // The state restore must fail before any state PUT reaches the container.
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
        stateScope: SCOPE,
        planArtifact: {
          kind: "object-storage",
          ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
          digest: PLAN_DIGEST,
        },
      },
    }),
  }));

  // The DO surfaces the failure as a 500 (fail closed); no new state written.
  assert.equal(response.status, 500);
  assert.equal(state.body(NEXT_STATE_KEY), undefined);
});

test("legacy apply without stateScope keeps using the TAKOS_ARTIFACTS state path", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const stateBackendRef = "state://takosumi/cloudflare-default";
  const legacyStateKey =
    `${await legacyBackendPrefix(stateBackendRef)}/installations/inst_1/terraform.tfstate`;
  const priorState = new TextEncoder().encode('{"serial":1}');
  await artifacts.put(legacyStateKey, priorState);
  // Legacy plaintext plan binary (pre-M2): restore falls back to plaintext.
  await artifacts.put("opentofu-plan-runs/plan_1/tfplan", PLAN_BYTES, {
    customMetadata: { "takosumi-digest": PLAN_DIGEST },
  });

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfplan") {
        return Response.json({ ok: true });
      }
      if (request.method === "PUT" && path === "/runs/plan_1/artifacts/tfstate") {
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), priorState);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (request.method === "GET" && path === "/runs/plan_1/artifacts/tfstate") {
        return new Response(NEW_STATE_BYTES);
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
          source: { kind: "git", url: "https://github.com/example/app.git", ref: "main" },
        },
        runnerProfile: {
          id: "cloudflare-default",
          stateBackend: { kind: "operator-managed", ref: stateBackendRef },
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
  // Legacy path persists the new state UNENCRYPTED to TAKOS_ARTIFACTS, and never
  // touches R2_STATE.
  assert.deepEqual(artifacts.body(legacyStateKey), NEW_STATE_BYTES);
  assert.equal(state.body(NEXT_STATE_KEY), undefined);
  assert.equal(state.body(CURRENT_KEY), undefined);
});

async function legacyBackendPrefix(ref: string): Promise<string> {
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
  artifacts: R2Bucket,
  stateBucket: R2Bucket,
  container: ContainerRequestFetcher,
): TakosumiOpenTofuRunner {
  const runner = new TakosumiOpenTofuRunner(
    { storage: new FakeDoStorage() },
    {
      TAKOS_D1: {} as CloudflareWorkerEnv["TAKOS_D1"],
      TAKOS_ARTIFACTS: artifacts,
      R2_STATE: stateBucket,
      TAKOS_COORDINATION: {} as CloudflareWorkerEnv["TAKOS_COORDINATION"],
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
