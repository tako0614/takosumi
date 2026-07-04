import type { Workspace } from "./control-api.ts";

const DASHBOARD_BOOTSTRAP_PATH = "/api/v1/dashboard/bootstrap";
export const DASHBOARD_SESSION_BOOTSTRAP_PATH =
  `${DASHBOARD_BOOTSTRAP_PATH}?includeWorkspaces=true`;

export interface DashboardBootstrapSession {
  readonly subject: string;
  readonly expires_at?: number;
  readonly expiresAt?: number;
  readonly primary_account_id?: string;
  readonly primaryAccountId?: string;
  readonly provider?: string;
  readonly display_name?: string;
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
}

let inflight: Promise<DashboardBootstrapResponse | undefined> | undefined;

export function clearDashboardBootstrapCache(): void {
  inflight = undefined;
}

export function fetchDashboardBootstrap(): Promise<
  DashboardBootstrapResponse | undefined
> {
  if (inflight) return inflight;
  if (typeof fetch === "undefined") return Promise.resolve(undefined);

  inflight = fetch(DASHBOARD_SESSION_BOOTSTRAP_PATH, {
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
      inflight = undefined;
    });
  return inflight;
}
