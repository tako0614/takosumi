/**
 * Dashboard read projections.
 *
 * This route is deliberately a read-only dashboard projection, not a new
 * control-plane mutation surface. It batches the data needed by the everyday
 * launcher/service-list views so the SPA does not open a waterfall of
 * authenticated `/api/v1/*` requests on first paint.
 */
import type { Workspace } from "takosumi-contract/workspaces";
import type {
  Capsule,
  InstallConfig,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { PublicDeployment } from "takosumi-contract/deployments";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "../store.ts";
import type { ControlPlaneOperations } from "../control-operations.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  stringValue,
} from "../http-helpers.ts";
import {
  type ControlDispatchContext,
  publicCapsule,
  publicDeployment,
  requireWorkspaceAccess,
} from "./shared.ts";
import {
  appendServerTiming,
  measureServerTiming,
  serverTimingBucketForPath,
} from "../server-timing.ts";

const DEFAULT_CAPSULE_LIMIT = 100;
const DEFAULT_ACTIVITY_LIMIT = 50;
const DEFAULT_INSTALL_CONFIG_LIMIT = 200;

export async function handleDashboard(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (
    segments.length === 2 &&
    segments[0] === "dashboard" &&
    segments[1] === "bootstrap"
  ) {
    if (method !== "GET") return methodNotAllowed("GET");
    const timings = serverTimingBucketForPath(ctx.url.pathname);
    const response = await measureServerTiming(timings, "tk_dashboard", () =>
      dashboardBootstrap(
        ctx.operations,
        ctx.store,
        ctx.session.subject,
        ctx.url,
      ),
    );
    return appendServerTiming(response, timings);
  }
  if (
    segments.length === 2 &&
    segments[0] === "dashboard" &&
    segments[1] === "overview"
  ) {
    if (method !== "GET") return methodNotAllowed("GET");
    const timings = serverTimingBucketForPath(ctx.url.pathname);
    const response = await measureServerTiming(timings, "tk_dashboard", () =>
      dashboardOverview(
        ctx.operations,
        ctx.store,
        ctx.session.subject,
        ctx.url,
      ),
    );
    return appendServerTiming(response, timings);
  }
  return undefined;
}

async function dashboardBootstrap(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const includeWorkspaces =
    url.searchParams.get("includeWorkspaces") !== "false";
  const workspaces = includeWorkspaces
    ? await listWorkspacesForSession(operations, store, sessionSubject)
    : undefined;
  return json(
    {
      session: { subject: sessionSubject },
      ...(workspaces ? { workspaces } : {}),
    } satisfies DashboardBootstrapResponse,
    200,
    { "cache-control": "no-store" },
  );
}

async function dashboardOverview(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const requestedWorkspaceId = stringValue(
    url.searchParams.get("workspaceId") ?? undefined,
  );
  const includeWorkspaces =
    url.searchParams.get("includeWorkspaces") !== "false" ||
    requestedWorkspaceId === undefined;
  const workspaces = includeWorkspaces
    ? await listWorkspacesForSession(operations, store, sessionSubject)
    : [];
  const selectedWorkspaceId =
    requestedWorkspaceId ??
    workspaces.find((workspace) => !isArchivedWorkspace(workspace))?.id;

  if (!selectedWorkspaceId) {
    return json({
      workspaces,
      workspace: null,
      capsules: [],
      currentStateVersions: [],
      activity: [],
      installConfigs: [],
    } satisfies DashboardOverviewResponse);
  }

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    (await operations.spaces.getWorkspace(selectedWorkspaceId));
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    subject: sessionSubject,
    workspaceId: selectedWorkspace.id,
    space: selectedWorkspace,
  });
  if (!auth.ok) return auth.response;

  const capsuleLimit = parseLimitOrDefault(
    url.searchParams.get("capsuleLimit"),
    DEFAULT_CAPSULE_LIMIT,
  );
  const activityLimit = parseLimitOrDefault(
    url.searchParams.get("activityLimit"),
    DEFAULT_ACTIVITY_LIMIT,
  );
  const installConfigLimit = parseLimitOrDefault(
    url.searchParams.get("installConfigLimit"),
    DEFAULT_INSTALL_CONFIG_LIMIT,
  );
  if (
    capsuleLimit === "invalid" ||
    activityLimit === "invalid" ||
    installConfigLimit === "invalid"
  ) {
    return errorJson(
      "invalid_request",
      "limits must be positive integers",
      400,
    );
  }

  const [capsulePage, activity, installConfigs] = await Promise.all([
    operations.installations.listCapsulesPage(selectedWorkspace.id, {
      limit: capsuleLimit,
      includeDestroyed: false,
    }),
    operations.activity.list(selectedWorkspace.id, activityLimit),
    operations.installations.listInstallConfigs(selectedWorkspace.id),
  ]);
  const capsules = capsulePage.items.map(publicCapsule);
  const currentStateVersions = await listCurrentStateVersions(
    operations,
    selectedWorkspace.id,
    capsulePage.items,
  );

  return json({
    workspaces,
    workspace: selectedWorkspace,
    capsules,
    currentStateVersions,
    activity,
    installConfigs: installConfigs.slice(0, installConfigLimit),
    ...(capsulePage.nextCursor !== undefined
      ? { nextCapsuleCursor: capsulePage.nextCursor }
      : {}),
  } satisfies DashboardOverviewResponse);
}

interface DashboardOverviewResponse {
  readonly workspaces: readonly Workspace[];
  readonly workspace: Workspace | null;
  readonly capsules: readonly PublicCapsule[];
  readonly currentStateVersions: readonly PublicDeployment[];
  readonly activity: readonly ActivityEvent[];
  readonly installConfigs: readonly InstallConfig[];
  readonly nextCapsuleCursor?: string;
}

interface DashboardBootstrapResponse {
  readonly session: { readonly subject: string };
  readonly workspaces?: readonly Workspace[];
}

async function listWorkspacesForSession(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<readonly Workspace[]> {
  const byId = new Map<string, Workspace>();
  for (const workspace of await operations.spaces.listWorkspacesByOwner(
    sessionSubject,
  )) {
    byId.set(workspace.id, workspace);
  }
  const ledgerWorkspaces = await store.listWorkspacesForOwner(
    sessionSubject as TakosumiSubject,
  );
  const missingIds = uniqueMissingWorkspaceIds(
    ledgerWorkspaces.map((workspace) => workspace.workspaceId),
    byId,
  );
  if (missingIds.length > 0 && operations.spaces.listWorkspacesByIds) {
    for (const workspace of await operations.spaces.listWorkspacesByIds(
      missingIds,
    )) {
      byId.set(workspace.id, workspace);
    }
  }
  for (const workspaceId of missingIds) {
    if (byId.has(workspaceId)) continue;
    try {
      byId.set(workspaceId, await operations.spaces.getWorkspace(workspaceId));
    } catch {
      // The account ledger can briefly reference a Workspace before control
      // state catches up. Do not make the whole dashboard fail for that row.
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function uniqueMissingWorkspaceIds(
  ids: readonly string[],
  existing: ReadonlyMap<string, Workspace>,
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) continue;
    if (seen.has(id) || existing.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function isArchivedWorkspace(workspace: Workspace): boolean {
  return (
    typeof workspace.archivedAt === "string" && workspace.archivedAt.length > 0
  );
}

async function listCurrentStateVersions(
  operations: ControlPlaneOperations,
  workspaceId: string,
  capsules: readonly Capsule[],
): Promise<readonly PublicDeployment[]> {
  const ids = capsules
    .map((capsule) => capsule.currentStateVersionId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return [];
  const rows = operations.listDeploymentsByIds
    ? await operations.listDeploymentsByIds(ids)
    : operations.listDeploymentsBySpace
      ? (await operations.listDeploymentsBySpace(workspaceId)).filter((row) =>
          ids.includes(row.id),
        )
      : await Promise.all(ids.map((id) => operations.getDeployment(id)));
  const byId = new Map(rows.map((row) => [row.id, publicDeployment(row)]));
  return capsules
    .map((capsule) =>
      capsule.currentStateVersionId
        ? byId.get(capsule.currentStateVersionId)
        : undefined,
    )
    .filter((row): row is PublicDeployment => row !== undefined);
}

function parseLimitOrDefault(
  raw: string | null,
  fallback: number,
): number | "invalid" {
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return "invalid";
  return Math.min(parsed, 500);
}
