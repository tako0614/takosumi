import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { BackupArtifactStore, BackupObjectReader } from "../../../core/domains/backups/mod.ts";
import { digestBytes, StateArtifactCrypto } from "../../../worker/src/state_crypto.ts";

type PutInput = Parameters<BackupArtifactStore["put"]>[0];

/**
 * Immutable self-host backup objects on an operator-owned POSIX volume.
 * References are validated object keys, then hashed into flat filenames; no
 * caller-controlled segment is ever used as a filesystem path. Payloads use
 * the same at-rest encryption as R2 backups. Only putPlain public sidecars are
 * stored unsealed, and they still require private filesystem permissions.
 */
export class FileBackupArtifactStore implements BackupArtifactStore, BackupObjectReader {
  readonly #root: string;
  readonly #crypto: StateArtifactCrypto;

  private constructor(root: string, crypto: StateArtifactCrypto) {
    this.#root = root;
    this.#crypto = crypto;
  }

  /** Parent directories must already exist; unsafe existing mounts fail closed. */
  static async create(input: {
    readonly root: string;
    readonly crypto: StateArtifactCrypto;
  }): Promise<FileBackupArtifactStore> {
    if (!isAbsolute(input.root) || normalize(input.root) !== input.root ||
      input.root === "/" || input.root.includes("\0")) {
      throw new TypeError("file backup store requires a normalized absolute root");
    }
    // Refuse symlinked ancestors before mkdir can follow one outside the mount.
    if (await realpath(dirname(input.root)) !== dirname(input.root)) {
      throw new Error("file backup store parent must not contain symlinks");
    }
    let created = false;
    try {
      await mkdir(input.root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const store = new FileBackupArtifactStore(input.root, input.crypto);
    const directory = await store.#openRoot();
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (created) {
      const parent = await open(dirname(input.root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    return store;
  }

  async put(input: PutInput): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    const path = this.#path(input.ref);
    const sealed = await this.#crypto.seal(Uint8Array.from(input.payload));
    return await this.#publish(path, sealed.ciphertext);
  }

  async putPlain(input: PutInput): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    return await this.#publish(this.#path(input.ref), Uint8Array.from(input.payload));
  }

  /** Reads stored bytes, never decrypting private artifacts into the reader seam. */
  async get(ref: string): Promise<Uint8Array | undefined> {
    const path = this.#path(ref);
    const directory = await this.#openRoot();
    try {
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return undefined;
        throw error;
      }
      try {
        assertPrivate(await file.stat(), "file");
        return new Uint8Array(await file.readFile());
      } finally {
        await file.close();
      }
    } finally {
      await directory.close();
    }
  }

  #path(ref: string): string {
    if (typeof ref !== "string" || ref.length === 0 || ref.length > 4096 ||
      !/^[A-Za-z0-9._/-]+$/u.test(ref) ||
      ref.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new TypeError("invalid file backup artifact reference");
    }
    return join(this.#root, `${createHash("sha256").update(ref).digest("hex")}.artifact`);
  }

  async #openRoot() {
    if (await realpath(this.#root) !== this.#root) {
      throw new Error("file backup store root must not contain symlinks");
    }
    const directory = await open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      assertPrivate(await directory.stat(), "directory");
      return directory;
    } catch (error) {
      await directory.close();
      throw error;
    }
  }

  async #publish(path: string, bytes: Uint8Array): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    const directory = await this.#openRoot();
    const temporaryPath = join(this.#root, `${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      try {
        assertPrivate(await temporary.stat(), "file");
        await temporary.writeFile(bytes);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      // link is an atomic no-replace publication, unlike rename. Neither a
      // retry nor a malicious symlink can overwrite an occupied reference.
      await link(temporaryPath, path);
      await unlink(temporaryPath);
      temporaryCreated = false;
      await directory.sync();
      return { digest: await digestBytes(bytes), sizeBytes: bytes.byteLength };
    } finally {
      try {
        if (temporaryCreated) await unlink(temporaryPath);
      } finally {
        await directory.close();
      }
    }
  }
}

function assertPrivate(stats: Stats, kind: "file" | "directory"): void {
  const validType = kind === "file" ? stats.isFile() && stats.nlink === 1 : stats.isDirectory();
  if (!validType || (stats.mode & 0o7777) !== (kind === "file" ? 0o600 : 0o700) ||
    (process.getuid && stats.uid !== process.getuid())) {
    throw new Error(`file backup store requires owner-only ${kind} permissions`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
