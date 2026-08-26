import { randomBytes } from "node:crypto";
import { chmod, link, lstat, open, realpath, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface OwnerPrivateEvidencePathInfo {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface OwnerPrivateEvidenceRuntime {
  readonly pid: number;
  getuid(): number | undefined;
  randomBytes(size: number): Uint8Array;
  lstat(path: string): Promise<OwnerPrivateEvidencePathInfo>;
  realpath(path: string): Promise<string>;
  open: typeof open;
  link(existingPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, options: { readonly force: boolean }): Promise<void>;
}

export interface WriteOwnerPrivateEvidenceOptions {
  readonly sourceRoots: readonly string[];
  readonly runtime?: OwnerPrivateEvidenceRuntime;
}

export class OwnerPrivateEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OwnerPrivateEvidenceError";
  }
}

export const nodeOwnerPrivateEvidenceRuntime: OwnerPrivateEvidenceRuntime = {
  pid: process.pid,
  getuid: () => process.getuid?.(),
  randomBytes,
  lstat,
  realpath,
  open,
  link,
  chmod,
  rm: (path, options) => rm(path, options),
};

/** Atomically publishes one new owner-private JSON file without replacement. */
export async function writeNewOwnerPrivateEvidenceJson(
  file: string,
  value: unknown,
  options: WriteOwnerPrivateEvidenceOptions,
): Promise<void> {
  const runtime = options.runtime ?? nodeOwnerPrivateEvidenceRuntime;
  const { target, parent, owner, physicalParent } =
    await assertNewOwnerPrivateTarget(file, options.sourceRoots, runtime);
  const random = [...runtime.randomBytes(12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const temporary = join(
    parent,
    `.${basename(target)}.${runtime.pid}.${random}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryInfo: OwnerPrivateEvidencePathInfo | undefined;
  let targetLinked = false;
  try {
    handle = await runtime.open(temporary, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await runtime.chmod(temporary, PRIVATE_FILE_MODE);
    temporaryInfo = await handle.stat();
    if (
      !temporaryInfo.isFile() ||
      temporaryInfo.uid !== owner ||
      (temporaryInfo.mode & 0o777) !== PRIVATE_FILE_MODE ||
      temporaryInfo.nlink !== 1
    ) {
      throw new OwnerPrivateEvidenceError(
        "owner_private_evidence_write_failed",
      );
    }
    await handle.close();
    handle = undefined;

    await rejectSymlinkComponents(parent, runtime);
    if ((await runtime.realpath(parent)) !== physicalParent) {
      throw new OwnerPrivateEvidenceError(
        "owner_private_evidence_path_invalid",
      );
    }
    if ((await lstatOrUndefined(target, runtime)) !== undefined) {
      throw new OwnerPrivateEvidenceError(
        "owner_private_evidence_target_exists",
      );
    }
    await runtime.link(temporary, target);
    targetLinked = true;
    await runtime.rm(temporary, { force: true });

    const published = await runtime.lstat(target);
    if (
      !published.isFile() ||
      published.isSymbolicLink() ||
      published.dev !== temporaryInfo.dev ||
      published.ino !== temporaryInfo.ino ||
      published.uid !== owner ||
      (published.mode & 0o777) !== PRIVATE_FILE_MODE ||
      published.nlink !== 1
    ) {
      throw new OwnerPrivateEvidenceError(
        "owner_private_evidence_write_failed",
      );
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (targetLinked && temporaryInfo) {
      const published = await lstatOrUndefined(target, runtime).catch(() =>
        undefined
      );
      if (
        published?.dev === temporaryInfo.dev &&
        published.ino === temporaryInfo.ino
      ) {
        await runtime.rm(target, { force: true }).catch(() => undefined);
      }
    }
    if (error instanceof OwnerPrivateEvidenceError) throw error;
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new OwnerPrivateEvidenceError(
        "owner_private_evidence_target_exists",
      );
    }
    throw new OwnerPrivateEvidenceError("owner_private_evidence_write_failed");
  } finally {
    await runtime.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertNewOwnerPrivateTarget(
  file: string,
  sourceRoots: readonly string[],
  runtime: OwnerPrivateEvidenceRuntime,
): Promise<{
  readonly target: string;
  readonly parent: string;
  readonly owner: number;
  readonly physicalParent: string;
}> {
  if (
    !file ||
    file.includes("\0") ||
    !isAbsolute(file) ||
    sourceRoots.length === 0
  ) {
    throw new OwnerPrivateEvidenceError("owner_private_evidence_path_invalid");
  }
  const target = resolve(file);
  const parent = dirname(target);
  try {
    await rejectSymlinkComponents(parent, runtime);
    await assertOutsideSourceRoots(target, sourceRoots, runtime);
  } catch (error) {
    if (error instanceof OwnerPrivateEvidenceError) throw error;
    throw new OwnerPrivateEvidenceError("owner_private_evidence_path_invalid");
  }
  const owner = runtime.getuid();
  if (owner === undefined) {
    throw new OwnerPrivateEvidenceError("owner_private_evidence_parent_invalid");
  }
  let parentInfo: OwnerPrivateEvidencePathInfo;
  let physicalParent: string;
  try {
    [parentInfo, physicalParent] = await Promise.all([
      runtime.lstat(parent),
      runtime.realpath(parent),
    ]);
  } catch {
    throw new OwnerPrivateEvidenceError("owner_private_evidence_parent_invalid");
  }
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    parentInfo.uid !== owner ||
    (parentInfo.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new OwnerPrivateEvidenceError("owner_private_evidence_parent_invalid");
  }
  if ((await lstatOrUndefined(target, runtime)) !== undefined) {
    throw new OwnerPrivateEvidenceError("owner_private_evidence_target_exists");
  }
  return { target, parent, owner, physicalParent };
}

async function assertOutsideSourceRoots(
  target: string,
  sourceRoots: readonly string[],
  runtime: OwnerPrivateEvidenceRuntime,
): Promise<void> {
  const physicalTarget = await physicalBoundaryPath(target, runtime);
  for (const sourceRoot of sourceRoots) {
    if (!isAbsolute(sourceRoot)) {
      throw new OwnerPrivateEvidenceError(
        "owner_private_evidence_path_invalid",
      );
    }
    const canonicalRoot = await canonicalSourceRoot(sourceRoot, runtime);
    const relation = relative(canonicalRoot, physicalTarget);
    if (
      relation === "" ||
      (relation !== ".." &&
        !relation.startsWith(`..${sep}`) &&
        !isAbsolute(relation))
    ) {
      throw new OwnerPrivateEvidenceError(
        "owner_private_evidence_path_invalid",
      );
    }
  }
}

async function physicalBoundaryPath(
  target: string,
  runtime: OwnerPrivateEvidenceRuntime,
): Promise<string> {
  let current = dirname(target);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(
        await runtime.realpath(current),
        ...missing.reverse(),
        basename(target),
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function canonicalSourceRoot(
  sourceRoot: string,
  runtime: OwnerPrivateEvidenceRuntime,
): Promise<string> {
  try {
    return await runtime.realpath(resolve(sourceRoot));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return resolve(sourceRoot);
    }
    throw error;
  }
}

async function rejectSymlinkComponents(
  target: string,
  runtime: OwnerPrivateEvidenceRuntime,
): Promise<void> {
  if (!isAbsolute(target)) {
    throw new OwnerPrivateEvidenceError("owner_private_evidence_path_invalid");
  }
  const root = parse(target).root;
  const parts = target
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstatOrUndefined(current, runtime);
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new OwnerPrivateEvidenceError(
        "owner_private_evidence_path_invalid",
      );
    }
  }
}

async function lstatOrUndefined(
  path: string,
  runtime: OwnerPrivateEvidenceRuntime,
): Promise<OwnerPrivateEvidencePathInfo | undefined> {
  try {
    return await runtime.lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
