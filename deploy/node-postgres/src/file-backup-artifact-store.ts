/**
 * Filesystem-backed {@link BackupArtifactStore} for the Bun + Postgres
 * self-host profile.
 *
 * Without one, this distribution had no backup lane at all: the backups routes
 * answered 501 and — more quietly — the two-phase uninstall's pre-destroy
 * export always recorded `skipped`. The removal copy promises Takosumi will
 * "try to export your data first", so on self-host that promise could never be
 * kept. Sealed bytes land under the same durable runtime volume as the
 * OpenTofu state artifacts, using the same at-rest crypto boundary.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { SecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import type {
  BackupArtifactStore,
  BackupObjectReader,
} from "../../../core/domains/backups/mod.ts";

/** Partition label so a backup blob cannot be opened as another artifact kind. */
const BACKUP_SECRET_PARTITION = "takosumi.backup-artifact";

/**
 * Maps an opaque `ref` onto a path INSIDE the root. The service composes refs
 * from workspace/capsule ids, so a traversal component must never escape the
 * volume even if a future id shape allows one.
 */
function backupPath(root: string, ref: string): string {
  const safe = ref
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .map((segment) => encodeURIComponent(segment));
  if (safe.length === 0) throw new TypeError("backup ref is empty");
  const path = resolve(join(root, ...safe));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new TypeError("backup ref escapes the backup root");
  }
  return path;
}

async function sha256Hex(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export function createFileBackupArtifactStore(
  root: string,
  cryptoBoundary: SecretBoundaryCrypto,
): BackupArtifactStore {
  const normalizedRoot = resolve(root);
  return {
    async put(input) {
      // The service hands over plaintext; what lands on disk is sealed, and
      // the returned digest is over the SEALED bytes so the record pointer
      // matches the object actually stored (same rule as the R2 store).
      const sealed = await cryptoBoundary.seal(
        Buffer.from(input.payload).toString("base64"),
        BACKUP_SECRET_PARTITION,
      );
      await writeBytes(backupPath(normalizedRoot, input.ref), sealed);
      return {
        digest: await sha256Hex(sealed),
        sizeBytes: sealed.byteLength,
      };
    },
    async putPlain(input) {
      // Public sidecars (the artifact manifest) are deliberately readable.
      await writeBytes(backupPath(normalizedRoot, input.ref), input.payload);
      return {
        digest: await sha256Hex(input.payload),
        sizeBytes: input.payload.byteLength,
      };
    },
  };
}

export function createFileBackupObjectReader(
  root: string,
  cryptoBoundary: SecretBoundaryCrypto,
): BackupObjectReader {
  const normalizedRoot = resolve(root);
  return {
    async get(ref: string): Promise<Uint8Array | undefined> {
      let sealed: Buffer;
      try {
        sealed = await readFile(backupPath(normalizedRoot, ref));
      } catch {
        return undefined;
      }
      try {
        const plaintext = await cryptoBoundary.open(
          new Uint8Array(sealed),
          BACKUP_SECRET_PARTITION,
        );
        return new Uint8Array(Buffer.from(plaintext, "base64"));
      } catch {
        // A sidecar written by `putPlain` is not sealed; return it as stored.
        return new Uint8Array(sealed);
      }
    },
  };
}
