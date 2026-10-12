import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, join, resolve } from "node:path";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import type {
  PrivateRunFileBlobPort,
  PrivateRunFileDigest,
  PrivateRunFileScope,
} from "../../../core/domains/private-run-files/mod.ts";

const ENVELOPE_VERSION = 1;
const ENVELOPE_KIND = "private_run_file_blob";
const ENVELOPE_OVERHEAD_ALLOWANCE = 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface LocalPrivateRunFileBlobStoreOptions {
  /** Dedicated local persistence root; it is created with private permissions. */
  readonly root: string;
  /** Maximum plaintext bytes, enforced on input, envelope, and readback. */
  readonly maxBytes: number;
  /** Existing authenticated secret boundary; this adapter does not manage keys. */
  readonly cryptoBoundary: PartitionedSecretBoundaryCrypto;
  /** @internal Test-only phase injection: pauses immediately after final link publication. */
  readonly testOnlyAfterPublishLink?: () => Promise<void>;
}

/**
 * Encrypted immutable local backing for the internal private-run-file port.
 * A successful put is only blob durability; it is not a pointer/receipt ACK.
 */
export function createLocalPrivateRunFileBlobStore(
  options: LocalPrivateRunFileBlobStoreOptions,
): PrivateRunFileBlobPort {
  if (!options.root || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new PrivateRunFileBlobStoreError("invalid local private-run blob configuration");
  }
  if (!(options.cryptoBoundary instanceof PartitionedSecretBoundaryCrypto)) {
    throw new PrivateRunFileBlobStoreError("local private-run blob storage requires partitioned encryption");
  }
  const maxEnvelopeBytes = envelopeBound(options.maxBytes);
  const root = resolve(options.root);

  return {
    putEncryptedImmutable: async (input) => {
      const scope = snapshotScope(input.scope);
      if (!(input.bytes instanceof Uint8Array)) fail("invalid local private-run blob input");
      const bytes = Uint8Array.from(input.bytes);
      const expectedDigest = validateDigest(input.digest);
      if (bytes.byteLength > options.maxBytes) fail("local private-run blob exceeds configured size limit");
      const actualDigest = await digestBytes(bytes);
      if (actualDigest !== expectedDigest) fail("local private-run blob digest is invalid");
      const blobId = blobIdFor(scope, expectedDigest);
      const aad = aadFor(scope, blobId, expectedDigest, bytes.byteLength);
      let ciphertext: Uint8Array;
      try {
        ciphertext = await options.cryptoBoundary.seal(
          Buffer.from(bytes).toString("base64"),
          "global",
          aad,
        );
      } catch {
        fail("local private-run blob encryption failed");
      }
      const envelope = encodeEnvelope(blobId, expectedDigest, bytes.byteLength, ciphertext);
      if (Buffer.byteLength(envelope, "utf8") > maxEnvelopeBytes) {
        fail("local private-run blob envelope exceeds configured size limit");
      }

      const directory = join(root, blobId.slice(0, 2));
      await ensurePrivateDirectory(root);
      await syncDirectory(dirname(root));
      await ensurePrivateDirectory(directory);
      await syncDirectory(root);
      const path = blobPath(directory, blobId);
      const temporaryPath = join(directory, `${blobId}.${randomUUID()}.tmp`);
      try {
        const temporary = await open(temporaryPath, "wx", 0o600).catch(() => {
          fail("local private-run blob temporary file could not be created");
        });
        try {
          await assertPrivateRegularFile(temporary, false);
          await temporary.writeFile(envelope, "utf8");
          await temporary.sync();
        } catch {
          fail("local private-run blob temporary file could not be written safely");
        } finally {
          await temporary.close().catch(() => fail("local private-run blob temporary file could not be closed"));
        }
        try {
          await link(temporaryPath, path);
          await options.testOnlyAfterPublishLink?.();
          // Drop the staging name before readback: an immutable object must
          // have exactly one directory entry, not merely a private inode.
          await unlink(temporaryPath).catch((error) => {
            // A concurrent exact read/retry may safely reap the same staging
            // name after authenticating the final object.
            if (!isErrno(error, "ENOENT")) throw error;
          });
          await syncDirectory(directory);
          const stored = await readVerified(path, scope, blobId, expectedDigest);
          if (!stored || stored.byteLength !== bytes.byteLength || !equalBytes(stored.bytes, bytes)) {
            fail("local private-run blob readback did not match the immutable write");
          }
          return { blobId, digest: stored.digest, byteLength: stored.byteLength };
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
          const existing = await readVerified(path, scope, blobId, expectedDigest);
          if (!existing || existing.byteLength !== bytes.byteLength || !equalBytes(existing.bytes, bytes)) {
            fail("local private-run blob immutable identity is occupied");
          }
          return { blobId, digest: existing.digest, byteLength: existing.byteLength };
        }
      } catch (error) {
        if (error instanceof PrivateRunFileBlobStoreError) throw error;
        fail("local private-run blob storage is unavailable");
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (!isErrno(error, "ENOENT")) fail("local private-run blob temporary cleanup failed");
        });
      }
    },
    readEncryptedVerified: async (input) => {
      const scope = snapshotScope(input.scope);
      const expectedDigest = validateDigest(input.expectedDigest);
      if (typeof input.blobId !== "string" || !/^[0-9a-f]{64}$/u.test(input.blobId)) {
        fail("local private-run blob identity is invalid");
      }
      const expectedId = blobIdFor(scope, expectedDigest);
      if (input.blobId !== expectedId) fail("local private-run blob identity does not match its scope");
      if (!await assertPrivateDirectoryExists(root)) return undefined;
      const directory = join(root, expectedId.slice(0, 2));
      if (!await assertPrivateDirectoryExists(directory)) return undefined;
      const path = blobPath(directory, expectedId);
      try {
        const stored = await readVerified(path, scope, expectedId, expectedDigest);
        if (!stored) return undefined;
        if (stored.byteLength > options.maxBytes || stored.bytes.byteLength > options.maxBytes) {
          fail("local private-run blob exceeds configured size limit");
        }
        return { bytes: Uint8Array.from(stored.bytes), digest: stored.digest, byteLength: stored.byteLength };
      } catch (error) {
        if (error instanceof PrivateRunFileBlobStoreError) throw error;
        fail("local private-run blob storage is unavailable");
      }
    },
  };

  async function readVerified(
    path: string,
    scope: PrivateRunFileScope,
    blobId: string,
    expectedDigest: PrivateRunFileDigest,
  ): Promise<{ bytes: Uint8Array; digest: PrivateRunFileDigest; byteLength: number } | undefined> {
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      fail("local private-run blob cannot be opened safely");
    }
    try {
      const before = await file.stat();
      assertReadablePrivateRegularFile(before);
      if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxEnvelopeBytes) {
        fail("local private-run blob envelope exceeds configured size limit");
      }
      const envelopeBytes = Buffer.alloc(before.size);
      for (let offset = 0; offset < envelopeBytes.byteLength;) {
        const { bytesRead } = await file.read(envelopeBytes, offset, envelopeBytes.byteLength - offset, offset);
        if (bytesRead === 0) fail("local private-run blob changed during read");
        offset += bytesRead;
      }
      const after = await file.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs) {
        fail("local private-run blob changed during read");
      }
      assertReadablePrivateRegularFile(after);
      let envelope: unknown;
      try {
        envelope = JSON.parse(envelopeBytes.toString("utf8"));
      } catch {
        fail("local private-run blob envelope is malformed");
      }
      if (!isEnvelope(envelope, blobId, expectedDigest, options.maxBytes, maxEnvelopeBytes)) {
        fail("local private-run blob envelope is invalid");
      }
      const ciphertext = decodeBase64(envelope.ciphertextBase64);
      const aad = aadFor(scope, blobId, expectedDigest, envelope.byteLength);
      let plaintextBase64: string;
      try {
        plaintextBase64 = await options.cryptoBoundary.open(ciphertext, "global", aad);
      } catch {
        fail("local private-run blob authentication failed");
      }
      const plaintext = decodeBase64(plaintextBase64);
      if (plaintext.byteLength !== envelope.byteLength || plaintext.byteLength > options.maxBytes ||
        await digestBytes(plaintext) !== expectedDigest) {
        fail("local private-run blob content verification failed");
      }
      await reconcilePublishedLinks(path, blobId, file, before.nlink);
      // Recovery is not complete until a fresh path read observes the
      // directory-synchronized, single-link final object.
      if (before.nlink === 2) {
        const finalRead = await readVerified(path, scope, blobId, expectedDigest);
        if (!finalRead) fail("local private-run blob final object disappeared after recovery");
        return finalRead;
      }
      return { bytes: plaintext, digest: expectedDigest, byteLength: plaintext.byteLength };
    } finally {
      await file.close().catch(() => fail("local private-run blob file could not be closed"));
    }
  }
}

class PrivateRunFileBlobStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateRunFileBlobStoreError";
  }
}

function fail(message: string): never {
  throw new PrivateRunFileBlobStoreError(message);
}

function snapshotScope(scope: PrivateRunFileScope): PrivateRunFileScope {
  if (!scope || typeof scope !== "object") fail("invalid local private-run blob scope");
  for (const value of [scope.workspaceId, scope.capsuleId, scope.environment, scope.slot]) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      fail("invalid local private-run blob scope");
    }
  }
  return {
    workspaceId: scope.workspaceId,
    capsuleId: scope.capsuleId,
    environment: scope.environment,
    slot: scope.slot,
  };
}

function validateDigest(value: unknown): PrivateRunFileDigest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) fail("invalid local private-run blob digest");
  return value as PrivateRunFileDigest;
}

function blobIdFor(scope: PrivateRunFileScope, digest: PrivateRunFileDigest): string {
  return createHash("sha256")
    .update(JSON.stringify([scope.workspaceId, scope.capsuleId, scope.environment, scope.slot, digest]))
    .digest("hex");
}

function aadFor(
  scope: PrivateRunFileScope,
  blobId: string,
  digest: PrivateRunFileDigest,
  byteLength: number,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: ENVELOPE_VERSION,
    kind: ENVELOPE_KIND,
    scope,
    blobId,
    digest,
    byteLength,
  }));
}

function encodeEnvelope(
  blobId: string,
  digest: PrivateRunFileDigest,
  byteLength: number,
  ciphertext: Uint8Array,
): string {
  return `${JSON.stringify({
    version: ENVELOPE_VERSION,
    kind: ENVELOPE_KIND,
    blobId,
    digest,
    byteLength,
    ciphertextBase64: Buffer.from(ciphertext).toString("base64"),
  })}\n`;
}

function envelopeBound(maxBytes: number): number {
  const plaintextBase64 = Math.ceil(maxBytes / 3) * 4;
  const ciphertextBase64 = Math.ceil((plaintextBase64 + 16) / 3) * 4;
  const bound = ciphertextBase64 + ENVELOPE_OVERHEAD_ALLOWANCE;
  if (!Number.isSafeInteger(bound)) fail("invalid local private-run blob size limit");
  return bound;
}

function isEnvelope(
  value: unknown,
  blobId: string,
  expectedDigest: PrivateRunFileDigest,
  maxBytes: number,
  maxEnvelopeBytes: number,
): value is {
  readonly version: number;
  readonly kind: string;
  readonly blobId: string;
  readonly digest: PrivateRunFileDigest;
  readonly byteLength: number;
  readonly ciphertextBase64: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return item.version === ENVELOPE_VERSION && item.kind === ENVELOPE_KIND && item.blobId === blobId &&
    item.digest === expectedDigest && Number.isSafeInteger(item.byteLength) &&
    (item.byteLength as number) >= 0 && (item.byteLength as number) <= maxBytes &&
    typeof item.ciphertextBase64 === "string" && item.ciphertextBase64.length <= maxEnvelopeBytes &&
    item.ciphertextBase64.length > 0;
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("local private-run blob encoding is malformed");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("local private-run blob encoding is malformed");
  return new Uint8Array(bytes);
}

async function digestBytes(bytes: Uint8Array): Promise<PrivateRunFileDigest> {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) fail("local private-run blob directory is unavailable");
  }
  await assertPrivateDirectoryExists(path);
}

async function assertPrivateDirectoryExists(path: string): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    fail("local private-run blob directory is unavailable");
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() ||
    (entry.mode & 0o077) !== 0) {
    fail("local private-run blob directory is not private");
  }
  return true;
}

async function assertPrivateRegularFile(
  file: Awaited<ReturnType<typeof open>>,
  requireNonempty: boolean,
): Promise<void> {
  const stat = await file.stat();
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 || (requireNonempty && stat.size < 1)) {
    fail("local private-run blob file is not private");
  }
}

function assertReadablePrivateRegularFile(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.nlink !== 1 && stat.nlink !== 2) ||
    (stat.mode & 0o077) !== 0 || stat.size < 1) {
    fail("local private-run blob file is not private");
  }
}

async function reconcilePublishedLinks(
  finalPath: string,
  blobId: string,
  file: Awaited<ReturnType<typeof open>>,
  initialLinkCount: number,
): Promise<void> {
  const directory = dirname(finalPath);
  const current = await file.stat();
  assertReadablePrivateRegularFile(current);
  if (current.nlink === 1) {
    if (initialLinkCount === 2) {
      await assertFinalPathIsSameInode(finalPath, current, 1);
      await syncDirectory(directory);
    } else if (initialLinkCount !== 1) {
      fail("local private-run blob link state is ambiguous");
    }
    return;
  }
  if (initialLinkCount !== 2 || current.nlink !== 2) {
    fail("local private-run blob has foreign hard links");
  }
  await assertFinalPathIsSameInode(finalPath, current, 2);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    fail("local private-run blob staging link cannot be reconciled");
  }
  const tempNamePattern = new RegExp(
    `^${blobId}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
    "u",
  );
  const sameInodeCandidates: string[] = [];
  for (const name of names.filter((candidate) => tempNamePattern.test(candidate))) {
    try {
      const candidateStat = await lstat(join(directory, name));
      if (candidateStat.dev !== current.dev || candidateStat.ino !== current.ino) continue;
      if (!samePrivateLink(candidateStat, current, 2)) {
        fail("local private-run blob staging link is not owned by this store");
      }
      sameInodeCandidates.push(name);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      if (error instanceof PrivateRunFileBlobStoreError) throw error;
      fail("local private-run blob staging link cannot be inspected");
    }
  }
  if (sameInodeCandidates.length === 0) {
    await acceptPeerReap(finalPath, directory, file, current);
    return;
  }
  if (sameInodeCandidates.length !== 1) fail("local private-run blob staging link is ambiguous");
  const temporaryPath = join(directory, sameInodeCandidates[0]);
  await assertFinalPathIsSameInode(finalPath, current, 2);
  let latestTemporary: Stats;
  try {
    latestTemporary = await lstat(temporaryPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      await acceptPeerReap(finalPath, directory, file, current);
      return;
    }
    fail("local private-run blob staging link cannot be inspected");
  }
  if (!samePrivateLink(latestTemporary, current, 2)) {
    fail("local private-run blob staging link changed during recovery");
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) fail("local private-run blob staging link could not be removed");
  }
  const after = await assertFinalPathIsSameInode(finalPath, current, 1);
  if (after.nlink !== 1) fail("local private-run blob link state remains ambiguous");
  await syncDirectory(directory);
  await assertFinalPathIsSameInode(finalPath, current, 1);
}

async function acceptPeerReap(
  finalPath: string,
  directory: string,
  file: Awaited<ReturnType<typeof open>>,
  expected: Stats,
): Promise<void> {
  const current = await file.stat();
  if (!samePrivateLink(current, expected, 1)) {
    fail("local private-run blob concurrent recovery is incomplete");
  }
  await assertFinalPathIsSameInode(finalPath, current, 1);
  await syncDirectory(directory);
  await assertFinalPathIsSameInode(finalPath, current, 1);
}

async function assertFinalPathIsSameInode(path: string, expected: Stats, linkCount: number): Promise<Stats> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch {
    fail("local private-run blob final object disappeared during recovery");
  }
  if (!samePrivateLink(current, expected, linkCount)) {
    fail("local private-run blob final object changed during recovery");
  }
  return current;
}

function samePrivateLink(current: Stats, expected: Stats, linkCount: number): boolean {
  return current.isFile() && !current.isSymbolicLink() && current.dev === expected.dev &&
    current.ino === expected.ino && current.uid === process.getuid?.() && current.nlink === linkCount &&
    (current.mode & 0o077) === 0;
}

function blobPath(directory: string, blobId: string): string {
  return join(directory, `${blobId}.blob`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>>;
  try {
    directory = await open(path, "r");
  } catch {
    fail("local private-run blob directory could not be synchronized");
  }
  try {
    await directory.sync();
  } catch {
    fail("local private-run blob directory could not be synchronized");
  } finally {
    await directory.close().catch(() => fail("local private-run blob directory could not be closed"));
  }
}
