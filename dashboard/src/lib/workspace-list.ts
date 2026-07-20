import { listWorkspaces, type Workspace } from "./control-api.ts";
import {
  clearDashboardBootstrapCache,
  fetchDashboardWorkspaceBootstrap,
} from "./dashboard-bootstrap.ts";

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
  clearDashboardBootstrapCache();
}

export function primeWorkspaceListCache(
  workspaces: readonly Workspace[],
): void {
  cachedWorkspaces = workspaces;
  cachedAt = Date.now();
}

function fetchAndCacheWorkspaces(
  selectedWorkspaceId?: string,
): Promise<readonly Workspace[]> {
  return listWorkspaces({ selectedWorkspaceId }).then((workspaces) => {
    primeWorkspaceListCache(workspaces);
    return workspaces;
  });
}

async function fetchBootstrapWorkspaces(
  selectedWorkspaceId?: string,
): Promise<readonly Workspace[] | undefined> {
  const data = await fetchDashboardWorkspaceBootstrap({ selectedWorkspaceId });
  if (!Array.isArray(data?.workspaces)) return undefined;
  primeWorkspaceListCache(data.workspaces);
  return data.workspaces;
}

export async function listWorkspacesCached(
  options: {
    readonly force?: boolean;
    readonly selectedWorkspaceId?: string;
  } = {},
): Promise<readonly Workspace[]> {
  if (!options.force && cacheIsFresh()) {
    return cachedWorkspaces ?? [];
  }
  if (!options.force && inflight) {
    return inflight;
  }

  if (!options.force) {
    inflight = fetchBootstrapWorkspaces(options.selectedWorkspaceId)
      .then(
        (workspaces) =>
          workspaces ?? fetchAndCacheWorkspaces(options.selectedWorkspaceId),
      )
      .catch(() => fetchAndCacheWorkspaces(options.selectedWorkspaceId))
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  inflight = fetchAndCacheWorkspaces(options.selectedWorkspaceId).finally(
    () => {
      inflight = undefined;
    },
  );
  return inflight;
}
