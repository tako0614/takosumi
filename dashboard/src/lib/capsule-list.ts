import { listCapsules, type Capsule } from "./control-api.ts";
import { clearWorkspaceCache, isFreshCacheEntry } from "./cache.ts";

const CACHE_TTL_MS = 5_000;

type CacheEntry = {
  readonly capsules: readonly Capsule[];
  readonly cachedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<readonly Capsule[]>>();

function cacheKey(
  workspaceId: string,
  options: { readonly includeDestroyed?: boolean },
): string {
  return `${workspaceId}:${options.includeDestroyed === false ? "active" : "all"}`;
}

export function clearCapsuleListCache(workspaceId?: string): void {
  clearWorkspaceCache(cache, inflight, workspaceId);
}

export function primeCapsuleListCache(
  workspaceId: string,
  capsules: readonly Capsule[],
  options: { readonly includeDestroyed?: boolean } = {},
): void {
  cache.set(cacheKey(workspaceId, options), {
    capsules,
    cachedAt: Date.now(),
  });
  emitCapsuleListCacheChanged(workspaceId);
}

function emitCapsuleListCacheChanged(workspaceId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("takosumi:capsules-cache-changed", {
      detail: { workspaceId },
    }),
  );
}

export async function listCapsulesCached(
  workspaceId: string,
  options: {
    readonly includeDestroyed?: boolean;
    readonly force?: boolean;
  } = {},
): Promise<readonly Capsule[]> {
  const key = cacheKey(workspaceId, options);
  const current = cache.get(key);
  if (!options.force && isFreshCacheEntry(current, CACHE_TTL_MS)) {
    return current.capsules;
  }
  const currentInflight = inflight.get(key);
  if (!options.force && currentInflight) return currentInflight;

  const request = listCapsules(workspaceId, {
    includeDestroyed: options.includeDestroyed,
  })
    .then((capsules) => {
      cache.set(key, { capsules, cachedAt: Date.now() });
      emitCapsuleListCacheChanged(workspaceId);
      return capsules;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}
