import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackupArtifactStore } from "../../../../deploy/node-postgres/src/file-backup-artifact-store.ts";
import { digestBytes, StateArtifactCrypto } from "../../../../worker/src/state_crypto.ts";

const REF = "workspaces/ws_test/backups/bkp_test/control.json.zst.enc";
const PAYLOAD = new TextEncoder().encode("control export private payload");
const CRYPTO_ENV = { TAKOSUMI_SECRET_STORE_PASSPHRASE: "file-backup-test-passphrase-with-at-least-32-bytes" };
const artifactPath = (root: string, ref = REF) =>
  join(root, `${createHash("sha256").update(ref).digest("hex")}.artifact`);

async function fixture(run: (root: string, parent: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "takosumi-backup-store-"));
  try {
    await run(join(parent, "backups"), parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("file backups seal bytes, persist across reopen, and keep pointers over stored bytes", async () => {
  await fixture(async (root) => {
    const crypto = StateArtifactCrypto.fromEnv(CRYPTO_ENV);
    const store = await FileBackupArtifactStore.create({ root, crypto });
    const pointer = await store.put({ ref: REF, payload: PAYLOAD, contentType: "application/octet-stream" });
    const stored = await readFile(artifactPath(root));
    expect(stored.includes(PAYLOAD)).toBe(false);
    expect(pointer).toEqual({ digest: await digestBytes(stored), sizeBytes: stored.byteLength });
    expect(await crypto.open(stored)).toEqual(PAYLOAD);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(artifactPath(root))).mode & 0o777).toBe(0o600);
    const reopened = await FileBackupArtifactStore.create({ root, crypto });
    expect(await reopened.get(REF)).toEqual(new Uint8Array(stored));
    expect(await reopened.get("workspaces/ws_test/backups/missing/control.enc")).toBeUndefined();
    await expect(reopened.put({ ref: REF, payload: PAYLOAD, contentType: "application/octet-stream" })).rejects.toThrow();
    expect(await readFile(artifactPath(root))).toEqual(stored);
    expect(await readdir(root)).toHaveLength(1);
  });
});

test("public manifest sidecars stay plain, private and immutable", async () => {
  await fixture(async (root) => {
    const store = await FileBackupArtifactStore.create({ root, crypto: StateArtifactCrypto.fromEnv(CRYPTO_ENV) });
    const ref = "workspaces/ws_test/backups/bkp_test/artifacts.manifest.json";
    const payload = new TextEncoder().encode('{"artifacts":[]}');
    const pointer = await store.putPlain({ ref, payload, contentType: "application/json" });
    expect(await store.get(ref)).toEqual(payload);
    expect(pointer).toEqual({ digest: await digestBytes(payload), sizeBytes: payload.byteLength });
    expect((await stat(artifactPath(root, ref))).mode & 0o777).toBe(0o600);
    await expect(store.putPlain({ ref, payload, contentType: "application/json" })).rejects.toThrow();
  });
});

test("unsafe roots and references never create or read files outside the store", async () => {
  await fixture(async (root, parent) => {
    const crypto = StateArtifactCrypto.fromEnv(CRYPTO_ENV);
    await expect(FileBackupArtifactStore.create({ root: "relative/backups", crypto })).rejects.toThrow();
    const store = await FileBackupArtifactStore.create({ root, crypto });
    for (const ref of ["", "../escape", "/absolute", "a/../escape", "a/./b", "a//b", "a/", "a\\b", "a\0b", "%2e%2e/escape", "file:///tmp/escape"]) {
      await expect(store.put({ ref, payload: PAYLOAD, contentType: "application/octet-stream" })).rejects.toThrow();
      await expect(store.putPlain({ ref, payload: PAYLOAD, contentType: "application/json" })).rejects.toThrow();
      await expect(store.get(ref)).rejects.toThrow();
    }
    expect(await readdir(root)).toEqual([]);
    await chmod(root, 0o755);
    await expect(store.put({ ref: REF, payload: PAYLOAD, contentType: "application/octet-stream" })).rejects.toThrow();
    await expect(FileBackupArtifactStore.create({ root, crypto })).rejects.toThrow();
    await chmod(root, 0o700);
    const outside = join(parent, "outside");
    await mkdir(outside, { mode: 0o700 });
    const alias = join(parent, "alias");
    await symlink(outside, alias);
    await expect(FileBackupArtifactStore.create({ root: alias, crypto })).rejects.toThrow();
    await expect(FileBackupArtifactStore.create({ root: join(alias, "backups"), crypto })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});

test("symlink, hardlink and public-permission artifacts are refused without touching the target", async () => {
  await fixture(async (root, parent) => {
    const store = await FileBackupArtifactStore.create({ root, crypto: StateArtifactCrypto.fromEnv(CRYPTO_ENV) });
    const target = join(parent, "target");
    await writeFile(target, PAYLOAD, { mode: 0o600 });
    const path = artifactPath(root);
    await symlink(target, path);
    await expect(store.get(REF)).rejects.toThrow();
    await expect(store.put({ ref: REF, payload: PAYLOAD, contentType: "application/octet-stream" })).rejects.toThrow();
    expect(await readFile(target)).toEqual(Buffer.from(PAYLOAD));
    await rm(path);
    await link(target, path);
    await expect(store.get(REF)).rejects.toThrow();
    await rm(path);
    await writeFile(path, PAYLOAD, { mode: 0o644 });
    // Creation permissions are filtered by umask; require the intended unsafe mode.
    await chmod(path, 0o644);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await expect(store.get(REF)).rejects.toThrow();
  });
});

test("concurrent publications keep exactly one complete immutable object", async () => {
  await fixture(async (root) => {
    const crypto = StateArtifactCrypto.fromEnv(CRYPTO_ENV);
    const store = await FileBackupArtifactStore.create({ root, crypto });
    const results = await Promise.allSettled([
      store.put({ ref: REF, payload: PAYLOAD, contentType: "application/octet-stream" }),
      store.put({ ref: REF, payload: new TextEncoder().encode("second"), contentType: "application/octet-stream" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("no winner");
    const stored = (await store.get(REF))!;
    expect(winner.value).toEqual({ digest: await digestBytes(stored), sizeBytes: stored.byteLength });
    expect([Buffer.from(PAYLOAD).toString(), "second"]).toContain(Buffer.from(await crypto.open(stored)).toString());
    expect(await readdir(root)).toHaveLength(1);
  });
});
