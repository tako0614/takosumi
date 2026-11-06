import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { RUN_ROOT } from "./constants.ts";
import { enterSensitiveFilePhase } from "./source_build_phase_gate.ts";
import type { PhaseLease } from "./source_build_phase_gate.ts";

export interface PhaseHome {
  readonly path: string;
  readonly env: { readonly HOME: string; readonly XDG_CONFIG_HOME: string };
  cleanup(): Promise<void>;
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function canonicalFuturePath(path: string): Promise<string> {
  let existing = resolve(path);
  const absent: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(existing), ...absent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) {
        throw new Error("phase HOME root verification failed");
      }
      absent.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
}

/** The parent process owns this directory and never places it in a Run workspace. */
export async function createPhaseHome(forbiddenRoots: readonly string[] = []): Promise<PhaseHome> {
  // All service workspaces are below RUN_ROOT. An operator may point TMPDIR
  // inside one of them; choose a separate existing temp parent in that case.
  const roots = [RUN_ROOT, ...forbiddenRoots].map((root) => resolve(root));
  const forbidden = [...roots, ...await Promise.all(roots.map(canonicalFuturePath))];
  let parent: string | undefined;
  let parentInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const candidate of new Set([tmpdir(), "/tmp", "/var/tmp"].map((path) => resolve(path)))) {
    const canonicalCandidate = await canonicalFuturePath(candidate).catch(() => undefined);
    if (!canonicalCandidate || forbidden.some((root) =>
      isWithin(candidate, root) || isWithin(canonicalCandidate, root)
    )) continue;
    const info = await lstat(candidate).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    parent = candidate;
    parentInfo = info;
    break;
  }
  if (!parent || !parentInfo) throw new Error("phase HOME parent is unsafe");
  const path = await mkdtemp(join(parent, "takosumi-phase-home-"));
  const createdInfo = await lstat(path);
  if (!createdInfo.isDirectory() || createdInfo.isSymbolicLink()) {
    throw new Error("phase HOME is unsafe");
  }
  const canonicalPath = await canonicalFuturePath(path);
  if (forbidden.some((root) =>
    isWithin(path, root) || isWithin(canonicalPath, root) ||
    isWithin(root, path) || isWithin(root, canonicalPath)
  )) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    throw new Error("phase HOME overlaps a Run workspace");
  }
  let info;
  try {
    await chmod(path, 0o700);
    await mkdir(join(path, ".config"), { mode: 0o700 });
    info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      info.dev !== createdInfo.dev || info.ino !== createdInfo.ino ||
      (info.mode & 0o777) !== 0o700) {
      throw new Error("phase HOME is unsafe");
    }
  } catch (error) {
    // Failed verification is a failed setup. Do not follow a replaced path.
    const current = await lstat(path).catch(() => undefined);
    if (current?.isDirectory() && !current.isSymbolicLink() &&
      current.dev === createdInfo.dev && current.ino === createdInfo.ino) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
  let cleaned = false;
  return {
    path,
    env: { HOME: path, XDG_CONFIG_HOME: join(path, ".config") },
    async cleanup() {
      if (cleaned) return;
      if (dirname(path) !== parent || resolve(path) !== path) {
        throw new Error("phase HOME cleanup path is unsafe");
      }
      const currentParent = await lstat(parent).catch(() => undefined);
      if (!currentParent?.isDirectory() || currentParent.isSymbolicLink() ||
        currentParent.dev !== parentInfo.dev || currentParent.ino !== parentInfo.ino) {
        throw new Error("phase HOME cleanup parent changed");
      }
      const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw new Error("phase HOME cleanup verification failed");
      });
      if (current && (!current.isDirectory() || current.isSymbolicLink() ||
        current.dev !== info.dev || current.ino !== info.ino)) {
        throw new Error("phase HOME cleanup ownership changed");
      }
      if (current) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch {
          throw new Error("phase HOME cleanup failed");
        }
      }
      cleaned = true;
    },
  };
}

/** Standalone command phases share the source-build exclusion gate. */
export async function enterCommandPhaseHome(signal?: AbortSignal): Promise<{
  readonly home: PhaseHome;
  readonly lease: PhaseLease;
  cleanup(): Promise<void>;
}> {
  const lease = await enterSensitiveFilePhase(signal);
  let home: PhaseHome;
  try {
    home = await createPhaseHome();
  } catch (error) {
    lease.poison();
    throw error;
  }
  let cleaned = false;
  return {
    home,
    lease,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        await home.cleanup();
        lease.release();
      } catch {
        lease.poison();
      }
    },
  };
}
