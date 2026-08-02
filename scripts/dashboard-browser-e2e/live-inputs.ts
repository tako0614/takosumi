import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve the live browser session state without allowing repository-local
 * fixtures, tracked files, or symlink escapes to become authentication input.
 */
export function resolveExternalStorageState(
  repoRoot: string,
  value: string,
): string {
  const requested = isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
  const repoRealpath = realpathSync(repoRoot);
  const requestedStat = lstatSync(requested, { throwIfNoEntry: false });
  if (requestedStat?.isSymbolicLink()) {
    throw new Error(
      `live dashboard E2E storage state must not use a symlink: ${requested}`,
    );
  }
  if (!requestedStat || !requestedStat.isFile()) {
    throw new Error(
      `live dashboard E2E storage state must be an existing regular file: ${requested}`,
    );
  }
  const resolved = realpathSync(requested);
  if (resolved !== requested) {
    throw new Error(
      `live dashboard E2E storage state must not use a symlink: ${requested}`,
    );
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(
      `live dashboard E2E storage state must be an existing regular file: ${requested}`,
    );
  }

  const relativePath = relative(repoRealpath, resolved);
  const escapesRepository =
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);
  if (!escapesRepository) {
    throw new Error(
      "live dashboard E2E storage state must resolve outside the repository/worktree",
    );
  }
  return resolved;
}
