import assert from "node:assert/strict";
import { test } from "bun:test";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import type { R2Bucket, R2ListOptions, R2Object, R2ObjectBody, R2Objects, R2PutOptions } from "../../../worker/src/bindings.ts";
import {
  RECOVERY_STATE_MAX_BYTES,
  R2RecoveryStateArtifactStore,
  type StageRecoveryStateInput,
} from "../../../worker/src/state_recovery_artifact_store.ts";
import { digestBytes, StateArtifactCrypto } from "../../../worker/src/state_crypto.ts";

const PASSPHRASE = "takosumi-state-recovery-adapter-tests-0123456789abcdef";
const encoder = new TextEncoder();
function stateBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(JSON.stringify({
    version: 4,
    terraform_version: "1.9.8",
    serial: 2,
    lineage: "b8d6c5f4-8f27-4d16-8b90-839c7f770001",
    outputs: {},
    resources: [{
      mode: "managed",
      type: "example_resource",
      name: "fixture",
      provider: "provider[\"registry.example/example\"]",
      instances: [{ schema_version: 0, attributes: {} }],
    }],
    ...overrides,
  }));
}

async function fixture(plaintext = stateBytes()) {
  const bucket = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
  });
  const store = new R2RecoveryStateArtifactStore({
    bucket,
    crypto,
    allocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const input: StageRecoveryStateInput = {
    workspaceId: "workspace_recovery_test",
    capsuleId: "capsule_recovery_test",
    environment: "production",
    generation: 1,
    failedApplyRunId: "apply_failed_test",
    recoveryRunId: "run_recovery_test",
    plaintextSha256: await digestBytes(plaintext),
    custodyEvidenceDigest: `sha256:${"a".repeat(64)}`,
    plaintext,
  };
  return { bucket, crypto, store, input };
}

test("stages encrypted generation-one state and verifies exact bounded readback", async () => {
  const { bucket, store, input } = await fixture();
  const staged = await store.stage(input);
  assert.equal(bucket.putCount, 1);
  assert.equal(staged.artifact.stateRef,
    "workspaces/workspace_recovery_test/capsules/capsule_recovery_test/environments/production/state-versions/00000001.tfstate.enc");
  assert.equal(staged.artifact.plaintextSha256, input.plaintextSha256);
  assert.equal(staged.artifact.encryptedDigest, await digestBytes(bucket.bytesFor(staged.artifact.stateRef)!));
  assert.notDeepEqual(bucket.bytesFor(staged.artifact.stateRef), input.plaintext);
  assert.deepEqual(await store.verify({
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    failedApplyRunId: input.failedApplyRunId,
    recoveryRunId: input.recoveryRunId,
    artifactHandle: staged.handle,
  }), staged.artifact);
});

test("conditional no-overwrite reconciles an exact retry without a second PUT", async () => {
  const { bucket, store, input } = await fixture();
  const first = await store.stage(input);
  const retry = await store.stage(input);
  assert.deepEqual(retry, first);
  assert.equal(bucket.putCount, 1);
  assert.equal(bucket.deleteCount, 0);
});

test("opaque handle round-trips every dotted scope identifier", async () => {
  const { store, input } = await fixture();
  const dottedInput: StageRecoveryStateInput = {
    ...input,
    workspaceId: "workspace.with.dots",
    capsuleId: "capsule.with.dots",
    environment: "production.eu.west",
    failedApplyRunId: "apply.failed.create",
    recoveryRunId: "run.recovery.1",
  };
  const staged = await store.stage(dottedInput);
  assert.deepEqual(await store.verify({
    workspaceId: dottedInput.workspaceId,
    capsuleId: dottedInput.capsuleId,
    failedApplyRunId: dottedInput.failedApplyRunId,
    recoveryRunId: dottedInput.recoveryRunId,
    artifactHandle: staged.handle,
  }), staged.artifact);
});

test("rejects scope components that normalize or make the canonical key unsafe", async () => {
  const { bucket, store, input } = await fixture();
  const allocator = new ObjectKeyArtifactReferenceAllocator();
  const allocation = {
    kind: "state" as const,
    subject: { kind: "capsule" as const, id: "capsule_recovery_test" },
    environment: "production",
    generation: 1,
  };
  assert.equal(
    allocator.allocate({ ...allocation, workspaceId: "workspace:collision" }),
    allocator.allocate({ ...allocation, workspaceId: "workspace_collision" }),
  );

  await assert.rejects(
    () => store.stage({ ...input, workspaceId: "workspace:collision" }),
    /recovery state scope is invalid/u,
  );
  await assert.rejects(
    () => store.stage({ ...input, environment: "production..blue" }),
    /recovery state scope is invalid/u,
  );
  assert.equal(bucket.putCount, 0);
});

test("unknown PUT acknowledgement reconciles the committed exact object", async () => {
  const { bucket, store, input } = await fixture();
  bucket.throwAfterPutOnce = true;
  const staged = await store.stage(input);
  assert.equal(bucket.putCount, 1);
  assert.equal(staged.artifact.plaintextSha256, input.plaintextSha256);
});

test("refuses a pre-existing object whose metadata or plaintext differs without overwrite", async () => {
  const { bucket, store, input } = await fixture();
  const first = await store.stage(input);
  bucket.corruptMetadata(first.artifact.stateRef, "takosumi-recovery-failed-apply-run-id", "other_apply");
  await assert.rejects(() => store.stage(input), /recovery state artifact metadata is invalid/u);
  assert.equal(bucket.putCount, 1);
  assert.equal(bucket.deleteCount, 0);
});

test("refuses a retry with changed custody identity before writing another ciphertext", async () => {
  const { bucket, store, input } = await fixture();
  await store.stage(input);
  await assert.rejects(() => store.stage({
    ...input,
    custodyEvidenceDigest: `sha256:${"b".repeat(64)}`,
  }), /recovery state artifact metadata is invalid/u);
  assert.equal(bucket.putCount, 1);
});

test("refuses tampered ciphertext, wrong scope, wrong handle, and digest mismatch", async () => {
  const { bucket, store, input } = await fixture();
  const staged = await store.stage(input);
  await assert.rejects(() => store.verify({
    workspaceId: input.workspaceId,
    capsuleId: "capsule_other",
    failedApplyRunId: input.failedApplyRunId,
    recoveryRunId: input.recoveryRunId,
    artifactHandle: staged.handle,
  }), /staged recovery artifact is unavailable/u);
  await assert.rejects(() => store.verify({
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    failedApplyRunId: input.failedApplyRunId,
    recoveryRunId: input.recoveryRunId,
    artifactHandle: "sha256:forged",
  }), /staged recovery artifact is unavailable/u);
  bucket.corruptBytes(staged.artifact.stateRef);
  await assert.rejects(() => store.verify({
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    failedApplyRunId: input.failedApplyRunId,
    recoveryRunId: input.recoveryRunId,
    artifactHandle: staged.handle,
  }), /recovery state artifact decryption failed/u);
});

test("rejects malformed state, invalid scope, plaintext mismatch, and over-bound state", async () => {
  const malformed = await fixture(encoder.encode('{"version":4,"serial":2,"resources":[]}'));
  await assert.rejects(() => malformed.store.stage(malformed.input), /recovery state payload is invalid/u);

  const { store, input } = await fixture();
  await assert.rejects(() => store.stage({ ...input, generation: 2 as 1 }), /recovery state scope is invalid/u);
  await assert.rejects(() => store.stage({ ...input, plaintextSha256: `sha256:${"0".repeat(64)}` }), /recovery state plaintext digest is invalid/u);
  await assert.rejects(() => store.stage({
    ...input,
    plaintext: new Uint8Array(RECOVERY_STATE_MAX_BYTES + 1),
  }), /recovery state payload is invalid/u);
});

test("failed conditional conflict does not overwrite an object", async () => {
  const { bucket, store, input } = await fixture();
  bucket.writeConflictingObject = true;
  await assert.rejects(() => store.stage(input), /recovery state artifact metadata is invalid/u);
  assert.equal(bucket.putCount, 1);
  assert.equal(bucket.deleteCount, 0);
});

interface StoredObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly customMetadata: Record<string, string>;
  readonly contentType: string;
  readonly etag: string;
}

class FakeR2Bucket implements R2Bucket {
  readonly #objects = new Map<string, StoredObject>();
  putCount = 0;
  deleteCount = 0;
  throwAfterPutOnce = false;
  writeConflictingObject = false;

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    this.putCount += 1;
    if (this.writeConflictingObject) {
      this.#objects.set(key, {
        key,
        bytes: new Uint8Array([1]),
        customMetadata: { forged: "metadata" },
        contentType: "application/octet-stream",
        etag: `racer-${this.putCount}`,
      });
      this.writeConflictingObject = false;
    }
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.#objects.has(key)) return null;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
      throw new Error("test fake accepts byte arrays only");
    }
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value.slice(0))
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.#objects.set(key, {
      key,
      bytes,
      customMetadata: { ...(options?.customMetadata ?? {}) },
      contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
      etag: `etag-${this.putCount}`,
    });
    if (this.throwAfterPutOnce) {
      this.throwAfterPutOnce = false;
      throw new Error("simulated lost acknowledgement");
    }
    return this.asObject(this.#objects.get(key)!);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.#objects.get(key);
    if (!object) return null;
    const body = object.bytes.slice();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(body); controller.close(); },
    });
    const result: R2ObjectBody & { readonly body: ReadableStream<Uint8Array> } = {
      ...this.asObject(object),
      body: stream,
      arrayBuffer: async () => body.slice().buffer,
    };
    return result;
  }

  async head(key: string): Promise<R2Object | null> {
    const object = this.#objects.get(key);
    return object ? this.asObject(object) : null;
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const values = [...this.#objects.values()].filter((object) => object.key.startsWith(options?.prefix ?? ""));
    const limit = options?.limit ?? values.length;
    return { objects: values.slice(0, limit).map((object) => this.asObject(object)), truncated: values.length > limit };
  }

  async delete(key: string): Promise<void> {
    this.deleteCount += 1;
    this.#objects.delete(key);
  }

  bytesFor(key: string): Uint8Array | undefined {
    return this.#objects.get(key)?.bytes.slice();
  }

  corruptMetadata(key: string, name: string, value: string): void {
    const object = this.#objects.get(key);
    if (object) this.#objects.set(key, { ...object, customMetadata: { ...object.customMetadata, [name]: value } });
  }

  corruptBytes(key: string): void {
    const object = this.#objects.get(key);
    if (object) {
      const bytes = object.bytes.slice();
      const lastIndex = bytes.length - 1;
      bytes[lastIndex] = bytes[lastIndex]! ^ 1;
      this.#objects.set(key, { ...object, bytes });
    }
  }

  private asObject(object: StoredObject): R2Object {
      return {
      key: object.key,
      version: "v1",
      size: object.bytes.byteLength,
      etag: object.etag,
      httpEtag: `"${object.etag}"`,
      checksums: {},
      uploaded: new Date(0),
      httpMetadata: { contentType: object.contentType },
      customMetadata: { ...object.customMetadata },
      storageClass: "Standard",
      writeHttpMetadata(headers: Headers) { headers.set("content-type", object.contentType); },
    } as R2Object;
  }
}
