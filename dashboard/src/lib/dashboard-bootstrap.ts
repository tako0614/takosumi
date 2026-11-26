import type { ActivityEvent, Workspace } from "./control-api.ts";
import {
  TAKOSUMI_SHARED_DASHBOARD_SESSION_PATH,
  TAKOSUMI_SHARED_DASHBOARD_SESSION_PROOF_HEADER,
} from "takosumi-contract";
import {
  canReuseRecentSharedAuthProbe,
  invalidateRecentSharedAuthProbe,
  preflightSharedAuthSession,
  requireSharedAuthReadResponse,
  SHARED_AUTH_READ_HEADER,
  type InitialSharedAuthHealthTicket,
} from "./shared-auth-session-preflight.ts";

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
  readonly notifications?: readonly {
    readonly event: ActivityEvent;
    readonly workspaceHandle: string;
  }[];
}

export type DashboardBootstrapFailureKind = "maintenance" | "error";

/**
 * A non-authentication failure from the dashboard bootstrap route.
 *
 * The old client collapsed every non-2xx response into `undefined`, which made
 * a schema-maintenance 503 indistinguishable from an expired cookie. Keep the
 * response metadata at this transport seam so the session boundary can make a
 * deliberate auth/maintenance decision without losing the operator's headers
 * or error envelope.
 */
export class DashboardBootstrapError extends Error {
  constructor(
    readonly kind: DashboardBootstrapFailureKind,
    readonly status: number,
    readonly statusText: string,
    readonly headers: Headers,
    readonly body: unknown,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DashboardBootstrapError";
  }
}

/** Return undefined only for the reserved route's older-Worker 404. */
export async function fetchInitialSharedDashboardBootstrap(): Promise<
  { readonly authenticated: true; readonly subject: string } | { readonly authenticated: false } | undefined
> {
  const response = await fetch(TAKOSUMI_SHARED_DASHBOARD_SESSION_PATH, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(40_000),
  });
  const marked = response.headers.get(TAKOSUMI_SHARED_DASHBOARD_SESSION_PROOF_HEADER) === "1";
  const json = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  const body = await readResponseBody(response);
  if (!marked && response.status === 404 && json && body &&
    typeof body === "object" && Object.keys(body).length === 1 &&
    "error" in body && body.error === "not found") return undefined;
  if (marked && json && response.status === 401) return { authenticated: false };
  if (marked && json && response.status === 200 && body && typeof body === "object" && "session" in body) {
    const session = body.session;
    if (session && typeof session === "object" && "subject" in session &&
      typeof session.subject === "string" && session.subject.length > 0) {
      return { authenticated: true, subject: session.subject };
    }
  }
  throw dashboardBootstrapFailure(response, body);
}

function dashboardBootstrapFailure(response: Response, body: unknown): DashboardBootstrapError {
  const error = dashboardResponseErrorDetails(body, response.status, response.statusText);
  return new DashboardBootstrapError(
    dashboardFailureKind(response.status, response.headers, body, error.code),
    response.status,
    response.statusText,
    new Headers(response.headers),
    body,
    error.message,
    error.code,
  );
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
  readonly includeNotifications?: boolean;
  readonly selectedWorkspaceId?: string;
  readonly initialHealthTicket?: InitialSharedAuthHealthTicket;
}): Promise<DashboardBootstrapResponse | undefined>;
export function fetchDashboardBootstrap(
  options: {
    readonly includeWorkspaces?: boolean;
    readonly includeNotifications?: boolean;
    readonly selectedWorkspaceId?: string;
    readonly initialHealthTicket?: InitialSharedAuthHealthTicket;
  } = {},
): Promise<DashboardBootstrapResponse | undefined> {
  const path =
    options.includeWorkspaces === true
      ? dashboardWorkspaceBootstrapPath(
          options.selectedWorkspaceId,
          options.includeNotifications === true,
        )
      : dashboardSessionBootstrapPath(options);
  const current = inflight.get(path);
  if (current) return current;
  if (typeof fetch === "undefined") return Promise.resolve(undefined);

  const reusedProbe = !options.initialHealthTicket &&
    options.includeWorkspaces !== true && canReuseRecentSharedAuthProbe();
  let preflight: Promise<void> | undefined;
  try {
    if (!reusedProbe) {
      preflight = preflightSharedAuthSession(undefined, options.initialHealthTicket);
    }
  } catch (error) {
    return Promise.reject(error);
  }
  const send = () =>
    fetch(path, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(reusedProbe ? { [SHARED_AUTH_READ_HEADER]: "1" } : {}),
      },
      credentials: "include",
      ...(reusedProbe ? { cache: "no-store" } : {}),
    });
  const request = (preflight ? preflight.then(send) : send())
    .then(async (res): Promise<DashboardBootstrapResponse | undefined> => {
      if (reusedProbe) requireSharedAuthReadResponse(res);
      if (res.status === 401 && inflight.get(path) === request) {
        invalidateRecentSharedAuthProbe();
      }
      if (res.status === 401 || res.status === 404) return undefined;
      if (!res.ok) {
        throw dashboardBootstrapFailure(res, await readResponseBody(res));
      }
      return (await res.json()) as DashboardBootstrapResponse;
    })
    .finally(() => {
      if (inflight.get(path) === request) inflight.delete(path);
    });
  inflight.set(path, request);
  return request;
}

export function dashboardFailureKind(
  status: number,
  headers: Headers,
  body: unknown,
  code?: string,
): DashboardBootstrapFailureKind {
  if (status !== 503) return "error";
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const nestedError =
    typeof record?.error === "object" &&
    record.error !== null &&
    !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  return headers.get("x-takosumi-maintenance") === "d1-blue-green" ||
    code === "schema_maintenance" ||
    record?.error === "schema_maintenance" ||
    nestedError?.code === "schema_maintenance"
    ? "maintenance"
    : "error";
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function dashboardResponseErrorDetails(
  body: unknown,
  status: number,
  statusText: string,
): { readonly message: string; readonly code?: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { message: `${status} ${statusText}`.trim() };
  }
  const record = body as Record<string, unknown>;
  const envelope =
    typeof record.error === "object" &&
    record.error !== null &&
    !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : record;
  const message =
    typeof envelope.message === "string"
      ? envelope.message
      : typeof record.error_description === "string"
        ? record.error_description
        : typeof record.error === "string"
          ? record.error
          : `${status} ${statusText}`.trim();
  const code = typeof envelope.code === "string" ? envelope.code : undefined;
  return { message, ...(code ? { code } : {}) };
}

function dashboardSessionBootstrapPath(options: {
  readonly includeNotifications?: boolean;
  readonly selectedWorkspaceId?: string;
}): string {
  if (!options.includeNotifications) return DASHBOARD_SESSION_BOOTSTRAP_PATH;
  const params = new URLSearchParams({
    includeWorkspaces: "false",
    includeNotifications: "true",
  });
  if (options.selectedWorkspaceId) params.set("workspaceId", options.selectedWorkspaceId);
  return `${DASHBOARD_BOOTSTRAP_PATH}?${params.toString()}`;
}

function dashboardWorkspaceBootstrapPath(
  selectedWorkspaceId?: string,
  includeNotifications = false,
): string {
  const params = new URLSearchParams({
    includeWorkspaces: "true",
    workspaceLimit: String(DASHBOARD_WORKSPACE_BOOTSTRAP_LIMIT),
  });
  if (selectedWorkspaceId && selectedWorkspaceId.length > 0) {
    params.set("workspaceId", selectedWorkspaceId);
  }
  if (includeNotifications) params.set("includeNotifications", "true");
  return `${DASHBOARD_BOOTSTRAP_PATH}?${params.toString()}`;
}

export function fetchDashboardWorkspaceBootstrap(): Promise<
  DashboardBootstrapResponse | undefined
>;
export function fetchDashboardWorkspaceBootstrap(options: {
  readonly selectedWorkspaceId?: string;
  readonly includeNotifications?: boolean;
  readonly initialHealthTicket?: InitialSharedAuthHealthTicket;
}): Promise<DashboardBootstrapResponse | undefined>;
export function fetchDashboardWorkspaceBootstrap(
  options: {
    readonly selectedWorkspaceId?: string;
    readonly includeNotifications?: boolean;
    readonly initialHealthTicket?: InitialSharedAuthHealthTicket;
  } = {},
): Promise<DashboardBootstrapResponse | undefined> {
  return fetchDashboardBootstrap({
    includeWorkspaces: true,
    includeNotifications: options.includeNotifications,
    selectedWorkspaceId: options.selectedWorkspaceId,
    initialHealthTicket: options.initialHealthTicket,
  });
}
