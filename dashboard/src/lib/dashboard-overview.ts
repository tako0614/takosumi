import { getDashboardOverview, type DashboardOverview } from "./control-api.ts";
import { primeCapsuleListCache } from "./capsule-list.ts";
import { primeCurrentStateVersionCache } from "./current-state-versions.ts";
import { primeInstallConfigListCache } from "./install-config-list.ts";
import { primeWorkspaceListCache } from "./workspace-list.ts";

const CACHE_TTL_MS = 5_000;

type CacheEntry = {
  readonly overview: DashboardOverview;
  readonly cachedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<DashboardOverview>>();

function cacheKey(workspaceId: string | undefined): string {
  return workspaceId ?? "";
}

function fresh(
  entry: CacheEntry | undefined,
  now = Date.now(),
): entry is CacheEntry {
  return entry !== undefined && now - entry.cachedAt < CACHE_TTL_MS;
}

export function clearDashboardOverviewCache(workspaceId?: string): void {
  if (workspaceId === undefined) {
    cache.clear();
    inflight.clear();
    return;
  }
  const key = cacheKey(workspaceId);
  cache.delete(key);
  inflight.delete(key);
}

export async function getDashboardOverviewCached(
  workspaceId?: string,
  options: { readonly force?: boolean } = {},
): Promise<DashboardOverview> {
  const key = cacheKey(workspaceId);
  const current = cache.get(key);
  if (!options.force && fresh(current)) return current.overview;
  const currentInflight = inflight.get(key);
  if (!options.force && currentInflight) return currentInflight;

  const request = getDashboardOverview(workspaceId, {
    includeWorkspaces: workspaceId === undefined,
  })
    .then((overview) => {
      cache.set(key, { overview, cachedAt: Date.now() });
      primeDerivedCaches(overview);
      return overview;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

function primeDerivedCaches(overview: DashboardOverview): void {
  if (overview.workspaces.length > 0) {
    primeWorkspaceListCache(overview.workspaces);
  }
  const workspaceId = overview.workspace?.id;
  if (!workspaceId) return;
  primeCapsuleListCache(workspaceId, overview.capsules, {
    includeDestroyed: false,
  });
  primeCurrentStateVersionCache(workspaceId, overview.currentStateVersions, {
    includeDestroyed: false,
  });
  primeInstallConfigListCache(workspaceId, overview.installConfigs);
}
