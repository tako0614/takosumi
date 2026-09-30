/**
 * Worker-owned R2 adapter for staging and verifying one failed-create state.
 * This adapter never dispatches a runner, imports a provider resource, or
 * follows a caller-supplied object key. The only object coordinate comes from
 * the host's ArtifactReferenceAllocator.
 */
import type { ArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import {
  VERIFIED_RECOVERY_ARTIFACT_FORMAT,
  type RecoveryArtifactVerifier,
  type VerifiedRecoveryArtifact,
} from "../../core/domains/deploy-control/operator_state_recovery.ts";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";
import type { R2Bucket, R2Object, R2ObjectBody } from "./bindings.ts";
import {
  digestBytes,
  maxStateArtifactCiphertextBytes,
  StateArtifactCrypto,
} from "./state_crypto.ts";

export const RECOVERY_STATE_MAX_BYTES = 16 * 1024 * 1024;
const RECOVERY_STATE_CIPHERTEXT_MAX_BYTES =
  maxStateArtifactCiphertextBytes(RECOVERY_STATE_MAX_BYTES);
const RECOVERY_METADATA = {
  format: "takosumi-state-recovery-artifact@v1",
  action: "state_recovery",
  contentType: "application/vnd.terraform.state",
  encryptedContentType: "application/octet-stream",
} as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface RecoveryStateArtifactScope {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: 1;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  readonly plaintextSha256: `sha256:${string}`;
  /** Digest of bounded, operator-preserved, value-free custody evidence. */
  readonly custodyEvidenceDigest: `sha256:${string}`;
}

export interface StageRecoveryStateInput extends RecoveryStateArtifactScope {
  readonly plaintext: Uint8Array;
}

export interface StagedRecoveryStateArtifact {
  /** Opaque, deterministic retry handle; it is not an object key or URL. */
  readonly handle: string;
  readonly artifact: VerifiedRecoveryArtifact;
}

/**
 * Stages plaintext bytes under the sole allocated generation-1 Capsule state
 * ref, then verifies the encrypted object by bounded readback and decryption.
 */
export class R2RecoveryStateArtifactStore implements RecoveryArtifactVerifier {
  readonly #bucket: R2Bucket;
  readonly #crypto: StateArtifactCrypto;
  readonly #allocator: ArtifactReferenceAllocator;

  constructor(input: {
    readonly bucket: R2Bucket;
    readonly crypto: StateArtifactCrypto;
    readonly allocator: ArtifactReferenceAllocator;
  }) {
    this.#bucket = input.bucket;
    this.#crypto = input.crypto;
    this.#allocator = input.allocator;
  }

  async stage(input: StageRecoveryStateInput): Promise<StagedRecoveryStateArtifact> {
    const scope = input;
    validateScope(scope);
    validateOpenTofuState(input.plaintext);
    const plaintextSha256 = await digestBytes(input.plaintext);
    if (plaintextSha256 !== scope.plaintextSha256) {
      throw recoveryArtifactError("recovery state plaintext digest is invalid");
    }
    const stateRef = await this.#allocate(scope);
    const handle = await handleFor(scope, stateRef);
    // Reconcile an earlier committed stage before encrypting. An unknown PUT
    // acknowledgement therefore never causes a fresh ciphertext identity.
    let prior: R2Object | null;
    try {
      prior = await this.#bucket.head(stateRef);
    } catch {
      throw recoveryArtifactError("recovery state artifact lookup failed");
    }
    if (prior) {
      let existing: R2ObjectBody | null;
      try {
        existing = await this.#bucket.get(stateRef);
      } catch {
        throw recoveryArtifactError("recovery state artifact readback failed");
      }
      if (!existing) throw recoveryArtifactError("recovery state artifact readback is missing");
      return {
        handle,
        artifact: await this.#verifyObject(existing, scope, stateRef, handle, input.plaintext),
      };
    }
    let sealed: Awaited<ReturnType<StateArtifactCrypto["seal"]>>;
    try {
      sealed = await this.#crypto.seal(input.plaintext);
    } catch {
      throw recoveryArtifactError("recovery state encryption failed");
    }
    const encryptedDigest = await digestBytes(sealed.ciphertext);
    const metadata = recoveryMetadata(scope, stateRef, sealed, encryptedDigest, handle);
    try {
      const put = await this.#bucket.put(stateRef, sealed.ciphertext, {
        httpMetadata: { contentType: RECOVERY_METADATA.encryptedContentType },
        customMetadata: metadata,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (!put) {
        const winner = await this.#readback(stateRef);
        if (!winner) throw recoveryArtifactError("recovery state artifact write was not acknowledged");
        return {
          handle,
          artifact: await this.#verifyObject(winner, scope, stateRef, handle, input.plaintext),
        };
      }
    } catch {
      // A conditional write or its acknowledgement can be lost after R2 has
      // committed. Reconcile only the exact allocated identity; never retry a
      // blind PUT or mint a second ciphertext for that identity.
      const winner = await this.#readback(stateRef);
      if (!winner) throw recoveryArtifactError("recovery state artifact write failed");
      return {
        handle,
        artifact: await this.#verifyObject(winner, scope, stateRef, handle, input.plaintext),
      };
    }
    const readback = await this.#readback(stateRef);
    if (!readback) throw recoveryArtifactError("recovery state artifact readback is missing");
    return {
      handle,
      artifact: await this.#verifyObject(readback, scope, stateRef, handle, input.plaintext),
    };
  }

  async verify(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly failedApplyRunId: string;
    readonly recoveryRunId: string;
    readonly artifactHandle: string;
  }): Promise<VerifiedRecoveryArtifact> {
    const metadataScope = {
      workspaceId: input.workspaceId,
      capsuleId: input.capsuleId,
      failedApplyRunId: input.failedApplyRunId,
      recoveryRunId: input.recoveryRunId,
    };
    requireIdentifier(input.workspaceId);
    requireIdentifier(input.capsuleId);
    requireIdentifier(input.failedApplyRunId);
    requireIdentifier(input.recoveryRunId);
    const handleParts = recoveryHandleParts(input.artifactHandle);
    if (
      handleParts.workspaceId !== input.workspaceId || handleParts.capsuleId !== input.capsuleId ||
      handleParts.failedApplyRunId !== input.failedApplyRunId || handleParts.recoveryRunId !== input.recoveryRunId
    ) throw recoveryArtifactError("staged recovery artifact is unavailable");
    const environment = handleParts.environment;
    const provisionalScope = {
      ...metadataScope,
      environment,
      generation: 1 as const,
      plaintextSha256: handleParts.plaintextSha256,
      custodyEvidenceDigest: handleParts.custodyEvidenceDigest,
    };
    const stateRef = await this.#allocate(provisionalScope);
    const object = await this.#readback(stateRef);
    if (!object) throw recoveryArtifactError("staged recovery artifact is unavailable");
    const metadata = object.customMetadata;
    const scope: RecoveryStateArtifactScope = {
      ...metadataScope,
      environment,
      generation: 1,
      plaintextSha256: handleParts.plaintextSha256,
      custodyEvidenceDigest: handleParts.custodyEvidenceDigest,
    };
    validateScope(scope);
    const allocated = await this.#allocate(scope);
    if (allocated !== object.key || await handleFor(scope, allocated) !== input.artifactHandle) {
      throw recoveryArtifactError("staged recovery artifact scope is invalid");
    }
    return await this.#verifyObject(object, scope, allocated, input.artifactHandle);
  }

  async #readback(stateRef: string): Promise<R2ObjectBody | null> {
    try {
      return await this.#bucket.get(stateRef);
    } catch {
      throw recoveryArtifactError("recovery state artifact readback failed");
    }
  }

  async #allocate(scope: RecoveryStateArtifactScope, validate = true): Promise<string> {
    if (validate) validateScope(scope);
    let ref: string;
    try {
      ref = await this.#allocator.allocate({
        kind: "state",
        workspaceId: scope.workspaceId,
        subject: { kind: "capsule", id: scope.capsuleId },
        environment: scope.environment,
        generation: 1,
      });
    } catch {
      throw recoveryArtifactError("recovery state allocation failed");
    }
    const canonical = `workspaces/${safeSegment(scope.workspaceId)}/capsules/${safeSegment(scope.capsuleId)}/environments/${safeSegment(scope.environment)}/state-versions/00000001.tfstate.enc`;
    if (ref !== canonical) throw recoveryArtifactError("recovery state allocation is not canonical");
    return ref;
  }

  async #verifyObject(
    object: R2ObjectBody,
    scope: RecoveryStateArtifactScope,
    stateRef: string,
    handle: string,
    expectedPlaintext?: Uint8Array,
  ): Promise<VerifiedRecoveryArtifact> {
    const head = object;
    const metadata = head.customMetadata;
    const expectedMetadata = recoveryMetadataFromScope(scope, stateRef, handle);
    if (
      head.key !== stateRef ||
      head.httpMetadata?.contentType !== RECOVERY_METADATA.encryptedContentType ||
      !Number.isSafeInteger(head.size) || head.size < 33 || head.size > RECOVERY_STATE_CIPHERTEXT_MAX_BYTES ||
      !metadata || Object.keys(expectedMetadata).some((key) => metadata[key] !== expectedMetadata[key]) ||
      metadata["takosumi-encryption-format"] !== "aes-gcm-bytes-v2" ||
      metadata["takosumi-ciphertext-length"] !== String(head.size)
    ) throw recoveryArtifactError("recovery state artifact metadata is invalid");

    const body = (object as R2ObjectBody & {
      readonly body?: ReadableStream<Uint8Array>;
    }).body;
    if (!body) throw recoveryArtifactError("recovery state artifact body is unavailable");
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedStream(body, RECOVERY_STATE_CIPHERTEXT_MAX_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message === "recovery state artifact size is invalid") throw error;
      throw recoveryArtifactError("recovery state artifact readback failed");
    }
    if (bytes.byteLength !== head.size) throw recoveryArtifactError("recovery state artifact size is invalid");
    const encryptedDigest = await digestBytes(bytes);
    let plaintext: Uint8Array;
    try {
      plaintext = await this.#crypto.open(bytes, scope.plaintextSha256);
    } catch {
      throw recoveryArtifactError("recovery state artifact decryption failed");
    }
    validateOpenTofuState(plaintext);
    if (await digestBytes(plaintext) !== scope.plaintextSha256 ||
      (expectedPlaintext !== undefined && !equalBytes(plaintext, expectedPlaintext)) ||
      bytes.byteLength !== plaintext.byteLength + 33) {
      throw recoveryArtifactError("recovery state plaintext digest is invalid");
    }
    if (metadata["takosumi-content-digest"] !== scope.plaintextSha256) {
      throw recoveryArtifactError("recovery state artifact content digest is invalid");
    }
    if (metadata["takosumi-recovery-encrypted-digest"] !== encryptedDigest) {
      throw recoveryArtifactError("recovery state artifact encrypted digest is invalid");
    }
    const evidenceDigest = await custodyEvidenceDigest(scope, stateRef, encryptedDigest, handle);
    return {
      format: VERIFIED_RECOVERY_ARTIFACT_FORMAT,
      immutable: true,
      adapterAllocated: true,
      readbackVerified: true,
      workspaceId: scope.workspaceId,
      capsuleId: scope.capsuleId,
      environment: scope.environment,
      generation: 1,
      recoveryRunId: scope.recoveryRunId,
      stateRef,
      encryptedDigest: encryptedDigest as `sha256:${string}`,
      plaintextSha256: scope.plaintextSha256,
      evidenceDigest,
    };
  }
}

function recoveryMetadata(scope: RecoveryStateArtifactScope, stateRef: string, sealed: {
  readonly contentDigest: string;
  readonly ciphertextLength: number;
  readonly format: string;
}, encryptedDigest: string, handle: string): Record<string, string> {
  return {
    ...recoveryMetadataFromScope(scope, stateRef, handle),
    "takosumi-content-digest": sealed.contentDigest,
    "takosumi-ciphertext-length": String(sealed.ciphertextLength),
    "takosumi-encryption-format": sealed.format,
    "takosumi-recovery-encrypted-digest": encryptedDigest,
  };
}

function recoveryMetadataFromScope(
  scope: RecoveryStateArtifactScope,
  stateRef: string,
  handle: string,
): Record<string, string> {
  return {
    "takosumi-recovery-format": RECOVERY_METADATA.format,
    "takosumi-run-id": scope.recoveryRunId,
    "takosumi-action": RECOVERY_METADATA.action,
    "takosumi-generation": "1",
    "takosumi-workspace-id": scope.workspaceId,
    "takosumi-capsule-id": scope.capsuleId,
    "takosumi-environment": scope.environment,
    "takosumi-logical-target-state-ref": stateRef,
    "takosumi-recovery-failed-apply-run-id": scope.failedApplyRunId,
    "takosumi-recovery-run-id": scope.recoveryRunId,
    "takosumi-recovery-custody-evidence-digest": scope.custodyEvidenceDigest,
    "takosumi-recovery-handle": handle,
    "takosumi-content-digest": scope.plaintextSha256,
  };
}

async function handleFor(scope: RecoveryStateArtifactScope, stateRef: string): Promise<string> {
  const identity = {
    workspaceId: scope.workspaceId,
    capsuleId: scope.capsuleId,
    environment: scope.environment,
    failedApplyRunId: scope.failedApplyRunId,
    recoveryRunId: scope.recoveryRunId,
    plaintextSha256: scope.plaintextSha256,
    custodyEvidenceDigest: scope.custodyEvidenceDigest,
  };
  const digest = await stableJsonDigest({
    kind: "takosumi.staged-state-recovery-handle@v1",
    ...identity,
    generation: 1,
    stateRef,
  });
  return `recovery-state-v1.${encodeHandleSegment(scope.environment)}.${encodeHandleSegment(scope.workspaceId)}.${encodeHandleSegment(scope.capsuleId)}.${encodeHandleSegment(scope.failedApplyRunId)}.${encodeHandleSegment(scope.recoveryRunId)}.${scope.plaintextSha256.slice(7)}.${scope.custodyEvidenceDigest.slice(7)}.${digest.slice(7)}`;
}

function recoveryHandleParts(handle: string): {
  readonly environment: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  readonly plaintextSha256: `sha256:${string}`;
  readonly custodyEvidenceDigest: `sha256:${string}`;
} {
  const match = /^recovery-state-v1\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.([0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-f]{64})$/u.exec(handle);
  if (!match) throw recoveryArtifactError("staged recovery artifact is unavailable");
  const environment = decodeHandleSegment(match[1]!);
  const workspaceId = decodeHandleSegment(match[2]!);
  const capsuleId = decodeHandleSegment(match[3]!);
  const failedApplyRunId = decodeHandleSegment(match[4]!);
  const recoveryRunId = decodeHandleSegment(match[5]!);
  requireIdentifier(environment);
  return {
    environment,
    workspaceId,
    capsuleId,
    failedApplyRunId,
    recoveryRunId,
    plaintextSha256: `sha256:${match[6]!}`,
    custodyEvidenceDigest: `sha256:${match[7]!}`,
  };
}

function encodeHandleSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./gu, "%2E");
}

function decodeHandleSegment(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw recoveryArtifactError("staged recovery artifact is unavailable");
  }
  requireIdentifier(decoded);
  if (encodeHandleSegment(decoded) !== value) {
    throw recoveryArtifactError("staged recovery artifact is unavailable");
  }
  return decoded;
}

async function custodyEvidenceDigest(
  scope: RecoveryStateArtifactScope,
  stateRef: string,
  encryptedDigest: string,
  handle: string,
): Promise<`sha256:${string}`> {
  return await stableJsonDigest({
    kind: "takosumi.state-recovery-custody@v1",
    workspaceId: scope.workspaceId,
    capsuleId: scope.capsuleId,
    environment: scope.environment,
    generation: 1,
    failedApplyRunId: scope.failedApplyRunId,
    recoveryRunId: scope.recoveryRunId,
    stateRef,
    encryptedDigest,
    plaintextSha256: scope.plaintextSha256,
    custodyEvidenceDigest: scope.custodyEvidenceDigest,
    handle,
  }) as `sha256:${string}`;
}

function validateScope(scope: RecoveryStateArtifactScope): void {
  requireIdentifier(scope.workspaceId);
  requireIdentifier(scope.capsuleId);
  requireIdentifier(scope.environment);
  requireIdentifier(scope.failedApplyRunId);
  requireIdentifier(scope.recoveryRunId);
  if (scope.generation !== 1 || !SHA256.test(scope.plaintextSha256) || !SHA256.test(scope.custodyEvidenceDigest)) {
    throw recoveryArtifactError("recovery state scope is invalid");
  }
}

function requireIdentifier(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-zA-Z0-9._:-]+$/u.test(value)) {
    throw recoveryArtifactError("recovery state scope is invalid");
  }
  // The object-key allocator replaces unsupported characters with `_`, so an
  // accepted identity must already be an exact path segment. In particular,
  // `a:b` aliases `a_b`; accepting both would break scope/key roundtrips. The
  // Worker state reader also rejects any key containing `..` as path-unsafe.
  if (safeSegment(value) !== value || value.includes("..")) {
    throw recoveryArtifactError("recovery state scope is invalid");
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "_");
}

function validateOpenTofuState(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > RECOVERY_STATE_MAX_BYTES) {
    throw recoveryArtifactError("recovery state payload is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw recoveryArtifactError("recovery state payload is invalid");
  }
  if (!isRecord(value) || value.version !== 4 || !Number.isSafeInteger(value.serial) || (value.serial as number) < 0 ||
    typeof value.lineage !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.lineage) ||
    typeof value.terraform_version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.terraform_version) ||
    !isRecord(value.outputs) || !Array.isArray(value.resources) ||
    value.resources.some((resource) => !validResource(resource))) {
    throw recoveryArtifactError("recovery state payload is invalid");
  }
}

function validResource(value: unknown): boolean {
  if (!isRecord(value) ||
    (value.module !== undefined && typeof value.module !== "string") ||
    !(value.mode === "managed" || value.mode === "data") ||
    typeof value.type !== "string" || !value.type ||
    typeof value.name !== "string" || !value.name ||
    typeof value.provider !== "string" || !value.provider ||
    !Array.isArray(value.instances)) return false;
  return value.instances.every((instance) => isRecord(instance) &&
    isRecord(instance.attributes) && typeof instance.schema_version === "number" &&
    Number.isSafeInteger(instance.schema_version) && instance.schema_version >= 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size bound is authoritative even if the source refuses cancel.
        }
        throw recoveryArtifactError("recovery state artifact size is invalid");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function recoveryArtifactError(message: string): Error {
  return new Error(message);
}
