import type { Workspace } from "./control-api.ts";

const DASHBOARD_BOOTSTRAP_PATH = "/api/v1/dashboard/bootstrap";
export const DASHBOARD_SESSION_BOOTSTRAP_PATH = `${DASHBOARD_BOOTSTRAP_PATH}?includeWorkspaces=false`;
const DASHBOARD_WORKSPACE_BOOTSTRAP_LIMIT = 50;
export const DASHBOARD_WORKSPACE_BOOTSTRAP_PATH = `${DASHBOARD_BOOTSTRAP_PATH}?includeWorkspaces=true&workspaceLimit=${DASHBOARD_WORKSPACE_BOOTSTRAP_LIMIT}`;

export interface DashboardBootstrapSession {
  readonly subject: string;
  readonly expiresAt?: number;
  readonly primaryAccountId?: string;
  readonly provider?: string;
  readonly displayName?: string;
  readonly email?: string;
}

export interface DashboardBootstrapResponse {
  readonly subject?: string;
  readonly expiresAt?: number;
  readonly primaryAccountId?: string;
  readonly provider?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly session?: DashboardBootstrapSession | null;
  readonly workspaces?: readonly Workspace[];
  readonly workspaceList?: {
    readonly total?: number;
    readonly returned: number;
    readonly limit: number;
    readonly truncated: boolean;
  };
}

const inflight = new Map<
  string,
  Promise<DashboardBootstrapResponse | undefined>
>();

export function clearDashboardBootstrapCache(): void {
  inflight.clear();
}

export function fetchDashboardBootstrap(): Promise<
  DashboardBootstrapResponse | undefined
>;
export function fetchDashboardBootstrap(options: {
  readonly includeWorkspaces?: boolean;
  readonly selectedWorkspaceId?: string;
}): Promise<DashboardBootstrapResponse | undefined>;
export function fetchDashboardBootstrap(
  options: {
    readonly includeWorkspaces?: boolean;
    readonly selectedWorkspaceId?: string;
  } = {},
): Promise<DashboardBootstrapResponse | undefined> {
  const path =
    options.includeWorkspaces === true
      ? dashboardWorkspaceBootstrapPath(options.selectedWorkspaceId)
      : DASHBOARD_SESSION_BOOTSTRAP_PATH;
  const current = inflight.get(path);
  if (current) return current;
  if (typeof fetch === "undefined") return Promise.resolve(undefined);

  const request = fetch(path, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "include",
  })
    .then(async (res): Promise<DashboardBootstrapResponse | undefined> => {
      if (res.status === 401 || res.status === 404) return undefined;
      if (!res.ok) return undefined;
      return (await res.json()) as DashboardBootstrapResponse;
    })
    .finally(() => {
      if (inflight.get(path) === request) inflight.delete(path);
    });
  inflight.set(path, request);
  return request;
}

function dashboardWorkspaceBootstrapPath(selectedWorkspaceId?: string): string {
  const params = new URLSearchParams({
    includeWorkspaces: "true",
    workspaceLimit: String(DASHBOARD_WORKSPACE_BOOTSTRAP_LIMIT),
  });
  if (selectedWorkspaceId && selectedWorkspaceId.length > 0) {
    params.set("workspaceId", selectedWorkspaceId);
  }
  return `${DASHBOARD_BOOTSTRAP_PATH}?${params.toString()}`;
}

export function fetchDashboardWorkspaceBootstrap(): Promise<
  DashboardBootstrapResponse | undefined
>;
export function fetchDashboardWorkspaceBootstrap(options: {
  readonly selectedWorkspaceId?: string;
}): Promise<DashboardBootstrapResponse | undefined>;
export function fetchDashboardWorkspaceBootstrap(
  options: {
    readonly selectedWorkspaceId?: string;
  } = {},
): Promise<DashboardBootstrapResponse | undefined> {
  return fetchDashboardBootstrap({
    includeWorkspaces: true,
    selectedWorkspaceId: options.selectedWorkspaceId,
  });
}
