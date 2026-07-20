import { listWorkspaces, type Workspace } from "./control-api.ts";
import {
  clearDashboardBootstrapCache,
  fetchDashboardWorkspaceBootstrap,
} from "./dashboard-bootstrap.ts";

const CACHE_TTL_MS = 10_000;

let cachedWorkspaces: readonly Workspace[] | undefined;
let cachedAt = 0;
let cacheGeneration = 0;
let requestedScope = "";
const inflight = new Map<string, Promise<readonly Workspace[]>>();

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
  cacheGeneration += 1;
  requestedScope = "";
  inflight.clear();
  clearDashboardBootstrapCache();
}

export function primeWorkspaceListCache(
  workspaces: readonly Workspace[],
): void {
  cachedWorkspaces = workspaces;
  cachedAt = Date.now();
}

function fetchWorkspacePage(
  selectedWorkspaceId?: string,
): Promise<readonly Workspace[]> {
  return listWorkspaces({ selectedWorkspaceId });
}

async function fetchBootstrapWorkspaces(
  selectedWorkspaceId?: string,
): Promise<readonly Workspace[] | undefined> {
  const data = await fetchDashboardWorkspaceBootstrap({ selectedWorkspaceId });
  if (!Array.isArray(data?.workspaces)) return undefined;
  return data.workspaces;
}

function cacheContainsScope(scope: string): boolean {
  return (
    scope.length === 0 ||
    (cachedWorkspaces ?? []).some((workspace) => workspace.id === scope)
  );
}

/** Deduplicates pinned/current rows while retaining the first visible order. */
export function mergeWorkspaceLists(
  ...lists: readonly (readonly Workspace[])[]
): readonly Workspace[] {
  const byId = new Map<string, Workspace>();
  for (const list of lists) {
    for (const workspace of list) {
      if (!byId.has(workspace.id)) byId.set(workspace.id, workspace);
    }
  }
  return [...byId.values()];
}

export async function listWorkspacesCached(
  options: {
    readonly force?: boolean;
    readonly selectedWorkspaceId?: string;
  } = {},
): Promise<readonly Workspace[]> {
  const scope = options.selectedWorkspaceId?.trim() ?? "";
  if (!options.force && cacheIsFresh() && cacheContainsScope(scope)) {
    return cachedWorkspaces ?? [];
  }
  requestedScope = scope;
  const currentInflight = inflight.get(scope);
  if (currentInflight) return currentInflight;
  const generation = cacheGeneration;

  const load = options.force
    ? fetchWorkspacePage(scope || undefined)
    : fetchBootstrapWorkspaces(scope || undefined)
        .then(
          (workspaces) => workspaces ?? fetchWorkspacePage(scope || undefined),
        )
        .catch(() => fetchWorkspacePage(scope || undefined));

  const request = load
    .then((workspaces) => {
      if (cacheGeneration === generation && requestedScope === scope) {
        primeWorkspaceListCache(workspaces);
      }
      return workspaces;
    })
    .finally(() => {
      if (inflight.get(scope) === request) inflight.delete(scope);
    });
  inflight.set(scope, request);
  return request;
}
