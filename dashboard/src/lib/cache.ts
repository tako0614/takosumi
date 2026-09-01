export function clearWorkspaceCache<CacheValue, InflightValue>(
  cache: Map<string, CacheValue>,
  inflight: Map<string, InflightValue>,
  workspaceId?: string,
): void {
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

export function isFreshCacheEntry<
  Entry extends { readonly cachedAt: number },
>(
  entry: Entry | undefined,
  ttlMs: number,
  now = Date.now(),
): entry is Entry {
  return entry !== undefined && now - entry.cachedAt < ttlMs;
}
