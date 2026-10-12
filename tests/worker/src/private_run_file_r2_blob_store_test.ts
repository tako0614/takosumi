import assert from "node:assert/strict";
import { test } from "bun:test";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import type { PrivateRunFileScope } from "../../../core/domains/private-run-files/mod.ts";
import type { R2Bucket, R2ListOptions, R2Object, R2ObjectBody, R2Objects, R2PutOptions } from "../../../worker/src/bindings.ts";
import {
  PRIVATE_RUN_FILE_R2_MAX_BYTES,
  R2PrivateRunFileBlobStore,
} from "../../../worker/src/private_run_file_r2_blob_store.ts";

const PASSPHRASE = "takosumi-private-run-file-r2-tests-0123456789abcdef";
const scope: PrivateRunFileScope = {
  workspaceId: "workspace.test",
  capsuleId: "capsule.test",
  environment: "production.eu",
  slot: "opaque.slot",
};

function fixture() {
  const bucket = new FakeR2Bucket();
  const cryptoBoundary = new PartitionedSecretBoundaryCrypto({ globalPassphrase: PASSPHRASE });
  const store = new R2PrivateRunFileBlobStore({
    bucket,
    prefix: "private-run-files/v1",
    cryptoBoundary,
    maxBytes: PRIVATE_RUN_FILE_R2_MAX_BYTES,
  });
  return { bucket, cryptoBoundary, store };
}

test("stores encrypted immutable bytes and accepts an exact retry", async () => {
  const { bucket, store } = fixture();
  const bytes = new TextEncoder().encode("opaque private bytes");
  const first = await store.putEncryptedImmutable({ scope, bytes, digest: await digest(bytes) });
  const stored = bucket.bytesFor(first.blobId)!;
  assert.notDeepEqual(stored, bytes);
  assert.deepEqual(await store.readEncryptedVerified({ scope, blobId: first.blobId, expectedDigest: first.digest }), {
    bytes,
    digest: first.digest,
    byteLength: bytes.byteLength,
  });
  const retry = await store.putEncryptedImmutable({ scope, bytes: bytes.slice(), digest: first.digest });
  assert.deepEqual(retry, first);
  assert.equal(bucket.putCount, 1);
});

test("keeps scopes and byte snapshots independent and supports empty content", async () => {
  const { store } = fixture();
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const digestValue = await digest(bytes);
  const first = await store.putEncryptedImmutable({ scope, bytes, digest: digestValue });
  bytes.fill(99);
  const read = await store.readEncryptedVerified({ scope, blobId: first.blobId, expectedDigest: digestValue });
  assert.ok(read);
  assert.deepEqual(read.bytes, new Uint8Array([0, 1, 2, 255]));
  read.bytes.fill(12);
  assert.deepEqual((await store.readEncryptedVerified({ scope, blobId: first.blobId, expectedDigest: digestValue }))?.bytes,
    new Uint8Array([0, 1, 2, 255]));

  const empty = new Uint8Array();
  const emptyDigest = await digest(empty);
  const emptyPointer = await store.putEncryptedImmutable({ scope: { ...scope, slot: "empty" }, bytes: empty, digest: emptyDigest });
  assert.deepEqual((await store.readEncryptedVerified({ scope: { ...scope, slot: "empty" }, blobId: emptyPointer.blobId, expectedDigest: emptyDigest }))?.bytes,
    new Uint8Array());
});

test("refuses occupied conflicts, scope/digest substitution, and corrupt ciphertext", async () => {
  const { bucket, store } = fixture();
  const bytes = new TextEncoder().encode("original");
  const digestValue = await digest(bytes);
  const pointer = await store.putEncryptedImmutable({ scope, bytes, digest: digestValue });
  await assert.rejects(() => store.putEncryptedImmutable({ scope, bytes: new TextEncoder().encode("different"), digest: digestValue }),
    /private run file blob is unavailable/u);
  await assert.rejects(() => store.readEncryptedVerified({ scope: { ...scope, slot: "other" }, blobId: pointer.blobId, expectedDigest: digestValue }),
    /private run file blob is unavailable/u);
  await assert.rejects(() => store.readEncryptedVerified({ scope, blobId: pointer.blobId, expectedDigest: `sha256:${"0".repeat(64)}` }),
    /private run file blob is unavailable/u);
  bucket.addMetadata(pointer.blobId, "foreign", "unexpected");
  await assert.rejects(() => store.readEncryptedVerified({ scope, blobId: pointer.blobId, expectedDigest: digestValue }),
    /private run file blob is unavailable/u);
  bucket.removeMetadata(pointer.blobId, "foreign");
  bucket.corrupt(pointer.blobId);
  await assert.rejects(() => store.readEncryptedVerified({ scope, blobId: pointer.blobId, expectedDigest: digestValue }),
    /private run file blob is unavailable/u);
  assert.equal(bucket.putCount, 1);
  assert.equal(bucket.deleteCount, 0);
});

test("reconciles lost and racing conditional acknowledgements only after exact verification", async () => {
  const { bucket, store } = fixture();
  const bytes = new TextEncoder().encode("same race payload");
  const input = { scope, bytes, digest: await digest(bytes) };
  bucket.throwAfterPutOnce = true;
  const first = await store.putEncryptedImmutable(input);
  const same = await store.putEncryptedImmutable(input);
  assert.deepEqual(same, first);
  assert.equal(bucket.putCount, 1);
  assert.equal(bucket.deleteCount, 0);

  const concurrent = fixture();
  const raceBytes = new TextEncoder().encode("same simultaneous payload");
  const raceInput = { scope, bytes: raceBytes, digest: await digest(raceBytes) };
  const [left, right] = await Promise.all([
    concurrent.store.putEncryptedImmutable(raceInput),
    concurrent.store.putEncryptedImmutable(raceInput),
  ]);
  assert.deepEqual(left, right);
  assert.equal(concurrent.bucket.putCount, 2);
  assert.deepEqual(await concurrent.store.readEncryptedVerified({
    scope,
    blobId: left.blobId,
    expectedDigest: left.digest,
  }), { bytes: raceBytes, digest: left.digest, byteLength: raceBytes.byteLength });
});

test("hashes opaque traversal-looking scope values and rejects malformed bounds and unknown objects", async () => {
  const { bucket, store } = fixture();
  const bytes = new TextEncoder().encode("bounded");
  const digestValue = await digest(bytes);
  const opaque = await store.putEncryptedImmutable({ scope: { ...scope, slot: "../escape" }, bytes, digest: digestValue });
  assert.ok(bucket.lastKey.endsWith(opaque.blobId.slice("sha256:".length)));
  assert.equal(bucket.lastKey.includes("../escape"), false);
  await assert.rejects(() => store.putEncryptedImmutable({ scope, bytes, digest: `sha256:${"0".repeat(64)}` }),
    /private run file blob is unavailable/u);
  await assert.rejects(() => store.putEncryptedImmutable({ scope, bytes: new Uint8Array(PRIVATE_RUN_FILE_R2_MAX_BYTES + 1), digest: `sha256:${"0".repeat(64)}` }),
    /private run file blob is unavailable/u);
  const absentDigest = `sha256:${"a".repeat(64)}` as const;
  const unknown = await store.readEncryptedVerified({ scope, blobId: await blobId(scope, absentDigest), expectedDigest: absentDigest });
  assert.equal(unknown, undefined);
  assert.equal(bucket.putCount, 1);
});

async function digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function blobId(fileScope: PrivateRunFileScope, digestValue: `sha256:${string}`): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    fileScope.workspaceId,
    fileScope.capsuleId,
    fileScope.environment,
    fileScope.slot,
    digestValue,
  ]));
  return `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

interface StoredObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly customMetadata: Record<string, string>;
  readonly etag: string;
}

class FakeR2Bucket implements R2Bucket {
  readonly #objects = new Map<string, StoredObject>();
  putCount = 0;
  deleteCount = 0;
  throwAfterPutOnce = false;
  lastKey = "";

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions): Promise<R2Object | null> {
    this.lastKey = key;
    this.putCount += 1;
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.#objects.has(key)) return null;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error("test fixture expects bytes");
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value.slice(0))
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    const stored = { key, bytes, customMetadata: { ...(options?.customMetadata ?? {}) }, etag: `etag-${this.putCount}` };
    this.#objects.set(key, stored);
    if (this.throwAfterPutOnce) {
      this.throwAfterPutOnce = false;
      throw new Error("simulated lost acknowledgement");
    }
    return this.asObject(stored);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.#objects.get(key);
    if (!stored) return null;
    const bytes = stored.bytes.slice();
    return {
      ...this.asObject(stored),
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } }),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.#objects.get(key);
    return stored ? this.asObject(stored) : null;
  }

  async list(_options?: R2ListOptions): Promise<R2Objects> { return { objects: [], truncated: false }; }
  async delete(key: string): Promise<void> { this.deleteCount += 1; this.#objects.delete(key); }
  bytesFor(key: string): Uint8Array | undefined { return this.#objects.get(key)?.bytes.slice(); }
  corrupt(blobId: string): void {
    const suffix = blobId.slice("sha256:".length);
    const item = [...this.#objects.values()].find((candidate) => candidate.key.endsWith(`/${suffix}`));
    if (item) item.bytes[0] ^= 0xff;
  }
  addMetadata(blobId: string, name: string, value: string): void {
    const item = this.find(blobId);
    if (item) item.customMetadata[name] = value;
  }
  removeMetadata(blobId: string, name: string): void { delete this.find(blobId)?.customMetadata[name]; }
  private find(blobId: string): StoredObject | undefined {
    const suffix = blobId.slice("sha256:".length);
    return [...this.#objects.values()].find((candidate) => candidate.key.endsWith(`/${suffix}`));
  }

  private asObject(item: StoredObject): R2Object {
    return { key: item.key, size: item.bytes.byteLength, etag: item.etag, uploaded: new Date(0), customMetadata: { ...item.customMetadata } };
  }
}
