import { listCapsules, type Capsule } from "./control-api.ts";

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

function fresh(
  entry: CacheEntry | undefined,
  now = Date.now(),
): entry is CacheEntry {
  return entry !== undefined && now - entry.cachedAt < CACHE_TTL_MS;
}

export function clearCapsuleListCache(workspaceId?: string): void {
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

export function peekCapsulesCached(
  workspaceId: string,
  options: { readonly includeDestroyed?: boolean } = {},
): readonly Capsule[] | undefined {
  const current = cache.get(cacheKey(workspaceId, options));
  return fresh(current) ? current.capsules : undefined;
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
  if (!options.force && fresh(current)) return current.capsules;
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
