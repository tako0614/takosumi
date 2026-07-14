import {
  listWorkspaceCurrentStateVersions,
  type PublicStateVersion,
} from "./control-api.ts";

const CACHE_TTL_MS = 5_000;

type CacheEntry = {
  readonly stateVersions: readonly PublicStateVersion[];
  readonly cachedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<readonly PublicStateVersion[]>>();

function cacheKey(
  workspaceId: string,
  options: { readonly includeDestroyed?: boolean },
): string {
  return `${workspaceId}:${options.includeDestroyed === false ? "active" : "all"}`;
}

function fresh(
  entry: CacheEntry | undefined,
  now = Date.now(),
): entry is CacheEntry {
  return entry !== undefined && now - entry.cachedAt < CACHE_TTL_MS;
}

export function clearCurrentStateVersionCache(workspaceId?: string): void {
  if (!workspaceId) {
    cache.clear();
    inflight.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) inflight.delete(key);
  }
}

export function primeCurrentStateVersionCache(
  workspaceId: string,
  stateVersions: readonly PublicStateVersion[],
  options: { readonly includeDestroyed?: boolean } = {},
): void {
  cache.set(cacheKey(workspaceId, options), {
    stateVersions,
    cachedAt: Date.now(),
  });
}

export async function listCurrentStateVersionsCached(
  workspaceId: string,
  options: {
    readonly includeDestroyed?: boolean;
    readonly force?: boolean;
  } = {},
): Promise<readonly PublicStateVersion[]> {
  const key = cacheKey(workspaceId, options);
  const current = cache.get(key);
  if (!options.force && fresh(current)) return current.stateVersions;
  const currentInflight = inflight.get(key);
  if (!options.force && currentInflight) return currentInflight;

  const request = listWorkspaceCurrentStateVersions(workspaceId, {
    includeDestroyed: options.includeDestroyed,
  })
    .then((stateVersions) => {
      cache.set(key, { stateVersions, cachedAt: Date.now() });
      return stateVersions;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}
