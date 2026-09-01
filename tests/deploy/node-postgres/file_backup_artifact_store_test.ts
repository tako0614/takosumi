/**
 * The self-host backup lane. Without a store here the backups routes answered
 * 501 and — quietly — every scheduled removal recorded its pre-destroy export
 * as `skipped`, even though the removal copy promises an attempt.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import {
  createFileBackupArtifactStore,
  createFileBackupObjectReader,
} from "../../../deploy/node-postgres/src/file-backup-artifact-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-backup-"));
  roots.push(root);
  return root;
}

/** Reversible stand-in that still proves sealing happened. */
function reversibleCrypto(): SecretBoundaryCrypto {
  return {
    seal: (plaintext: string, partition: string) =>
      Promise.resolve(
        new TextEncoder().encode(`sealed:${partition}:${plaintext}`),
      ),
    open: (ciphertext: Uint8Array, partition: string) => {
      const text = new TextDecoder().decode(ciphertext);
      const prefix = `sealed:${partition}:`;
      if (!text.startsWith(prefix)) throw new Error("wrong partition");
      return Promise.resolve(text.slice(prefix.length));
    },
  } as unknown as SecretBoundaryCrypto;
}

test("a backup round-trips through the sealed file store", async () => {
  const root = await tempRoot();
  const crypto = reversibleCrypto();
  const store = createFileBackupArtifactStore(root, crypto);
  const reader = createFileBackupObjectReader(root, crypto);
  const payload = new TextEncoder().encode("service data bundle");

  const written = await store.put({
    ref: "ws_1/cap_1/backup-1.bin",
    payload,
    contentType: "application/octet-stream",
  });
  expect(written.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(written.sizeBytes).toBeGreaterThan(0);

  expect(await reader.get("ws_1/cap_1/backup-1.bin")).toEqual(payload);
});

test("what lands on disk is sealed, not the plaintext payload", async () => {
  const root = await tempRoot();
  const store = createFileBackupArtifactStore(root, reversibleCrypto());
  const secret = "database-password-in-the-bundle";

  await store.put({
    ref: "ws_1/cap_1/secret.bin",
    payload: new TextEncoder().encode(secret),
    contentType: "application/octet-stream",
  });

  const onDisk = await Bun.file(
    join(root, "ws_1", "cap_1", "secret.bin"),
  ).text();
  expect(onDisk).not.toContain(secret);
  expect(onDisk).toContain("sealed:");
});

test("a public sidecar stays readable as written", async () => {
  const root = await tempRoot();
  const crypto = reversibleCrypto();
  const store = createFileBackupArtifactStore(root, crypto);
  const manifest = new TextEncoder().encode('{"artifacts":[]}');

  await store.putPlain!({
    ref: "ws_1/cap_1/artifacts.manifest.json",
    payload: manifest,
    contentType: "application/json",
  });

  expect(
    await Bun.file(
      join(root, "ws_1", "cap_1", "artifacts.manifest.json"),
    ).text(),
  ).toBe('{"artifacts":[]}');
  // The reader returns a non-sealed sidecar unchanged rather than failing.
  expect(
    await createFileBackupObjectReader(root, crypto).get(
      "ws_1/cap_1/artifacts.manifest.json",
    ),
  ).toEqual(manifest);
});

test("a traversal ref is neutralized, not followed", async () => {
  const root = await tempRoot();
  const store = createFileBackupArtifactStore(root, reversibleCrypto());
  await store.put({
    ref: "../../etc/passwd",
    payload: new Uint8Array([1]),
    contentType: "application/octet-stream",
  });
  // The `..` segments are dropped rather than walked, so the write lands
  // inside the root under the remaining name.
  expect(await Bun.file(join(root, "etc", "passwd")).exists()).toBe(true);
});

test("a ref made only of traversal is rejected outright", async () => {
  const root = await tempRoot();
  const store = createFileBackupArtifactStore(root, reversibleCrypto());
  await expect(
    store.put({
      ref: "../..",
      payload: new Uint8Array([1]),
      contentType: "application/octet-stream",
    }),
  ).rejects.toThrow();
});

test("an unknown ref reads as absent rather than throwing", async () => {
  const root = await tempRoot();
  expect(
    await createFileBackupObjectReader(root, reversibleCrypto()).get(
      "ws_1/cap_1/missing.bin",
    ),
  ).toBeUndefined();
});
