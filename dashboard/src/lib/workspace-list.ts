import { listWorkspaces, type Workspace } from "./control-api.ts";

const CACHE_TTL_MS = 10_000;

let cachedWorkspaces: readonly Workspace[] | undefined;
let cachedAt = 0;
let inflight: Promise<readonly Workspace[]> | undefined;

function cacheIsFresh(now = Date.now()): boolean {
  return (
    cachedWorkspaces !== undefined &&
    cachedAt > 0 &&
    now - cachedAt < CACHE_TTL_MS
  );
}

export function clearWorkspaceListCache(): void {
  cachedWorkspaces = undefined;
  cachedAt = 0;
  inflight = undefined;
}

export function primeWorkspaceListCache(
  workspaces: readonly Workspace[],
): void {
  cachedWorkspaces = workspaces;
  cachedAt = Date.now();
}

export async function listWorkspacesCached(
  options: { readonly force?: boolean } = {},
): Promise<readonly Workspace[]> {
  if (!options.force && cacheIsFresh()) {
    return cachedWorkspaces ?? [];
  }
  if (!options.force && inflight) {
    return inflight;
  }

  inflight = listWorkspaces()
    .then((workspaces) => {
      cachedWorkspaces = workspaces;
      cachedAt = Date.now();
      return workspaces;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}
