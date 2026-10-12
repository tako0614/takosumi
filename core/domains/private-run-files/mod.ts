/**
 * Internal Core contract for private, opaque files whose lifetime is stable
 * across Run attempts. This domain is not mounted by an API or Runner yet.
 * Persistence adapters must implement the atomic/fail-closed guarantees in
 * `docs/internal/private-run-files.md`; the service alone cannot provide them.
 */

export interface PrivateRunFileScope {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  /** Opaque caller-selected storage key. Core never interprets file contents. */
  readonly slot: string;
}

export interface PrivateRunFileAuthority {
  readonly runId: string;
  readonly executionAuthorityEpoch: number;
  readonly leaseToken: string;
}

export type PrivateRunFileOperation = "read" | "commit" | "resolve";
export type PrivateRunFileDigest = `sha256:${string}`;

export interface PrivateRunFilePointer {
  readonly version: number;
  readonly digest: PrivateRunFileDigest;
  readonly blobId: string;
}

export interface PrivateRunFileReceipt extends PrivateRunFilePointer {
  readonly scope: PrivateRunFileScope;
  readonly commitId: string;
  readonly expectedVersion: number;
}

/**
 * The authorization adapter validates a current, scoped grant. Its result is
 * intentionally void: only the repository's atomic commit can validate the
 * current Capsule epoch and Run lease at mutation time.
 */
export interface PrivateRunFilesAuthorizationPort {
  authorize(input: {
    readonly scope: PrivateRunFileScope;
    readonly authority: PrivateRunFileAuthority;
    readonly operation: PrivateRunFileOperation;
  }): Promise<void>;
}

export interface PrivateRunFileRepositoryPort {
  readPointer(input: {
    readonly scope: PrivateRunFileScope;
  }): Promise<PrivateRunFilePointer | undefined>;
  /**
   * Read-only, current-authority-fenced receipt lookup. Implementations lock
   * Workspace → Capsule → Run in one transaction and return `unknown` rather
   * than treating a database failure as an absent receipt.
   */
  lookupReceipt(input: {
    readonly scope: PrivateRunFileScope;
    readonly runId: string;
    readonly executionAuthorityEpoch: number;
    readonly leaseToken: string;
    readonly commitId: string;
  }): Promise<
    | { readonly kind: "found"; readonly receipt: PrivateRunFileReceipt }
    | { readonly kind: "absent" | "authority_rejected" | "unknown" }
  >;
  /**
   * One durable transaction: validate exact scope, current Capsule execution
   * epoch, active Run lease, expected pointer version and commit-ID receipt;
   * then advance pointer and insert receipt. Must return `unknown` rather than
   * guess if the caller cannot establish whether commit happened.
   */
  commitPointer(input: {
    readonly scope: PrivateRunFileScope;
    readonly runId: string;
    readonly executionAuthorityEpoch: number;
    readonly leaseToken: string;
    readonly expectedVersion: number;
    readonly commitId: string;
    readonly digest: PrivateRunFileDigest;
    readonly blobId: string;
  }): Promise<
    | { readonly kind: "committed" | "replayed"; readonly receipt: PrivateRunFileReceipt }
    | { readonly kind: "conflict" | "authority_rejected" | "unknown" }
  >;
}

/**
 * Encrypted immutable storage boundary. Implementations must bind encryption
 * to the supplied scope. `put` confirms immutable creation; the service then
 * performs a separate authenticated/decrypted readback before pointer commit.
 * Reads must verify the expected digest.
 */
export interface PrivateRunFileBlobPort {
  putEncryptedImmutable(input: {
    readonly scope: PrivateRunFileScope;
    readonly bytes: Uint8Array;
    readonly digest: PrivateRunFileDigest;
  }): Promise<{
    readonly blobId: string;
    readonly digest: PrivateRunFileDigest;
    readonly byteLength: number;
  }>;
  readEncryptedVerified(input: {
    readonly scope: PrivateRunFileScope;
    readonly blobId: string;
    readonly expectedDigest: PrivateRunFileDigest;
  }): Promise<{
    readonly bytes: Uint8Array;
    readonly digest: PrivateRunFileDigest;
    readonly byteLength: number;
  } | undefined>;
}

export interface PrivateRunFilesServiceDependencies {
  readonly authorization: PrivateRunFilesAuthorizationPort;
  readonly repository: PrivateRunFileRepositoryPort;
  readonly blobs: PrivateRunFileBlobPort;
  /** Required positive bound. No implicit provider- or environment-specific default. */
  readonly maxBytes: number;
}

export interface PrivateRunFileReadRequest {
  readonly scope: PrivateRunFileScope;
  readonly authority: PrivateRunFileAuthority;
}

export type PrivateRunFileReadResult =
  | { readonly kind: "absent" }
  | {
    readonly kind: "present";
    readonly version: number;
    readonly digest: PrivateRunFileDigest;
    readonly bytes: Uint8Array;
  };

export interface PrivateRunFileCommitRequest extends PrivateRunFileReadRequest {
  /** Version 0 denotes an absent slot. */
  readonly expectedVersion: number;
  readonly commitId: string;
  readonly bytes: Uint8Array;
}

export type PrivateRunFileCommitResult =
  | {
    readonly kind: "committed" | "replayed";
    readonly receipt: PrivateRunFileReceipt;
  }
  | {
    readonly kind: "conflict" | "authority_rejected" | "unknown";
    readonly commitId: string;
    readonly expectedVersion: number;
    readonly digest: PrivateRunFileDigest;
  };

export interface PrivateRunFileResolveRequest extends PrivateRunFileReadRequest {
  readonly commitId: string;
  readonly expectedVersion: number;
  readonly digest: PrivateRunFileDigest;
}

export type PrivateRunFileResolveResult =
  | { readonly kind: "committed"; readonly receipt: PrivateRunFileReceipt }
  | { readonly kind: "not_found" | "authority_rejected" | "conflict" | "unknown" };

export class PrivateRunFilesError extends Error {
  constructor(
    readonly code:
      | "invalid_argument"
      | "too_large"
      | "unavailable"
      | "integrity_failure"
      | "authorization_rejected",
  ) {
    // Error text is deliberately value-free: private file bytes and their
    // contents must never be copied into diagnostics.
    super(code);
    this.name = "PrivateRunFilesError";
  }
}

export class PrivateRunFilesService {
  readonly #authorization: PrivateRunFilesAuthorizationPort;
  readonly #repository: PrivateRunFileRepositoryPort;
  readonly #blobs: PrivateRunFileBlobPort;
  readonly #maxBytes: number;

  constructor(deps: PrivateRunFilesServiceDependencies) {
    if (!Number.isSafeInteger(deps.maxBytes) || deps.maxBytes <= 0) {
      throw new PrivateRunFilesError("invalid_argument");
    }
    this.#authorization = deps.authorization;
    this.#repository = deps.repository;
    this.#blobs = deps.blobs;
    this.#maxBytes = deps.maxBytes;
  }

  async read(request: PrivateRunFileReadRequest): Promise<PrivateRunFileReadResult> {
    validateReadRequest(request);
    const stable = snapshotReadRequest(request);
    await this.#authorize(stable, "read");
    let pointer: PrivateRunFilePointer | undefined;
    try {
      pointer = await this.#repository.readPointer({ scope: stable.scope });
    } catch {
      throw new PrivateRunFilesError("unavailable");
    }
    if (!pointer) return { kind: "absent" };
    validatePointer(pointer);
    const bytes = await this.#readVerifiedBlob(stable.scope, pointer.blobId, pointer.digest);
    return { kind: "present", version: pointer.version, digest: pointer.digest, bytes };
  }

  async commit(request: PrivateRunFileCommitRequest): Promise<PrivateRunFileCommitResult> {
    validateReadRequest(request);
    validateVersion(request.expectedVersion, true);
    if (request.expectedVersion === Number.MAX_SAFE_INTEGER) throw new PrivateRunFilesError("invalid_argument");
    requireText(request.commitId);
    if (!(request.bytes instanceof Uint8Array)) throw new PrivateRunFilesError("invalid_argument");
    if (request.bytes.byteLength > this.#maxBytes) throw new PrivateRunFilesError("too_large");
    const bytes = Uint8Array.from(request.bytes);
    const stable = {
      ...snapshotReadRequest(request),
      expectedVersion: request.expectedVersion,
      commitId: request.commitId,
      bytes,
    };
    const digest = await digestOf(bytes);
    await this.#authorize(stable, "commit");

    // Resolve a known write before touching blob storage. In particular, an
    // old receipt remains the answer even when a later write advanced the slot.
    let lookup: Awaited<ReturnType<PrivateRunFileRepositoryPort["lookupReceipt"]>>;
    try {
      lookup = await this.#repository.lookupReceipt({
        scope: stable.scope,
        runId: stable.authority.runId,
        executionAuthorityEpoch: stable.authority.executionAuthorityEpoch,
        leaseToken: stable.authority.leaseToken,
        commitId: stable.commitId,
      });
    } catch {
      return result("unknown", stable, digest);
    }
    if (lookup.kind === "unknown") return result("unknown", stable, digest);
    if (lookup.kind === "authority_rejected") return result("authority_rejected", stable, digest);
    const prior = lookup.kind === "found" ? lookup.receipt : undefined;
    if (prior && !sameReceipt(prior, stable, digest)) return result("conflict", stable, digest);

    let blobId: string;
    if (prior) {
      // A known immutable receipt is reused without another blob write, but it
      // still goes through commitPointer's current epoch/lease fence below.
      blobId = prior.blobId;
      await this.#readVerifiedBlob(stable.scope, blobId, digest, stable.bytes.byteLength);
    } else {
      let blob: Awaited<ReturnType<PrivateRunFileBlobPort["putEncryptedImmutable"]>>;
      try {
        blob = await this.#blobs.putEncryptedImmutable({ scope: stable.scope, bytes, digest });
      } catch {
        throw new PrivateRunFilesError("unavailable");
      }
      if (!blob.blobId || blob.digest !== digest || blob.byteLength !== bytes.byteLength) {
        throw new PrivateRunFilesError("integrity_failure");
      }

      await this.#readVerifiedBlob(stable.scope, blob.blobId, digest, bytes.byteLength);
      blobId = blob.blobId;
    }

    let finalized: Awaited<ReturnType<PrivateRunFileRepositoryPort["commitPointer"]>>;
    try {
      finalized = await this.#repository.commitPointer({
        scope: stable.scope,
        runId: stable.authority.runId,
        executionAuthorityEpoch: stable.authority.executionAuthorityEpoch,
        leaseToken: stable.authority.leaseToken,
        expectedVersion: stable.expectedVersion,
        commitId: stable.commitId,
        digest,
        blobId,
      });
    } catch {
      return result("unknown", stable, digest);
    }
    if (finalized.kind === "committed" || finalized.kind === "replayed") {
      if (!sameReceipt(finalized.receipt, stable, digest)) {
        return result("conflict", stable, digest);
      }
      if (finalized.kind === "committed" && finalized.receipt.blobId !== blobId) {
        throw new PrivateRunFilesError("integrity_failure");
      }
      if (finalized.kind === "replayed") {
        if (prior && finalized.receipt.blobId !== prior.blobId) {
          throw new PrivateRunFilesError("integrity_failure");
        }
        if (!prior) {
          await this.#readVerifiedBlob(
            stable.scope,
            finalized.receipt.blobId,
            digest,
            stable.bytes.byteLength,
          );
        }
      }
      if (prior && finalized.kind !== "replayed") throw new PrivateRunFilesError("integrity_failure");
      return { kind: finalized.kind, receipt: copyReceipt(finalized.receipt) };
    }
    return result(finalized.kind, stable, digest);
  }

  /** Explicit receipt lookup after an uncertain result; this never writes/retries. */
  async resolve(request: PrivateRunFileResolveRequest): Promise<PrivateRunFileResolveResult> {
    validateReadRequest(request);
    requireText(request.commitId);
    validateVersion(request.expectedVersion, true);
    if (request.expectedVersion === Number.MAX_SAFE_INTEGER) throw new PrivateRunFilesError("invalid_argument");
    if (!/^sha256:[0-9a-f]{64}$/.test(request.digest)) throw new PrivateRunFilesError("invalid_argument");
    const stable = {
      ...snapshotReadRequest(request),
      commitId: request.commitId,
      expectedVersion: request.expectedVersion,
      digest: request.digest,
    };
    await this.#authorize(stable, "resolve");
    let lookup: Awaited<ReturnType<PrivateRunFileRepositoryPort["lookupReceipt"]>>;
    try {
      lookup = await this.#repository.lookupReceipt({
        scope: stable.scope,
        runId: stable.authority.runId,
        executionAuthorityEpoch: stable.authority.executionAuthorityEpoch,
        leaseToken: stable.authority.leaseToken,
        commitId: stable.commitId,
      });
    } catch {
      return { kind: "unknown" };
    }
    if (lookup.kind !== "found") return { kind: lookup.kind === "absent" ? "not_found" : lookup.kind };
    if (!sameReceipt(lookup.receipt, stable, stable.digest)) return { kind: "conflict" };
    await this.#readVerifiedBlob(stable.scope, lookup.receipt.blobId, stable.digest);
    return { kind: "committed", receipt: copyReceipt(lookup.receipt) };
  }

  async #readVerifiedBlob(
    scope: PrivateRunFileScope,
    blobId: string,
    expectedDigest: PrivateRunFileDigest,
    expectedByteLength?: number,
  ): Promise<Uint8Array> {
    let stored: Awaited<ReturnType<PrivateRunFileBlobPort["readEncryptedVerified"]>>;
    try {
      stored = await this.#blobs.readEncryptedVerified({ scope, blobId, expectedDigest });
    } catch {
      throw new PrivateRunFilesError("unavailable");
    }
    if (!stored) throw new PrivateRunFilesError("integrity_failure");
    const bytes = Uint8Array.from(stored.bytes);
    if (
      stored.digest !== expectedDigest || stored.byteLength !== bytes.byteLength ||
      bytes.byteLength > this.#maxBytes ||
      (expectedByteLength !== undefined && bytes.byteLength !== expectedByteLength) ||
      await digestOf(bytes) !== expectedDigest
    ) throw new PrivateRunFilesError("integrity_failure");
    return bytes;
  }

  async #authorize(request: PrivateRunFileReadRequest, operation: PrivateRunFileOperation): Promise<void> {
    try {
      await this.#authorization.authorize({ scope: request.scope, authority: request.authority, operation });
    } catch {
      throw new PrivateRunFilesError("authorization_rejected");
    }
  }
}

function result(
  kind: "conflict" | "authority_rejected" | "unknown",
  request: PrivateRunFileCommitRequest,
  digest: PrivateRunFileDigest,
): PrivateRunFileCommitResult {
  return { kind, commitId: request.commitId, expectedVersion: request.expectedVersion, digest };
}

function sameReceipt(
  receipt: PrivateRunFileReceipt,
  request: Pick<PrivateRunFileCommitRequest, "scope" | "commitId" | "expectedVersion">,
  digest: PrivateRunFileDigest,
): boolean {
  return receipt.commitId === request.commitId && receipt.expectedVersion === request.expectedVersion &&
    receipt.digest === digest && sameScope(receipt.scope, request.scope) &&
    receipt.version === request.expectedVersion + 1 &&
    typeof receipt.blobId === "string" && receipt.blobId.trim().length > 0;
}

function copyReceipt(receipt: PrivateRunFileReceipt): PrivateRunFileReceipt {
  return { ...receipt, scope: { ...receipt.scope } };
}

function sameScope(left: PrivateRunFileScope, right: PrivateRunFileScope): boolean {
  return left.workspaceId === right.workspaceId && left.capsuleId === right.capsuleId &&
    left.environment === right.environment && left.slot === right.slot;
}

function validateReadRequest(request: PrivateRunFileReadRequest): void {
  validateScope(request.scope);
  requireText(request.authority.runId);
  requireText(request.authority.leaseToken);
  if (!Number.isSafeInteger(request.authority.executionAuthorityEpoch) || request.authority.executionAuthorityEpoch < 1) {
    throw new PrivateRunFilesError("invalid_argument");
  }
}

function snapshotReadRequest(request: PrivateRunFileReadRequest): PrivateRunFileReadRequest {
  return {
    scope: { ...request.scope },
    authority: { ...request.authority },
  };
}

function validateScope(scope: PrivateRunFileScope): void {
  requireText(scope.workspaceId);
  requireText(scope.capsuleId);
  requireText(scope.environment);
  requireText(scope.slot);
}

function requireText(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new PrivateRunFilesError("invalid_argument");
}

function validateVersion(version: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(version) || version < (allowZero ? 0 : 1)) throw new PrivateRunFilesError("invalid_argument");
}

function validatePointer(pointer: PrivateRunFilePointer): void {
  validateVersion(pointer.version, false);
  requireText(pointer.blobId);
  if (!/^sha256:[0-9a-f]{64}$/.test(pointer.digest)) throw new PrivateRunFilesError("integrity_failure");
}

async function digestOf(bytes: Uint8Array): Promise<PrivateRunFileDigest> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
