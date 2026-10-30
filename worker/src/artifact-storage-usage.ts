/** Optional host-owned retained-artifact measurement; no pricing or wallet. */
import { digestBytes } from "./state_crypto.ts";
import type { R2Bucket, R2ObjectBody } from "./bindings.ts";

/**
 * Who retained bytes are measured for (TASK-0118 P9.1-f). A state object
 * under a legacy `workspaces/{ws}/…` key is measured for that Workspace, as
 * it always was; one under an app's `apps/{cap}` root for that Capsule. An
 * `apps/` object is never attributed back to a Workspace. Exactly one is set.
 */
export type ArtifactStorageOwner =
  | { readonly workspaceId: string; readonly capsuleId?: undefined }
  | { readonly capsuleId: string; readonly workspaceId?: undefined };

export interface ArtifactStorageUsagePort {
  readArtifactRetention(input: ArtifactStorageOwner & {
    readonly artifactRef: `sha256:${string}`;
  }): Promise<{ readonly bytes: string; readonly acknowledgementDigest?: `sha256:${string}` } | null>;
  /** Persist intent before the artifact writer can touch object storage. */
  prepareArtifactRetention(input: ArtifactStorageOwner & {
    readonly artifactRef: `sha256:${string}`;
    readonly bytes: string;
    /** Existing objects require an already persisted intent; no new baseline. */
    readonly replayOnly: boolean;
  }): Promise<{ readonly operationRef: string; readonly state: "pending" | "confirmed" }>;
  confirmArtifactRetention(input: ArtifactStorageOwner & {
    readonly artifactRef: `sha256:${string}`;
    readonly operationRef: string;
    /** Digest of the authenticated immutable encrypted-object acknowledgement. */
    readonly acknowledgementDigest: `sha256:${string}`;
  }): Promise<void>;
  prepareArtifactRelease(input: ArtifactStorageOwner & {
    readonly artifactRef: `sha256:${string}`;
    readonly bytes: string;
  }): Promise<{ readonly operationRef: string }>;
  confirmArtifactRelease(input: ArtifactStorageOwner & {
    readonly artifactRef: `sha256:${string}`;
    readonly operationRef: string;
    readonly acknowledgementDigest: `sha256:${string}`;
  }): Promise<void>;
}

export interface PreparedArtifactRetention {
  readonly owner: ArtifactStorageOwner;
  readonly artifactRef: `sha256:${string}`;
  readonly operationRef: string;
  readonly state: "pending" | "confirmed";
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
export const ARTIFACT_STORAGE_USAGE_DEADLINE_MS = 15_000;

/** Exactly one valid owner id, as a fresh object in the canonical key order. */
function validOwner(owner: ArtifactStorageOwner | undefined): ArtifactStorageOwner | undefined {
  if (!owner || (owner.workspaceId === undefined) === (owner.capsuleId === undefined)) return undefined;
  if (owner.workspaceId !== undefined) return TOKEN.test(owner.workspaceId) ? { workspaceId: owner.workspaceId } : undefined;
  return TOKEN.test(owner.capsuleId!) ? { capsuleId: owner.capsuleId! } : undefined;
}

/**
 * The owner metadata a state object must carry. A legacy object names its
 * Workspace (`takosumi-workspace-id`). An `apps/` object names its Capsule and
 * root (`takosumi-capsule-id`, `takosumi-storage-root`); one written before
 * stage 9.1-f has no root yet and is accepted on its Capsule id alone.
 */
function ownerMetadataMatches(
  metadata: Record<string, string> | undefined,
  owner: ArtifactStorageOwner,
): boolean {
  if (owner.workspaceId !== undefined) return metadata?.["takosumi-workspace-id"] === owner.workspaceId;
  const root = metadata?.["takosumi-storage-root"];
  return metadata?.["takosumi-capsule-id"] === owner.capsuleId &&
    (root === undefined || root === `apps/${owner.capsuleId}`);
}

/** Allocation keys stay on the storage-owner side of the custody seam. */
export async function artifactStorageReference(allocatedKey: string): Promise<`sha256:${string}`> {
  if (typeof allocatedKey !== "string" || allocatedKey.length < 1 || allocatedKey.length > 4096)
    throw new Error("artifact storage identity is invalid");
  return await digestBytes(new TextEncoder().encode(JSON.stringify([
    "takosumi.artifact-storage.v1", allocatedKey,
  ]))) as `sha256:${string}`;
}

export async function prepareArtifactRetention(
  port: ArtifactStorageUsagePort | undefined,
  input: {
    readonly owner: ArtifactStorageOwner;
    readonly allocatedKey: string;
    readonly ciphertextBytes: number;
    readonly replayOnly?: boolean;
  },
): Promise<PreparedArtifactRetention | undefined> {
  if (!port) return undefined;
  const { allocatedKey, ciphertextBytes } = input;
  const owner = validOwner(input.owner);
  const replayOnly = input.replayOnly === true;
  if (!owner || !Number.isSafeInteger(ciphertextBytes) || ciphertextBytes < 0)
    throw new Error("artifact storage facts are invalid");
  const artifactRef = await artifactStorageReference(allocatedKey);
  const result = await custodyCall(() => port.prepareArtifactRetention({
    ...owner,
    artifactRef,
    bytes: String(ciphertextBytes),
    replayOnly,
  }));
  if (!result || typeof result.operationRef !== "string" || !TOKEN.test(result.operationRef) ||
    (result.state !== "pending" && result.state !== "confirmed"))
    throw new Error("artifact storage custody is unavailable");
  if (!replayOnly && result.state === "confirmed")
    throw new Error("artifact storage immutable identity conflicts");
  return { owner, artifactRef, operationRef: result.operationRef, state: result.state };
}

export async function confirmArtifactRetention(
  port: ArtifactStorageUsagePort | undefined,
  prepared: PreparedArtifactRetention | undefined,
  acknowledgementDigest: string,
): Promise<void> {
  if (!port && !prepared) return;
  if (!port || !prepared || !DIGEST.test(acknowledgementDigest))
    throw new Error("artifact storage custody is unavailable");
  await custodyCall(() => port.confirmArtifactRetention({
    ...prepared.owner, artifactRef: prepared.artifactRef, operationRef: prepared.operationRef,
    acknowledgementDigest: acknowledgementDigest as `sha256:${string}`,
  }));
}

/**
 * Owner-only deletion adapter. Unknown DELETE/HEAD acknowledgement leaves its
 * durable release intent pending; callers reconcile the same object, never
 * manufacture an absent-object zero or a new release reference.
 */
export async function releaseAcknowledgedArtifact(input: {
  readonly port: ArtifactStorageUsagePort;
  readonly bucket: R2Bucket;
  readonly owner: ArtifactStorageOwner;
  readonly allocatedKey: string;
  readonly ciphertextBytes: number;
  readonly encryptedDigest: `sha256:${string}`;
}): Promise<void> {
  const owner = validOwner(input.owner);
  if (
    !owner || !DIGEST.test(input.encryptedDigest) ||
    !Number.isSafeInteger(input.ciphertextBytes) || input.ciphertextBytes < 0
  ) throw new Error("artifact storage facts are invalid");
  const artifactRef = await artifactStorageReference(input.allocatedKey);
  const prepared = await custodyCall(() => input.port.prepareArtifactRelease({
    ...owner, artifactRef, bytes: String(input.ciphertextBytes),
  }));
  if (!prepared || typeof prepared.operationRef !== "string" || !TOKEN.test(prepared.operationRef))
    throw new Error("artifact storage custody is unavailable");
  const prior = await input.bucket.head(input.allocatedKey);
  if (prior && (
    prior.size !== input.ciphertextBytes ||
    !ownerMetadataMatches(prior.customMetadata, owner) ||
    prior.customMetadata?.["takosumi-logical-target-state-ref"] !== input.allocatedKey ||
    prior.customMetadata?.["takosumi-recovery-encrypted-digest"] !== input.encryptedDigest
  )) throw new Error("artifact storage acknowledgement is invalid");
  if (prior) await input.bucket.delete(input.allocatedKey);
  if (await input.bucket.head(input.allocatedKey) !== null)
    throw new Error("artifact storage release is unconfirmed");
  const acknowledgementDigest = await digestBytes(new TextEncoder().encode(JSON.stringify({
    kind: "takosumi.artifact-storage-release@v1",
    artifactRef, encryptedDigest: input.encryptedDigest, bytes: String(input.ciphertextBytes),
  }))) as `sha256:${string}`;
  await custodyCall(() => input.port.confirmArtifactRelease({
    ...owner, artifactRef, operationRef: prepared.operationRef, acknowledgementDigest,
  }));
}

async function custodyCall<T>(call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("artifact storage custody is unavailable")), ARTIFACT_STORAGE_USAGE_DEADLINE_MS);
      }),
    ]);
  } catch {
    // A timeout is unknown acknowledgement. No cancellation, retry or fallback.
    throw new Error("artifact storage custody is unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type ArtifactStorageUsageOptions = {
  readonly maxCiphertextBytes?: number;
};

/**
 * Only explicitly declared immutable state-version objects enter this lane.
 * The owner is the key's own allocated root: the Workspace of a legacy key, or
 * the Capsule of an `apps/{cap}` key (Core allocated it from the persisted
 * `storage_root`). An `apps/` key is never looked up back to a Workspace.
 */
function stateArtifactOwner(key: string): ArtifactStorageOwner | undefined {
  const legacy = /^workspaces\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/(?:capsules|resources)\/[A-Za-z0-9][A-Za-z0-9_.-]*\/environments\/[A-Za-z0-9][A-Za-z0-9_.-]*\/state-versions\/[0-9]{8,}\.tfstate\.enc$/u.exec(key);
  if (legacy) return { workspaceId: legacy[1]! };
  const app = /^apps\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/environments\/[A-Za-z0-9][A-Za-z0-9_.-]*\/state-versions\/[0-9]{8,}\.tfstate\.enc$/u.exec(key);
  return app ? { capsuleId: app[1]! } : undefined;
}

/**
 * Decorates the real host R2 binding. Read methods and out-of-scope objects are
 * unchanged; only acknowledged immutable state bytes feed this declared lane.
 * No browser/provider request can choose the custody port or mutation facts.
 */
export function artifactStorageUsageBucket(bucket: R2Bucket, port: ArtifactStorageUsagePort | undefined,
  usageOptions: ArtifactStorageUsageOptions = {}): R2Bucket {
  if (!port) return bucket;
  const cap = usageOptions.maxCiphertextBytes ?? 64 * 1024 * 1024 + 33;
  if (!Number.isSafeInteger(cap) || cap < 1)
    throw new Error("artifact storage source byte bound is unavailable");
  const reconcile = async (object: R2ObjectBody, key: string, owner: ArtifactStorageOwner,
    prepared?: PreparedArtifactRetention, expectedDigest?: string): Promise<R2ObjectBody> => {
    const metadata = object.customMetadata;
    if (object.key !== key || !Number.isSafeInteger(object.size) || object.size < 0 || object.size > cap ||
      !metadata || !ownerMetadataMatches(metadata, owner) ||
      metadata["takosumi-logical-target-state-ref"] !== key ||
      metadata["takosumi-ciphertext-length"] !== String(object.size) ||
      !DIGEST.test(metadata["takosumi-storage-observation-digest"] ?? "") ||
      typeof object.etag !== "string" || object.etag.length < 1)
      throw new Error("artifact storage acknowledgement is invalid");
    const bytes = await boundedObjectBytes(object, cap);
    const digest = await digestBytes(bytes);
    if (bytes.byteLength !== object.size || digest !== metadata["takosumi-storage-observation-digest"] ||
      (expectedDigest !== undefined && digest !== expectedDigest))
      throw new Error("artifact storage acknowledgement is invalid");
    const retained = prepared ?? await prepareArtifactRetention(port, {
      owner, allocatedKey: key, ciphertextBytes: bytes.byteLength, replayOnly: true,
    });
    await confirmArtifactRetention(port, retained, digest);
    // The authenticated readback remains readable for the owning decryptor.
    return {
      key: object.key, size: object.size, etag: object.etag, uploaded: object.uploaded,
      customMetadata: { ...metadata }, httpMetadata: { ...object.httpMetadata },
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    } as R2ObjectBody;
  };
  return {
    async get(key) {
      const owner = stateArtifactOwner(key);
      const object = await bucket.get(key);
      if (!object || !owner) return object;
      // A completed-state adoption after a lost billing ACK must converge the
      // existing raw receipt before publishing terminal artifact authority.
      return await reconcile(object, key, owner);
    },
    head: key => bucket.head(key),
    list: options => bucket.list(options),
    async put(key, value, options) {
      if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value))
        throw new Error("artifact storage source requires exact encrypted bytes");
      // Snapshot mutable inputs before the first await, so the caller cannot
      // change the bytes or metadata that the eventual receipt describes.
      const bytes = new Uint8Array(value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      const metadataInput = { ...options?.customMetadata };
      const putOptions = options === undefined ? undefined : {
        ...options, httpMetadata: { ...options.httpMetadata },
        onlyIf: options.onlyIf === undefined ? undefined : { ...options.onlyIf },
      };
      const owner = stateArtifactOwner(key);
      if (!owner) return await bucket.put(key, value, options);
      if (
        !ownerMetadataMatches(metadataInput, owner) ||
        metadataInput["takosumi-logical-target-state-ref"] !== key ||
        metadataInput["takosumi-ciphertext-length"] !== String(bytes.byteLength)
      ) throw new Error("artifact storage acknowledgement is invalid");
      if (putOptions?.onlyIf !== undefined &&
        (Object.keys(putOptions.onlyIf).length !== 1 || putOptions.onlyIf.etagDoesNotMatch !== "*"))
        throw new Error("artifact storage source requires an immutable create condition");
      const encryptedDigest = await digestBytes(bytes);
      const prior = await bucket.head(key);
      if (prior && (prior.size !== bytes.byteLength ||
        prior.customMetadata?.["takosumi-storage-observation-digest"] !== encryptedDigest ||
        !ownerMetadataMatches(prior.customMetadata, owner) ||
        prior.customMetadata["takosumi-logical-target-state-ref"] !== key))
        throw new Error("artifact storage immutable identity conflicts");
      const prepared = await prepareArtifactRetention(port, {
        owner, allocatedKey: key, ciphertextBytes: bytes.byteLength,
        replayOnly: prior !== null,
      });
      const metadata = { ...metadataInput, "takosumi-storage-observation-digest": encryptedDigest };
      let writeResult: Awaited<ReturnType<R2Bucket["put"]>>;
      try {
        writeResult = prior
          ? (putOptions?.onlyIf === undefined ? prior : null)
          : await bucket.put(key, bytes, { ...putOptions, customMetadata: metadata,
            onlyIf: { etagDoesNotMatch: "*" } });
      } catch {
        // One readback reconciles a lost PUT ACK; never repeat the physical PUT.
        writeResult = await bucket.head(key);
        if (!writeResult) throw new Error("artifact storage write is unconfirmed");
      }
      const observed = await bucket.get(key);
      if (!observed) throw new Error("artifact storage write is unconfirmed");
      const acknowledged = await reconcile(observed, key, owner, prepared, encryptedDigest);
      // A failed condition remains null, while exact existing custody recovers.
      return writeResult === null ? null : acknowledged;
    },
    async delete(key) {
      const owner = stateArtifactOwner(key);
      if (!owner) return await bucket.delete(key);
      const prior = await bucket.head(key);
      const artifactRef = await artifactStorageReference(key);
      const retained = await custodyCall(() => port.readArtifactRetention({ ...owner, artifactRef }));
      if (!retained) {
        if (prior) throw new Error("artifact storage inventory is unavailable");
        // There was no registered retention and no physical object to change.
        // This supplies no zero-quantity or closed-period proof.
        return;
      }
      if (typeof retained.bytes !== "string" || retained.bytes.length > 256 ||
        !/^(0|[1-9][0-9]*)$/u.test(retained.bytes) ||
        BigInt(retained.bytes) > BigInt(Number.MAX_SAFE_INTEGER) ||
        !retained.acknowledgementDigest || !DIGEST.test(retained.acknowledgementDigest))
        throw new Error("artifact storage custody is unavailable");
      if (prior && (
        prior.customMetadata?.["takosumi-storage-observation-digest"] !== retained.acknowledgementDigest ||
        !ownerMetadataMatches(prior.customMetadata, owner) ||
        prior.customMetadata["takosumi-logical-target-state-ref"] !== key
      )) throw new Error("artifact storage acknowledgement is invalid");
      const operation = await custodyCall(() => port.prepareArtifactRelease({ ...owner, artifactRef, bytes: retained.bytes }));
      if (!operation || typeof operation.operationRef !== "string" || !TOKEN.test(operation.operationRef))
        throw new Error("artifact storage custody is unavailable");
      if (prior) await bucket.delete(key);
      if (await bucket.head(key) !== null) throw new Error("artifact storage release is unconfirmed");
      const acknowledgementDigest = await digestBytes(new TextEncoder().encode(JSON.stringify([
        "takosumi.artifact-storage-release.v1", artifactRef, retained.bytes, retained.acknowledgementDigest,
      ]))) as `sha256:${string}`;
      await custodyCall(() => port.confirmArtifactRelease({ ...owner, artifactRef,
        operationRef: operation.operationRef, acknowledgementDigest }));
    },
  };
}

async function boundedObjectBytes(object: R2ObjectBody, cap: number): Promise<Uint8Array> {
  const body = (object as R2ObjectBody & { readonly body?: ReadableStream<Uint8Array> }).body;
  if (!body) {
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > cap) throw new Error("artifact storage acknowledgement is invalid");
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > cap) {
        await reader.cancel();
        throw new Error("artifact storage acknowledgement is invalid");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
