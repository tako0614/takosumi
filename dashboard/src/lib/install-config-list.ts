import {
  listInstallConfigs,
  TEMPLATE_CATALOG_VIEW,
  type InstallConfig,
  type InstallConfigView,
} from "./control-api.ts";

export { TEMPLATE_CATALOG_VIEW };

const CACHE_TTL_MS = 10_000;

type CacheEntry = {
  readonly installConfigs: readonly InstallConfig[];
  readonly cachedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<readonly InstallConfig[]>>();

function cacheKey(
  workspaceId: string | undefined,
  options: { readonly view?: InstallConfigView },
): string {
  return `${workspaceId ?? ""}:${options.view ?? "all"}`;
}

function fresh(
  entry: CacheEntry | undefined,
  now = Date.now(),
): entry is CacheEntry {
  return entry !== undefined && now - entry.cachedAt < CACHE_TTL_MS;
}

export function clearInstallConfigListCache(workspaceId?: string): void {
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

export function primeInstallConfigListCache(
  workspaceId: string | undefined,
  installConfigs: readonly InstallConfig[],
  options: { readonly view?: InstallConfigView } = {},
): void {
  cache.set(cacheKey(workspaceId, options), {
    installConfigs,
    cachedAt: Date.now(),
  });
}

export async function listInstallConfigsCached(
  workspaceId?: string,
  options: {
    readonly view?: InstallConfigView;
    readonly force?: boolean;
  } = {},
): Promise<readonly InstallConfig[]> {
  const key = cacheKey(workspaceId, options);
  const current = cache.get(key);
  if (!options.force && fresh(current)) return current.installConfigs;
  const currentInflight = inflight.get(key);
  if (!options.force && currentInflight) return currentInflight;

  const request = listInstallConfigs(workspaceId, { view: options.view })
    .then((installConfigs) => {
      cache.set(key, { installConfigs, cachedAt: Date.now() });
      return installConfigs;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}
