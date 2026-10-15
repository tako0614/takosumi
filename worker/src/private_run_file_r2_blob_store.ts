/**
 * Encrypted R2 blob adapter for private Run files. Cloud Worker composition
 * mounts it only through an explicit host option; the default composition
 * remains disabled. This opt-in does not qualify R2 retention, restart
 * durability, or the Cloud Runner path.
 */
import { PartitionedSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import type { PrivateRunFileAuthority, PrivateRunFileBlobPort, PrivateRunFileDigest, PrivateRunFileRepositoryPort, PrivateRunFileScope } from "../../core/domains/private-run-files/mod.ts";
import type { R2Bucket, R2ObjectBody } from "./bindings.ts";
import { storedServiceUsageBucket, type StoredServiceComposition } from "./stored-service-usage.ts";

export const PRIVATE_RUN_FILE_R2_MAX_BYTES = 16 * 1024 * 1024;
const PURPOSE = "takosumi.private-run-files.r2-blob@v1";
const FORMAT = "takosumi-private-run-file-r2@v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_SCOPE_COMPONENT_BYTES = 1024;
const ENCRYPTION_OVERHEAD_BYTES = 28; // 12-byte IV + 16-byte AES-GCM tag.
const encoder = new TextEncoder();

export class R2PrivateRunFileBlobStore implements PrivateRunFileBlobPort {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #storageUsage: StoredServiceComposition | undefined;
  readonly #writeAuthority: Pick<PrivateRunFileRepositoryPort, "readPointer"> | undefined;
  readonly #crypto: PartitionedSecretBoundaryCrypto;
  readonly #maxBytes: number;

  constructor(input: {
    readonly bucket: R2Bucket;
    readonly prefix: string;
    readonly storageUsage?: StoredServiceComposition;
    readonly writeAuthority?: Pick<PrivateRunFileRepositoryPort, "readPointer">;
    readonly cryptoBoundary: PartitionedSecretBoundaryCrypto;
    readonly maxBytes: number;
  }) {
    if (!(input.cryptoBoundary instanceof PartitionedSecretBoundaryCrypto)) {
      throw blobError();
    }
    validatePrefix(input.prefix);
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > PRIVATE_RUN_FILE_R2_MAX_BYTES) {
      throw blobError();
    }
    this.#bucket = input.bucket;
    this.#prefix = input.prefix;
    this.#storageUsage = input.storageUsage;
    this.#writeAuthority = input.writeAuthority;
    if (this.#storageUsage && !this.#writeAuthority) throw blobError();
    this.#crypto = input.cryptoBoundary;
    this.#maxBytes = input.maxBytes;
  }

  async putEncryptedImmutable(input: {
    readonly scope: PrivateRunFileScope;
    readonly authority?: PrivateRunFileAuthority;
    readonly bytes: Uint8Array;
    readonly digest: PrivateRunFileDigest;
  }): Promise<{ readonly blobId: string; readonly digest: PrivateRunFileDigest; readonly byteLength: number }> {
    const bytes = input.bytes.slice();
    const scope = { ...input.scope };
    const authority = input.authority === undefined ? undefined : { ...input.authority };
    const requestedDigest = input.digest;
    validateRequest(scope, bytes, requestedDigest, this.#maxBytes);
    const ownerWorkspaceId = scope.workspaceId;
    const assertWriteAuthority = async (): Promise<void> => {
      if (!this.#storageUsage) return;
      if (!authority || !this.#writeAuthority) throw blobError();
      let current;
      try { current = await this.#writeAuthority.readPointer({ scope, ...authority }); }
      catch { throw blobError(); }
      if (current.kind !== "present" && current.kind !== "absent") throw blobError();
    };
    const actualDigest = await digestBytes(bytes);
    if (actualDigest !== requestedDigest) throw blobError();

    const identity = await identityFor(scope, requestedDigest);
    const key = `${this.#prefix}/${identity}`;
    const aad = await aadFor(scope, requestedDigest, bytes.byteLength);
    const scopeDigest = await scopeDigestFor(scope);

    const bucket = storedServiceUsageBucket(this.#bucket, this.#storageUsage, {
      bucketRole: "artifacts", writerId: "private-run-files", workspaceId: ownerWorkspaceId,
      beforePrepare: assertWriteAuthority, beforeDispatch: assertWriteAuthority,
    });
    let existing: R2ObjectBody | null;
    try {
      existing = await bucket.get(key);
    } catch {
      throw blobError();
    }
    if (existing) {
      await this.#verify(existing, key, requestedDigest, bytes.byteLength, aad, scopeDigest, bytes);
      return { blobId: `sha256:${identity}`, digest: requestedDigest, byteLength: bytes.byteLength };
    }

    const sealed = await this.#seal(bytes, aad);
    if (sealed.byteLength !== encodedLength(bytes.byteLength) + ENCRYPTION_OVERHEAD_BYTES ||
      sealed.byteLength > encodedLength(this.#maxBytes) + ENCRYPTION_OVERHEAD_BYTES) throw blobError();
    const metadata = {
      format: FORMAT,
      scope: scopeDigest,
      digest: requestedDigest,
      byteLength: String(bytes.byteLength),
    };
    try {
      await bucket.put(key, sealed, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: metadata,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      // A null result means another writer occupied the immutable identity.
      // The readback below accepts it only if scope, digest, length and bytes
      // all match exactly.
    } catch {
      // The write may have committed while its acknowledgement was lost.
      // Reconcile the same immutable key; never retry the PUT or delete it.
    }
    const readback = await bucket.get(key);
    if (!readback) throw blobError();
    await this.#verify(readback, key, requestedDigest, bytes.byteLength, aad, scopeDigest, bytes);
    return { blobId: `sha256:${identity}`, digest: requestedDigest, byteLength: bytes.byteLength };
  }

  async readEncryptedVerified(input: {
    readonly scope: PrivateRunFileScope;
    readonly blobId: string;
    readonly expectedDigest: PrivateRunFileDigest;
  }): Promise<{ readonly bytes: Uint8Array; readonly digest: PrivateRunFileDigest; readonly byteLength: number } | undefined> {
    validateScope(input.scope);
    const ownerWorkspaceId = input.scope.workspaceId;
    if (!isDigest(input.expectedDigest) || !isBlobId(input.blobId)) throw blobError();
    const identity = await identityFor(input.scope, input.expectedDigest);
    if (input.blobId !== `sha256:${identity}`) throw blobError();
    const key = `${this.#prefix}/${identity}`;
    let object: R2ObjectBody | null;
    try {
      object = await storedServiceUsageBucket(this.#bucket, this.#storageUsage, {
        bucketRole: "artifacts", writerId: "private-run-files", workspaceId: ownerWorkspaceId,
      }).get(key);
    } catch {
      throw blobError();
    }
    if (!object) return undefined;
    const metadata = object.customMetadata;
    if (!metadata || metadata.format !== FORMAT || metadata.scope !== await scopeDigestFor(input.scope) ||
      metadata.digest !== input.expectedDigest || !isCanonicalLength(metadata.byteLength)) throw blobError();
    const byteLength = Number(metadata.byteLength);
    if (byteLength > this.#maxBytes || byteLength < 0) throw blobError();
    const aad = await aadFor(input.scope, input.expectedDigest, byteLength);
    const bytes = await this.#verify(object, key, input.expectedDigest, byteLength, aad, metadata.scope);
    return { bytes, digest: input.expectedDigest, byteLength };
  }

  async #seal(bytes: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    try {
      // The existing authenticated crypto boundary accepts strings. Encode
      // bytes as canonical base64url *inside* its authenticated ciphertext.
      return await this.#crypto.seal(encodeBase64Url(bytes), PURPOSE, aad);
    } catch {
      throw blobError();
    }
  }

  async #open(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    try {
      const encoded = await this.#crypto.open(ciphertext, PURPOSE, aad);
      return decodeBase64Url(encoded, this.#maxBytes);
    } catch {
      throw blobError();
    }
  }

  async #verify(
    object: R2ObjectBody,
    key: string,
    digest: PrivateRunFileDigest,
    byteLength: number,
    aad: Uint8Array,
    scopeDigest: string,
    expectedBytes?: Uint8Array,
  ): Promise<Uint8Array> {
    const metadata = object.customMetadata;
    const expectedCiphertextLength = encodedLength(byteLength) + ENCRYPTION_OVERHEAD_BYTES;
    if (object.key !== key || object.size !== expectedCiphertextLength || object.size > encodedLength(this.#maxBytes) + ENCRYPTION_OVERHEAD_BYTES ||
      !metadata || Object.keys(metadata).length !== 4 || metadata.format !== FORMAT || metadata.scope !== scopeDigest ||
      metadata.digest !== digest || metadata.byteLength !== String(byteLength)) throw blobError();
    let ciphertext: Uint8Array;
    try {
      const maxCiphertextBytes = encodedLength(this.#maxBytes) + ENCRYPTION_OVERHEAD_BYTES;
      const body = (object as R2ObjectBody & { readonly body?: ReadableStream<Uint8Array> }).body;
      if (body) {
        ciphertext = await readBoundedStream(body, maxCiphertextBytes);
      } else {
        const buffer = await object.arrayBuffer();
        if (buffer.byteLength > maxCiphertextBytes) throw blobError();
        ciphertext = new Uint8Array(buffer);
      }
      if (ciphertext.byteLength !== object.size || ciphertext.byteLength > maxCiphertextBytes) throw blobError();
    } catch {
      throw blobError();
    }
    const plaintext = await this.#open(ciphertext, aad);
    if (plaintext.byteLength !== byteLength || await digestBytes(plaintext) !== digest ||
      (expectedBytes !== undefined && !constantBytesEqual(plaintext, expectedBytes))) throw blobError();
    return plaintext.slice();
  }
}

async function identityFor(scope: PrivateRunFileScope, digest: PrivateRunFileDigest): Promise<string> {
  return hex(await sha256(encoder.encode(JSON.stringify([scope.workspaceId, scope.capsuleId, scope.environment, scope.slot, digest]))));
}

async function scopeDigestFor(scope: PrivateRunFileScope): Promise<string> {
  return `sha256:${hex(await sha256(encoder.encode(JSON.stringify([scope.workspaceId, scope.capsuleId, scope.environment, scope.slot]))))}`;
}

async function aadFor(scope: PrivateRunFileScope, digest: PrivateRunFileDigest, byteLength: number): Promise<Uint8Array> {
  return encoder.encode(JSON.stringify([PURPOSE, scope.workspaceId, scope.capsuleId, scope.environment, scope.slot, digest, byteLength]));
}

async function digestBytes(bytes: Uint8Array): Promise<PrivateRunFileDigest> {
  return `sha256:${hex(await sha256(bytes))}`;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
}

function validateRequest(scope: PrivateRunFileScope, bytes: Uint8Array, digest: string, maxBytes: number): void {
  validateScope(scope);
  if (!isDigest(digest) || bytes.byteLength > maxBytes) throw blobError();
}

function validateScope(scope: PrivateRunFileScope): void {
  for (const value of [scope?.workspaceId, scope?.capsuleId, scope?.environment, scope?.slot]) {
    if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > MAX_SCOPE_COMPONENT_BYTES || value.includes("\u0000")) {
      throw blobError();
    }
  }
}

function validatePrefix(prefix: string): void {
  if (!prefix || prefix.length > 240 || prefix.startsWith("/") || prefix.endsWith("/") || prefix.includes("\\")) throw blobError();
  const segments = prefix.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/u.test(segment))) throw blobError();
}

function isDigest(value: string): value is PrivateRunFileDigest { return SHA256.test(value); }
function isBlobId(value: string): boolean { return /^sha256:[0-9a-f]{64}$/u.test(value); }
function isCanonicalLength(value: string | undefined): value is string { return value !== undefined && /^(0|[1-9][0-9]*)$/u.test(value); }
function encodedLength(byteLength: number): number { return Math.ceil(byteLength * 4 / 3); }
function hex(bytes: Uint8Array): string { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length > encodedLength(maxBytes)) throw blobError();
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(padded); } catch { throw blobError(); }
  if (binary.length > maxBytes) throw blobError();
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw blobError();
  return bytes;
}

function constantBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) mismatch |= left[index]! ^ right[index]!;
  return mismatch === 0;
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw blobError();
      }
      chunks.push(value.slice());
    }
  } catch {
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
    throw blobError();
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function blobError(): Error { return new Error("private run file blob is unavailable"); }
