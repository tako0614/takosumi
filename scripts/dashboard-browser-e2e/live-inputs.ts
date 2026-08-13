import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const WORKER_VERSION_ID_PATTERN =
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

/** Validate the immutable Worker Version identity supplied by the operator. */
export function validateExpectedWorkerVersionId(
  value: string,
  label = "TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID",
): string {
  const normalized = value.trim();
  if (!WORKER_VERSION_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a lowercase UUID`);
  }
  return normalized;
}

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
