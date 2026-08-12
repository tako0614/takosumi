import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  realpath,
  rm,
} from "node:fs/promises";
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

export interface OwnerPrivateReadOptions {
  readonly sourceRoots: readonly string[];
  readonly maxBytes: number;
  readonly label?: string;
}

export interface NewOwnerPrivateEvidenceTargetOptions {
  readonly sourceRoots: readonly string[];
  readonly label?: string;
}

export async function assertNewOwnerPrivateEvidenceTarget(
  file: string,
  options: NewOwnerPrivateEvidenceTargetOptions,
): Promise<string> {
  const label = options.label ?? "private evidence";
  if (!isAbsolute(file) || options.sourceRoots.length === 0) {
    throw new Error(`${label} path must be absolute with source checkouts`);
  }
  const target = resolve(file);
  const parent = dirname(target);
  await rejectSymlinkComponents(parent);
  await assertOutsideSourceCheckouts(target, options.sourceRoots);
  const owner = process.getuid?.();
  if (owner === undefined) {
    throw new Error(`${label} ownership requires a POSIX runtime`);
  }
  const parentInfo = await lstat(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    parentInfo.uid !== owner ||
    (parentInfo.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error(
      `${label} parent must be an owner-matched non-symlink directory with mode 0700`,
    );
  }
  if ((await lstatOrUndefined(target)) !== undefined) {
    throw new Error(`${label} target already exists`);
  }
  return target;
}

export async function readOwnerPrivateTextFile(
  file: string,
  options: OwnerPrivateReadOptions,
): Promise<string> {
  const label = options.label ?? "private evidence";
  if (!isAbsolute(file)) {
    throw new Error(`${label} path must be absolute`);
  }
  if (
    options.sourceRoots.length === 0 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0
  ) {
    throw new Error(`${label} read policy is invalid`);
  }
  const target = resolve(file);
  const parent = dirname(target);
  await rejectSymlinkComponents(parent);
  const targetInfo = await lstatOrUndefined(target);
  if (targetInfo?.isSymbolicLink()) {
    throw new Error(`${label} path must not contain symlinks`);
  }
  if (!targetInfo?.isFile()) {
    throw new Error(`${label} must be an existing regular file`);
  }
  await assertOutsideSourceCheckouts(target, options.sourceRoots);

  const owner = process.getuid?.();
  if (owner === undefined) {
    throw new Error(`${label} ownership requires a POSIX runtime`);
  }
  const parentInfo = await lstat(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.uid !== owner ||
    (parentInfo.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error(`${label} parent must be owner-matched mode 0700`);
  }

  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const [info, pathInfo] = await Promise.all([handle.stat(), lstat(target)]);
    if (
      !info.isFile() ||
      pathInfo.isSymbolicLink() ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino ||
      info.uid !== owner ||
      (info.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new Error(`${label} must be an owner-matched mode 0600 file`);
    }
    if (info.size <= 0 || info.size > options.maxBytes) {
      throw new Error(`${label} file size is invalid`);
    }
    const value = await handle.readFile("utf8");
    if (Buffer.byteLength(value) > options.maxBytes) {
      throw new Error(`${label} file size is invalid`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

/** Atomically publishes complete JSON without replacing an existing path. */
export async function writeNewPrivateEvidenceJson(
  file: string,
  value: unknown,
): Promise<void> {
  const target = resolve(file);
  const parent = dirname(target);
  const temporary = join(
    parent,
    `.${basename(target)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rejectSymlinkComponents(parent);
    await link(temporary, target);
    await chmod(target, PRIVATE_FILE_MODE);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error("private evidence target already exists");
    }
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertOutsideSourceCheckouts(
  path: string,
  sourceRoots: readonly string[],
): Promise<void> {
  const target = resolve(path);
  const physicalTarget = await physicalBoundaryPath(target);
  for (const sourceRoot of sourceRoots) {
    const canonicalRoot = await canonicalSourceRoot(sourceRoot);
    const relation = relative(canonicalRoot, physicalTarget);
    if (
      relation === "" ||
      (relation !== ".." &&
        !relation.startsWith(`..${sep}`) &&
        !isAbsolute(relation))
    ) {
      throw new Error("private path must live outside source checkouts");
    }
  }
}

async function physicalBoundaryPath(target: string): Promise<string> {
  let current = dirname(target);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(
        await realpath(current),
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

async function canonicalSourceRoot(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return resolve(path);
    throw error;
  }
}

async function rejectSymlinkComponents(target: string): Promise<void> {
  if (!isAbsolute(target)) {
    throw new Error("private evidence path must resolve to an absolute path");
  }
  const root = parse(target).root;
  const parts = target
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstatOrUndefined(current);
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new Error("private evidence path must not contain symlinks");
    }
    if (!info.isDirectory()) {
      throw new Error("private evidence parent path contains a non-directory");
    }
  }
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
