/** Local encrypted-file adapter for one failed-initial-create state recovery. */
import type { ArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import {
  VERIFIED_RECOVERY_ARTIFACT_FORMAT,
  type RecoveryArtifactVerifier,
  type VerifiedRecoveryArtifact,
} from "../../../core/domains/deploy-control/operator_state_recovery.ts";
import { sha256Digest, stableJsonDigest } from "../../../core/adapters/source/digest.ts";
import type {
  LocalOpenTofuRecoveryCommitStore,
} from "./local-opentofu-runner.ts";

export const LOCAL_RECOVERY_STATE_MAX_BYTES = 16 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HANDLE_PREFIX = "local-recovery-state-v1";

export interface LocalRecoveryStateArtifactScope {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: 1;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  readonly plaintextSha256: `sha256:${string}`;
  readonly custodyEvidenceDigest: `sha256:${string}`;
}

export interface StageLocalRecoveryStateInput extends LocalRecoveryStateArtifactScope {
  readonly plaintext: Uint8Array;
}

export interface StagedLocalRecoveryStateArtifact {
  /** Opaque scoped handle; never a filesystem path, stateRef, or URL. */
  readonly handle: string;
  readonly artifact: VerifiedRecoveryArtifact;
}

type LocalRecoveryArtifactStore = Pick<
  LocalOpenTofuRecoveryCommitStore,
  "readRecovery" | "commitRecovery"
>;

/**
 * Stages recovery state through the local file store's encrypted, immutable
 * no-replace path and only returns a descriptor after decrypting exact readback.
 */
export class LocalOpenTofuStateRecoveryArtifactStore implements RecoveryArtifactVerifier {
  readonly #store: LocalRecoveryArtifactStore;
  readonly #allocator: ArtifactReferenceAllocator;

  constructor(input: {
    readonly store: LocalRecoveryArtifactStore;
    readonly allocator: ArtifactReferenceAllocator;
  }) {
    this.#store = input.store;
    this.#allocator = input.allocator;
  }

  async stage(input: StageLocalRecoveryStateInput): Promise<StagedLocalRecoveryStateArtifact> {
    const scope = input;
    validateScope(scope);
    validateOpenTofuState(input.plaintext);
    if (await sha256Digest(input.plaintext) !== scope.plaintextSha256) {
      throw recoveryArtifactError("local recovery state plaintext digest is invalid");
    }
    const stateRef = await this.#allocate(scope);
    const handle = await handleFor(scope, stateRef);
    const candidate = await this.#store.commitRecovery({
      stateRef,
      workspaceId: scope.workspaceId,
      subject: { kind: "capsule", id: scope.capsuleId },
      environment: scope.environment,
      generation: 1,
      createdByRunId: scope.recoveryRunId,
      action: "state_recovery",
      failedApplyRunId: scope.failedApplyRunId,
      stateDigest: scope.plaintextSha256,
      stateBytes: new Uint8Array(input.plaintext),
      custodyEvidenceDigest: scope.custodyEvidenceDigest,
    });
    const readback = await this.#store.readRecovery(stateRef);
    const artifact = await this.#verifiedReadback(readback, scope, stateRef, handle, input.plaintext);
    if (candidate.encryptedDigest !== artifact.encryptedDigest) {
      throw recoveryArtifactError("local recovery state artifact changed after commit");
    }
    return { handle, artifact };
  }

  async verify(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly failedApplyRunId: string;
    readonly recoveryRunId: string;
    readonly artifactHandle: string;
  }): Promise<VerifiedRecoveryArtifact> {
    requireIdentifier(input.workspaceId);
    requireIdentifier(input.capsuleId);
    requireIdentifier(input.failedApplyRunId);
    requireIdentifier(input.recoveryRunId);
    const parts = handleParts(input.artifactHandle);
    if (parts.workspaceId !== input.workspaceId || parts.capsuleId !== input.capsuleId ||
      parts.failedApplyRunId !== input.failedApplyRunId || parts.recoveryRunId !== input.recoveryRunId) {
      throw recoveryArtifactError("staged local recovery artifact is unavailable");
    }
    const scope: LocalRecoveryStateArtifactScope = {
      ...input,
      environment: parts.environment,
      generation: 1,
      plaintextSha256: parts.plaintextSha256,
      custodyEvidenceDigest: parts.custodyEvidenceDigest,
    };
    validateScope(scope);
    const stateRef = await this.#allocate(scope);
    if (await handleFor(scope, stateRef) !== input.artifactHandle) {
      throw recoveryArtifactError("staged local recovery artifact scope is invalid");
    }
    const readback = await this.#store.readRecovery(stateRef);
    return await this.#verifiedReadback(readback, scope, stateRef, input.artifactHandle);
  }

  async #allocate(scope: LocalRecoveryStateArtifactScope): Promise<string> {
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
      throw recoveryArtifactError("local recovery state allocation failed");
    }
    const canonical = `workspaces/${scope.workspaceId}/capsules/${scope.capsuleId}/environments/${scope.environment}/state-versions/00000001.tfstate.enc`;
    if (ref !== canonical || ref.includes("..")) {
      throw recoveryArtifactError("local recovery state allocation is not canonical");
    }
    return ref;
  }

  async #verifiedReadback(
    value: Awaited<ReturnType<LocalRecoveryArtifactStore["readRecovery"]>>,
    scope: LocalRecoveryStateArtifactScope,
    stateRef: string,
    handle: string,
    expectedPlaintext?: Uint8Array,
  ): Promise<VerifiedRecoveryArtifact> {
    if (!value || value.action !== "state_recovery" ||
      value.stateRef !== stateRef || value.workspaceId !== scope.workspaceId ||
      value.subject.kind !== "capsule" || value.subject.id !== scope.capsuleId ||
      value.environment !== scope.environment || value.generation !== 1 ||
      value.createdByRunId !== scope.recoveryRunId ||
      value.failedApplyRunId !== scope.failedApplyRunId ||
      value.stateDigest !== scope.plaintextSha256 ||
      value.custodyEvidenceDigest !== scope.custodyEvidenceDigest ||
      !SHA256.test(value.encryptedDigest)) {
      throw recoveryArtifactError("local recovery state artifact scope is invalid");
    }
    if (value.stateBytes.byteLength > LOCAL_RECOVERY_STATE_MAX_BYTES) {
      throw recoveryArtifactError("local recovery state artifact size is invalid");
    }
    validateOpenTofuState(value.stateBytes);
    if (await sha256Digest(value.stateBytes) !== scope.plaintextSha256 ||
      (expectedPlaintext !== undefined && !equalBytes(value.stateBytes, expectedPlaintext))) {
      throw recoveryArtifactError("local recovery state plaintext digest is invalid");
    }
    const expectedHandle = await handleFor(scope, stateRef);
    if (handle !== expectedHandle) {
      throw recoveryArtifactError("staged local recovery artifact handle is invalid");
    }
    const evidenceDigest = await stableJsonDigest({
      kind: "takosumi.local-state-recovery-custody@v1",
      workspaceId: scope.workspaceId,
      capsuleId: scope.capsuleId,
      environment: scope.environment,
      generation: 1,
      failedApplyRunId: scope.failedApplyRunId,
      recoveryRunId: scope.recoveryRunId,
      stateRef,
      encryptedDigest: value.encryptedDigest as `sha256:${string}`,
      plaintextSha256: scope.plaintextSha256,
      custodyEvidenceDigest: scope.custodyEvidenceDigest,
      handle,
    });
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
      encryptedDigest: value.encryptedDigest as `sha256:${string}`,
      plaintextSha256: scope.plaintextSha256,
      evidenceDigest: evidenceDigest as `sha256:${string}`,
    };
  }
}

type RecoveryHandleScope = Pick<LocalRecoveryStateArtifactScope,
  "workspaceId" | "capsuleId" | "environment" | "failedApplyRunId" | "recoveryRunId" |
  "plaintextSha256" | "custodyEvidenceDigest">;

async function handleFor(scope: RecoveryHandleScope, stateRef: string): Promise<string> {
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
    kind: "takosumi.local-staged-state-recovery-handle@v1",
    ...identity,
    generation: 1,
    stateRef,
  });
  return `${HANDLE_PREFIX}.${encodeHandleSegment(scope.environment)}.${encodeHandleSegment(scope.workspaceId)}.${encodeHandleSegment(scope.capsuleId)}.${encodeHandleSegment(scope.failedApplyRunId)}.${encodeHandleSegment(scope.recoveryRunId)}.${scope.plaintextSha256.slice(7)}.${scope.custodyEvidenceDigest.slice(7)}.${digest.slice(7)}`;
}

function handleParts(handle: string): RecoveryHandleScope {
  const match = /^local-recovery-state-v1\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.((?:[A-Za-z0-9_:%-]|%2E){1,384})\.([0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-f]{64})$/u.exec(handle);
  if (!match) throw recoveryArtifactError("staged local recovery artifact is unavailable");
  return {
    environment: decodeHandleSegment(match[1]!),
    workspaceId: decodeHandleSegment(match[2]!),
    capsuleId: decodeHandleSegment(match[3]!),
    failedApplyRunId: decodeHandleSegment(match[4]!),
    recoveryRunId: decodeHandleSegment(match[5]!),
    plaintextSha256: `sha256:${match[6]!}` as `sha256:${string}`,
    custodyEvidenceDigest: `sha256:${match[7]!}` as `sha256:${string}`,
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
    throw recoveryArtifactError("staged local recovery artifact is unavailable");
  }
  requireIdentifier(decoded);
  if (encodeHandleSegment(decoded) !== value) {
    throw recoveryArtifactError("staged local recovery artifact is unavailable");
  }
  return decoded;
}

function validateScope(scope: LocalRecoveryStateArtifactScope): void {
  requireIdentifier(scope.workspaceId);
  requireIdentifier(scope.capsuleId);
  requireIdentifier(scope.environment);
  requireIdentifier(scope.failedApplyRunId);
  requireIdentifier(scope.recoveryRunId);
  if (scope.generation !== 1 || !SHA256.test(scope.plaintextSha256) ||
    !SHA256.test(scope.custodyEvidenceDigest)) {
    throw recoveryArtifactError("local recovery state scope is invalid");
  }
}

function requireIdentifier(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
    !/^[a-zA-Z0-9._-]+$/u.test(value) || value.includes("..")) {
    throw recoveryArtifactError("local recovery state scope is invalid");
  }
}

function validateOpenTofuState(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
    bytes.byteLength > LOCAL_RECOVERY_STATE_MAX_BYTES) {
    throw recoveryArtifactError("local recovery state payload is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw recoveryArtifactError("local recovery state payload is invalid");
  }
  if (!isRecord(value) || value.version !== 4 || !Number.isSafeInteger(value.serial) ||
    (value.serial as number) < 0 || typeof value.lineage !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.lineage) ||
    typeof value.terraform_version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.terraform_version) ||
    !isRecord(value.outputs) || !Array.isArray(value.resources) ||
    value.resources.some((resource) => !validResource(resource))) {
    throw recoveryArtifactError("local recovery state payload is invalid");
  }
}

function validResource(value: unknown): boolean {
  if (!isRecord(value) || (value.module !== undefined && typeof value.module !== "string") ||
    !(value.mode === "managed" || value.mode === "data") ||
    typeof value.type !== "string" || !value.type || typeof value.name !== "string" || !value.name ||
    typeof value.provider !== "string" || !value.provider || !Array.isArray(value.instances)) return false;
  return value.instances.every((instance) => isRecord(instance) && isRecord(instance.attributes) &&
    typeof instance.schema_version === "number" && Number.isSafeInteger(instance.schema_version) &&
    instance.schema_version >= 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
