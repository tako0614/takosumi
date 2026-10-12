import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PartitionedSecretBoundaryCrypto, PlaceholderSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
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

function spawnBlobWriter(input: {
  readonly root: string;
  readonly bytes: Uint8Array;
  readonly markerPath?: string;
  readonly releasePath?: string;
}): ChildProcess {
  const cryptoModule = new URL("../../../../core/adapters/secret-store/memory.ts", import.meta.url).href;
  const blobModule = new URL("../../../../deploy/node-postgres/src/local-private-run-file-blob-store.ts", import.meta.url).href;
  const marker = input.markerPath ? JSON.stringify(input.markerPath) : undefined;
  const release = input.releasePath ? JSON.stringify(input.releasePath) : undefined;
  const hook = marker
    ? `testOnlyAfterPublishLink: async () => {
        const { writeFile, access } = await import("node:fs/promises");
        const marker = ${marker};
        await writeFile(marker, "linked");
        ${release ? `const release = ${release}; while (true) { try { await access(release); return; } catch {} await new Promise((resolve) => setTimeout(resolve, 5)); }` : "await new Promise(() => {});"}
      },`
    : "";
  const script = `
    import { createHash } from "node:crypto";
    import { PartitionedSecretBoundaryCrypto } from ${JSON.stringify(cryptoModule)};
    import { createLocalPrivateRunFileBlobStore } from ${JSON.stringify(blobModule)};
    const bytes = Uint8Array.from(Buffer.from(${JSON.stringify(Buffer.from(input.bytes).toString("base64"))}, "base64"));
    const scope = ${JSON.stringify(SCOPE)};
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    const store = createLocalPrivateRunFileBlobStore({
      root: ${JSON.stringify(input.root)}, maxBytes: 64,
      cryptoBoundary: new PartitionedSecretBoundaryCrypto({ globalPassphrase: "private-run-file-blob-test-passphrase-at-least-32-bytes" }),
      ${hook}
    });
    await store.putEncryptedImmutable({ scope, bytes, digest });
  `;
  return spawn(process.execPath, ["--eval", script], { stdio: "ignore" });
}

async function waitForPath(path: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    try {
      await access(path);
      return;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("blob writer exited before link phase");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("blob writer did not reach link phase");
}

async function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      reject(new Error("blob writer did not exit"));
    }, 10_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
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

test("SIGKILL after final link is recovered by exact read and retry after process restart", async () => {
  const f = await fixture();
  const bytes = new TextEncoder().encode("process-crash-exact-bytes");
  const marker = join(dirname(f.root), "linked");
  let child: ChildProcess | undefined;
  try {
    child = spawnBlobWriter({ root: f.root, bytes, markerPath: marker });
    await waitForPath(marker, child);
    const childExit = waitForChild(child);
    child.kill("SIGKILL");
    expect(await childExit).toEqual({ code: null, signal: "SIGKILL" });

    const blobId = blobIdFor(SCOPE, digest(bytes));
    const path = blobPath(f.root, blobId);
    expect((await lstat(path)).nlink).toBe(2);
    const reopened = createLocalPrivateRunFileBlobStore({ root: f.root, maxBytes: 64, cryptoBoundary: TEST_CRYPTO });
    expect(await reopened.readEncryptedVerified({ scope: SCOPE, blobId, expectedDigest: digest(bytes) }))
      .toEqual({ bytes, digest: digest(bytes), byteLength: bytes.byteLength });
    expect((await lstat(path)).nlink).toBe(1);
    expect((await readdir(dirname(path))).some((name) => name.startsWith(`${blobId}.`) && name.endsWith(".tmp")))
      .toBe(false);
    expect(await reopened.putEncryptedImmutable({ scope: SCOPE, bytes, digest: digest(bytes) }))
      .toEqual({ blobId, digest: digest(bytes), byteLength: bytes.byteLength });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const childExit = waitForChild(child);
      child.kill("SIGKILL");
      await childExit.catch(() => undefined);
    }
    await f.cleanup();
  }
});

test("concurrent exact process retry reaps only the winner's temporary link and both puts succeed", async () => {
  const f = await fixture();
  const bytes = new TextEncoder().encode("two-process-same-immutable-put");
  const marker = join(dirname(f.root), "linked");
  const release = join(dirname(f.root), "release");
  let winner: ChildProcess | undefined;
  let retry: ChildProcess | undefined;
  try {
    winner = spawnBlobWriter({ root: f.root, bytes, markerPath: marker, releasePath: release });
    await waitForPath(marker, winner);
    retry = spawnBlobWriter({ root: f.root, bytes });
    const retryExit = await waitForChild(retry);
    expect(retryExit).toEqual({ code: 0, signal: null });
    await writeFile(release, "continue");
    expect(await waitForChild(winner)).toEqual({ code: 0, signal: null });

    const blobId = blobIdFor(SCOPE, digest(bytes));
    expect((await lstat(blobPath(f.root, blobId))).nlink).toBe(1);
    expect(await f.store.readEncryptedVerified({ scope: SCOPE, blobId, expectedDigest: digest(bytes) }))
      .toEqual({ bytes, digest: digest(bytes), byteLength: bytes.byteLength });
  } finally {
    for (const child of [retry, winner]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const childExit = waitForChild(child);
        child.kill("SIGKILL");
        await childExit.catch(() => undefined);
      }
    }
    await f.cleanup();
  }
});

test("placeholder base64 crypto cannot configure private-run blob storage", async () => {
  const f = await fixture();
  try {
    expect(() => createLocalPrivateRunFileBlobStore({
      root: f.root,
      maxBytes: 64,
      cryptoBoundary: new PlaceholderSecretBoundaryCrypto() as unknown as PartitionedSecretBoundaryCrypto,
    })).toThrow(/partitioned encryption/);
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
