import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { createLocalPrivateRunFileBlobStore } from "../../../../deploy/node-postgres/src/local-private-run-file-blob-store.ts";
import type { PrivateRunFileScope } from "../../../../core/domains/private-run-files/mod.ts";

const TEST_CRYPTO = new PartitionedSecretBoundaryCrypto({
  globalPassphrase: "private-run-file-blob-test-passphrase-at-least-32-bytes",
});
const SCOPE: PrivateRunFileScope = {
  workspaceId: "workspace.local",
  capsuleId: "capsule.local",
  environment: "prod.blue",
  slot: "provider/object/opaque",
};

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function blobPath(root: string, blobId: string): string {
  return join(root, blobId.slice(0, 2), `${blobId}.blob`);
}

function blobIdFor(scope: PrivateRunFileScope, value: `sha256:${string}`): string {
  return createHash("sha256")
    .update(JSON.stringify([scope.workspaceId, scope.capsuleId, scope.environment, scope.slot, value]))
    .digest("hex");
}

async function fixture(maxBytes = 64) {
  const directory = await mkdtemp(join(tmpdir(), "prf-"));
  const root = join(directory, "blobs");
  return {
    root,
    cleanup: () => rm(directory, { recursive: true, force: true }),
    store: createLocalPrivateRunFileBlobStore({
      root,
      maxBytes,
      cryptoBoundary: TEST_CRYPTO,
    }),
  };
}

test("local private-run blob store encrypts at rest and reopens immutable bytes", async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode("opaque-private-provider-content");
    const stored = await f.store.putEncryptedImmutable({ scope: SCOPE, bytes, digest: digest(bytes) });
    const physical = await readFile(blobPath(f.root, stored.blobId));
    expect(physical.includes(Buffer.from(bytes))).toBe(false);
    const file = await lstat(blobPath(f.root, stored.blobId));
    expect(file.isFile()).toBe(true);
    expect(file.nlink).toBe(1);
    expect(file.mode & 0o077).toBe(0);
    const reopened = createLocalPrivateRunFileBlobStore({
      root: f.root,
      maxBytes: 64,
      cryptoBoundary: TEST_CRYPTO,
    });
    expect(await reopened.readEncryptedVerified({
      scope: SCOPE,
      blobId: stored.blobId,
      expectedDigest: digest(bytes),
    })).toEqual({ bytes, digest: digest(bytes), byteLength: bytes.byteLength });
  } finally {
    await f.cleanup();
  }
});

test("same-scope exact retries resolve the same immutable object; occupied corrupt objects refuse", async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode("same bytes");
    const request = { scope: SCOPE, bytes, digest: digest(bytes) };
    const first = await f.store.putEncryptedImmutable(request);
    const retry = await f.store.putEncryptedImmutable(request);
    expect(retry).toEqual(first);
    expect(await f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: first.blobId,
      expectedDigest: first.digest,
    })).toEqual({ bytes, digest: first.digest, byteLength: bytes.byteLength });

    await writeFile(blobPath(f.root, first.blobId), "occupied but not the exact object", { mode: 0o600 });
    await expect(f.store.putEncryptedImmutable(request)).rejects.toThrow();
    await expect(f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: first.blobId,
      expectedDigest: first.digest,
    })).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("scope and plaintext digest substitution cannot authenticate another blob", async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode("scope-bound bytes");
    const stored = await f.store.putEncryptedImmutable({ scope: SCOPE, bytes, digest: digest(bytes) });
    await expect(f.store.readEncryptedVerified({
      scope: { ...SCOPE, slot: "other-slot" },
      blobId: stored.blobId,
      expectedDigest: stored.digest,
    })).rejects.toThrow();

    const otherScope = { ...SCOPE, slot: "other-slot" };
    const otherScopeId = blobIdFor(otherScope, stored.digest);
    const sourceEnvelope = JSON.parse((await readFile(blobPath(f.root, stored.blobId))).toString("utf8"));
    await mkdir(join(f.root, otherScopeId.slice(0, 2)), { recursive: true, mode: 0o700 });
    await writeFile(blobPath(f.root, otherScopeId), JSON.stringify({ ...sourceEnvelope, blobId: otherScopeId }), {
      mode: 0o600,
    });
    await expect(f.store.readEncryptedVerified({
      scope: otherScope,
      blobId: otherScopeId,
      expectedDigest: stored.digest,
    })).rejects.toThrow();

    const substitutedDigest = digest(new TextEncoder().encode("other content"));
    const substitutedId = blobIdFor(SCOPE, substitutedDigest);
    await mkdir(join(f.root, substitutedId.slice(0, 2)), { recursive: true, mode: 0o700 });
    await writeFile(blobPath(f.root, substitutedId), JSON.stringify({
      ...sourceEnvelope,
      blobId: substitutedId,
      digest: substitutedDigest,
    }), { mode: 0o600 });
    await expect(f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: substitutedId,
      expectedDigest: substitutedDigest,
    })).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("malformed envelopes and writes over the configured byte bound are refused", async () => {
  const f = await fixture(8);
  try {
    const tooLarge = new Uint8Array(9).fill(7);
    await expect(f.store.putEncryptedImmutable({ scope: SCOPE, bytes: tooLarge, digest: digest(tooLarge) }))
      .rejects.toThrow();

    const bytes = new TextEncoder().encode("small");
    const stored = await f.store.putEncryptedImmutable({ scope: SCOPE, bytes, digest: digest(bytes) });
    await truncate(blobPath(f.root, stored.blobId), 2_000);
    await expect(f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: stored.blobId,
      expectedDigest: stored.digest,
    })).rejects.toThrow();

    const malformed = await f.store.putEncryptedImmutable({
      scope: { ...SCOPE, slot: "malformed" },
      bytes,
      digest: digest(bytes),
    });
    await writeFile(blobPath(f.root, malformed.blobId), "not-json", { mode: 0o600 });
    await expect(f.store.readEncryptedVerified({
      scope: { ...SCOPE, slot: "malformed" },
      blobId: malformed.blobId,
      expectedDigest: malformed.digest,
    })).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("read refuses symlinked and multiply-linked blob files", async () => {
  const f = await fixture();
  const other = await mkdtemp(join(tmpdir(), "prf-"));
  try {
    const bytes = new TextEncoder().encode("linked bytes");
    const stored = await f.store.putEncryptedImmutable({ scope: SCOPE, bytes, digest: digest(bytes) });
    const path = blobPath(f.root, stored.blobId);
    const saved = join(other, "saved.blob");
    await link(path, saved);
    await rm(path);
    await symlink(saved, path);
    await expect(f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: stored.blobId,
      expectedDigest: stored.digest,
    })).rejects.toThrow();

    await rm(path);
    await link(saved, path);
    await expect(f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: stored.blobId,
      expectedDigest: stored.digest,
    })).rejects.toThrow();
  } finally {
    await f.cleanup();
    await rm(other, { recursive: true, force: true });
  }
});

test("empty bytes are present, and put/read use independent byte snapshots", async () => {
  const f = await fixture();
  try {
    const empty = new Uint8Array();
    const emptyObject = await f.store.putEncryptedImmutable({ scope: SCOPE, bytes: empty, digest: digest(empty) });
    expect(await f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: emptyObject.blobId,
      expectedDigest: emptyObject.digest,
    })).toEqual({ bytes: empty, digest: emptyObject.digest, byteLength: 0 });

    const bytes = new TextEncoder().encode("snapshot before await");
    const original = Uint8Array.from(bytes);
    const pending = f.store.putEncryptedImmutable({ scope: SCOPE, bytes, digest: digest(bytes) });
    bytes.fill(0);
    const stored = await pending;
    const firstRead = await f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: stored.blobId,
      expectedDigest: digest(original),
    });
    expect(firstRead?.bytes).toEqual(original);
    firstRead!.bytes.fill(0);
    expect((await f.store.readEncryptedVerified({
      scope: SCOPE,
      blobId: stored.blobId,
      expectedDigest: digest(original),
    }))?.bytes).toEqual(original);
  } finally {
    await f.cleanup();
  }
});
