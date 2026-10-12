import assert from "node:assert/strict";
import { test } from "bun:test";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { createPrivateRunFileGrantCodec } from "../../../core/domains/private-run-files/grant.ts";
import { R2PrivateRunFileBlobStore } from "../../../worker/src/private_run_file_r2_blob_store.ts";
import type { CloudflareWorkerEnv, D1Database, R2Bucket, R2Object, R2ObjectBody, R2Objects, R2PutOptions } from "../../../worker/src/bindings.ts";
import { createCloudflareWorker } from "../../../worker/src/handler.ts";
import { createWorkerServiceApp, type WorkerPrivateRunFilesComposition } from "../../../worker/src/worker_service.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const PASSPHRASE = "cloud-private-run-file-composition-test-0123456789abcdef";
const PRIVATE_ENDPOINT = "https://core.example/internal/private-run-files/v1";
const PREFIX = "operator-isolated/private-run-files/v1";
const MAX_BYTES = 16 * 1024 * 1024;
const CONFIG: WorkerPrivateRunFilesComposition = {
  endpoint: PRIVATE_ENDPOINT,
  prefix: PREFIX,
  maxBytes: MAX_BYTES,
};
const SCOPE = {
  workspaceId: "cloud_private_workspace",
  capsuleId: "cloud_private_capsule",
  environment: "production",
  slot: "opaque.intent",
} as const;
const AUTHORITY = {
  runId: "cloud_private_plan",
  executionAuthorityEpoch: 3,
  leaseToken: "cloud_private_lease",
} as const;

test("Cloud Worker keeps private-file route absent by default and behind existing internal ingress", async () => {
  const disabledEnv = baseEnv();
  const disabled = await createWorkerServiceApp(disabledEnv, "takosumi-api", { operatorInstallConfigs: [] });
  assert.equal((await disabled.app.fetch(privateRequest())).status, 404);

  const edgeClosed = createCloudflareWorker({ privateRunFiles: CONFIG });
  assert.equal((await edgeClosed.fetch(privateRequest(), baseEnv())).status, 404);

  const ingressWithoutComposition = createCloudflareWorker();
  assert.equal((await ingressWithoutComposition.fetch(
    privateRequest(),
    baseEnv({ TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1" }),
  )).status, 404);

  const edgeOpen = createCloudflareWorker({ privateRunFiles: CONFIG });
  const response = await edgeOpen.fetch(privateRequest(), baseEnv({ TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { kind: "authorization_rejected" });
  const unknown = await edgeOpen.fetch(new Request(`${PRIVATE_ENDPOINT}/other`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), baseEnv({ TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1" }));
  assert.equal(unknown.status, 404);
});

test("Cloud composition fails closed on non-exact cap, unsafe prefix, missing R2, and placeholder crypto", async () => {
  const capEnv = baseEnv();
  await assert.rejects(
    () => createWorkerServiceApp(capEnv, "takosumi-api", { privateRunFiles: { ...CONFIG, maxBytes: MAX_BYTES - 1 } }),
    /exact 16 MiB cap/u,
  );

  await assert.rejects(
    () => createWorkerServiceApp(baseEnv(), "takosumi-api", { privateRunFiles: { ...CONFIG, prefix: "../shared" } }),
    /private run file blob is unavailable/u,
  );
  await assert.rejects(
    () => createWorkerServiceApp(baseEnv({ R2_ARTIFACTS: undefined }), "takosumi-api", { privateRunFiles: CONFIG }),
    /R2_ARTIFACTS binding/u,
  );
  await assert.rejects(
    () => createWorkerServiceApp(baseEnv({ TAKOSUMI_DEV_MODE: "1", TAKOSUMI_SECRET_STORE_PASSPHRASE: undefined }), "takosumi-api", { privateRunFiles: CONFIG }),
    /configured partitioned encryption/u,
  );
});

test("opt-in Cloud composition serves an authenticated read through local D1 and R2 fixtures", async () => {
  const db = new SqliteFakeD1();
  const bucket = new FakeR2Bucket();
  const env = baseEnv({ TAKOSUMI_CONTROL_DB: db, R2_ARTIFACTS: bucket });
  const created = await createWorkerServiceApp(env, "takosumi-api", {
    operatorInstallConfigs: [],
    privateRunFiles: CONFIG,
  });

  await seedAuthority(db);
  const cryptoBoundary = new PartitionedSecretBoundaryCrypto({ globalPassphrase: PASSPHRASE });
  const bytes = new TextEncoder().encode("authenticated opaque payload");
  const digest = await digestBytes(bytes);
  const blobStore = new R2PrivateRunFileBlobStore({
    bucket,
    prefix: PREFIX,
    cryptoBoundary,
    maxBytes: MAX_BYTES,
  });
  const blob = await blobStore.putEncryptedImmutable({ scope: SCOPE, bytes, digest });
  await db.prepare(`insert into private_run_file_pointers
    (workspace_id, capsule_id, environment, slot, version, digest, blob_id, latest_commit_id)
    values (?, ?, ?, ?, 1, ?, ?, 'seeded-commit')`)
    .bind(SCOPE.workspaceId, SCOPE.capsuleId, SCOPE.environment, SCOPE.slot, digest, blob.blobId).run();

  const grants = createPrivateRunFileGrantCodec({ cryptoBoundary });
  const grant = await grants.mint({
    scope: SCOPE,
    authority: AUTHORITY,
    operations: ["read"],
    expiresAt: Date.now() + 60_000,
  });
  const response = await created.app.fetch(new Request(`${PRIVATE_ENDPOINT}/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(response.status, 200);
  const result = await response.json() as { kind: string; version?: number; digest?: string; bytesBase64?: string };
  assert.deepEqual(result, {
    kind: "present",
    version: 1,
    digest,
    bytesBase64: toBase64(bytes),
  });
  assert.equal(bucket.getCount, 3); // Existing-object probe, write readback, then authenticated HTTP read.
});

function baseEnv(extra: Record<string, unknown> = {}): CloudflareWorkerEnv {
  return {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    R2_ARTIFACTS: new FakeR2Bucket(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
    ...extra,
  } as unknown as CloudflareWorkerEnv;
}

function privateRequest(): Request {
  return new Request(`${PRIVATE_ENDPOINT}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

async function seedAuthority(db: D1Database): Promise<void> {
  await db.prepare(`insert into workspaces
    (id, handle, record_json, created_at, updated_at)
    values (?, ?, '{}', '2026-10-12', '2026-10-12')`)
    .bind(SCOPE.workspaceId, "cloud-private-workspace").run();
  await db.prepare(`insert into capsules
    (id, space_id, project_id, name, slug, install_config_id, environment,
     status, record_json, created_at, updated_at, execution_authority_epoch)
    values (?, ?, ?, ?, ?, ?, ?, 'active', '{}', '2026-10-12', '2026-10-12', ?)`)
    .bind(SCOPE.capsuleId, SCOPE.workspaceId, "cloud_private_project", "cloud-private-capsule", "cloud-private-capsule", "cloud_private_install", SCOPE.environment, AUTHORITY.executionAuthorityEpoch).run();
  await db.prepare(`insert into runs
    (id, space_id, installation_id, environment, type, status, lease_token, run_json, created_at)
    values (?, ?, ?, ?, 'plan', 'running', ?, ?, '2026-10-12')`)
    .bind(AUTHORITY.runId, SCOPE.workspaceId, SCOPE.capsuleId, SCOPE.environment, AUTHORITY.leaseToken, JSON.stringify({
      id: AUTHORITY.runId,
      workspaceId: SCOPE.workspaceId,
      capsuleId: SCOPE.capsuleId,
      status: "running",
      capsuleExecutionAuthorityEpoch: AUTHORITY.executionAuthorityEpoch,
    })).run();
}

async function digestBytes(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class FakeR2Bucket implements R2Bucket {
  readonly #objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  getCount = 0;

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions): Promise<R2Object | null> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.#objects.has(key)) return null;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error("fixture expects byte input");
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.#objects.set(key, { bytes, metadata: { ...(options?.customMetadata ?? {}) } });
    return this.asObject(key);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    this.getCount += 1;
    const object = this.#objects.get(key);
    if (!object) return null;
    const bytes = object.bytes.slice();
    return {
      ...this.asObject(key),
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } }),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async head(key: string): Promise<R2Object | null> { return this.#objects.has(key) ? this.asObject(key) : null; }
  async list(_options?: import("../../../worker/src/bindings.ts").R2ListOptions): Promise<R2Objects> { return { objects: [], truncated: false }; }
  async delete(key: string): Promise<void> { this.#objects.delete(key); }

  private asObject(key: string): R2Object {
    const object = this.#objects.get(key)!;
    return { key, size: object.bytes.byteLength, etag: `etag-${key}`, uploaded: new Date(0), customMetadata: { ...object.metadata } };
  }
}
