import { listWorkspaces, type Workspace } from "./control-api.ts";

const CACHE_TTL_MS = 10_000;

let cachedWorkspaces: readonly Workspace[] | undefined;
let cachedAt = 0;
let inflight: Promise<readonly Workspace[]> | undefined;
let bootstrapInflight: Promise<readonly Workspace[] | undefined> | undefined;

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
  bootstrapInflight = undefined;
}

export function primeWorkspaceListCache(
  workspaces: readonly Workspace[],
): void {
  cachedWorkspaces = workspaces;
  cachedAt = Date.now();
}

export function primeWorkspaceListCacheFromPromise(
  workspaces: Promise<readonly Workspace[] | undefined>,
): void {
  if (cacheIsFresh() || inflight) return;
  const current = workspaces
    .then((value) => {
      if (value === undefined) return undefined;
      primeWorkspaceListCache(value);
      return value;
    })
    .finally(() => {
      if (bootstrapInflight === current) {
        bootstrapInflight = undefined;
      }
    });
  bootstrapInflight = current;
}

function fetchAndCacheWorkspaces(): Promise<readonly Workspace[]> {
  return listWorkspaces().then((workspaces) => {
    primeWorkspaceListCache(workspaces);
    return workspaces;
  });
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

  if (!options.force && bootstrapInflight) {
    inflight = bootstrapInflight
      .then((workspaces) => workspaces ?? fetchAndCacheWorkspaces())
      .catch(() => fetchAndCacheWorkspaces())
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  inflight = fetchAndCacheWorkspaces().finally(() => {
    inflight = undefined;
  });
  return inflight;
}
