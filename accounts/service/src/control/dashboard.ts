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
  PublicInstallConfig,
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
import {
  isSelectableInstallConfig,
  publicInstallConfig,
} from "./install-configs.ts";

const DEFAULT_CAPSULE_LIMIT = 100;
const DEFAULT_ACTIVITY_LIMIT = 50;
const DEFAULT_INSTALL_CONFIG_LIMIT = 200;
const DEFAULT_WORKSPACE_BOOTSTRAP_LIMIT = 50;
const DASHBOARD_OPTIONAL_PROJECTION_TIMEOUT_MS = 1_200;

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
  const workspaceLimit = parseLimitOrDefault(
    url.searchParams.get("workspaceLimit"),
    DEFAULT_WORKSPACE_BOOTSTRAP_LIMIT,
  );
  if (workspaceLimit === "invalid") {
    return errorJson(
      "invalid_request",
      "workspaceLimit must be a positive integer",
      400,
    );
  }
  const workspaceList = includeWorkspaces
    ? await listActiveWorkspaceProjectionForSession(
        operations,
        store,
        sessionSubject,
        {
          limit: workspaceLimit,
          ensureWorkspaceId: stringValue(
            url.searchParams.get("workspaceId") ?? undefined,
          ),
        },
      )
    : undefined;
  return json(
    {
      session: { subject: sessionSubject },
      ...(workspaceList
        ? {
            workspaces: workspaceList.workspaces,
            workspaceList: workspaceList.meta,
          }
        : {}),
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
  const workspaceLimit = parseLimitOrDefault(
    url.searchParams.get("workspaceLimit"),
    DEFAULT_WORKSPACE_BOOTSTRAP_LIMIT,
  );
  if (workspaceLimit === "invalid") {
    return errorJson(
      "invalid_request",
      "workspaceLimit must be a positive integer",
      400,
    );
  }
  const workspaceList = includeWorkspaces
    ? await listActiveWorkspaceProjectionForSession(
        operations,
        store,
        sessionSubject,
        {
          limit: workspaceLimit,
          ensureWorkspaceId: requestedWorkspaceId,
        },
      )
    : { workspaces: [], meta: workspaceListMeta([], 0, workspaceLimit) };
  const workspaces = workspaceList.workspaces;
  const selectedWorkspaceId =
    requestedWorkspaceId ??
    workspaces.find((workspace) => !isArchivedWorkspace(workspace))?.id;

  if (!selectedWorkspaceId) {
    return json({
      workspaces,
      workspaceList: workspaceList.meta,
      workspace: null,
      capsules: [],
      currentStateVersions: [],
      activity: [],
      installConfigs: [],
    } satisfies DashboardOverviewResponse);
  }

  let selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    (await operations.spaces.getWorkspace(selectedWorkspaceId));
  if (isArchivedWorkspace(selectedWorkspace)) {
    const fallbackWorkspaces =
      workspaces.length > 0
        ? workspaces
        : (
            await listActiveWorkspaceProjectionForSession(
              operations,
              store,
              sessionSubject,
              {
                limit: workspaceLimit,
              },
            )
          ).workspaces;
    const fallback = fallbackWorkspaces.find(
      (workspace) => !isArchivedWorkspace(workspace),
    );
    if (!fallback) {
      return json({
        workspaces,
        workspaceList: workspaceList.meta,
        workspace: null,
        capsules: [],
        currentStateVersions: [],
        activity: [],
        installConfigs: [],
      } satisfies DashboardOverviewResponse);
    }
    selectedWorkspace = fallback;
  }
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
    optionalDashboardProjection(
      operations.activity.list(selectedWorkspace.id, activityLimit),
      [],
    ),
    optionalDashboardProjection(
      operations.installations.listInstallConfigs(selectedWorkspace.id),
      [],
    ),
  ]);
  const capsules = capsulePage.items.map(publicCapsule);
  const currentStateVersions = await optionalDashboardProjection(
    listCurrentStateVersions(
      operations,
      selectedWorkspace.id,
      capsulePage.items,
    ),
    [],
  );
  const visibleInstallConfigs = await optionalDashboardProjection(
    listDashboardInstallConfigs(
      operations,
      installConfigs,
      capsulePage.items,
      installConfigLimit,
    ),
    [],
  );

  return json({
    workspaces,
    workspaceList: workspaceList.meta,
    workspace: selectedWorkspace,
    capsules,
    currentStateVersions,
    activity: activity.map(compactDashboardActivityEvent),
    installConfigs: visibleInstallConfigs,
    ...(capsulePage.nextCursor !== undefined
      ? { nextCapsuleCursor: capsulePage.nextCursor }
      : {}),
  } satisfies DashboardOverviewResponse);
}

async function optionalDashboardProjection<T>(
  promise: Promise<T>,
  fallback: T,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => {
          resolve(fallback);
        }, DASHBOARD_OPTIONAL_PROJECTION_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface DashboardOverviewResponse {
  readonly workspaces: readonly Workspace[];
  readonly workspaceList: DashboardWorkspaceListMeta;
  readonly workspace: Workspace | null;
  readonly capsules: readonly PublicCapsule[];
  readonly currentStateVersions: readonly PublicDeployment[];
  readonly activity: readonly ActivityEvent[];
  readonly installConfigs: readonly PublicInstallConfig[];
  readonly nextCapsuleCursor?: string;
}

interface DashboardBootstrapResponse {
  readonly session: { readonly subject: string };
  readonly workspaces?: readonly Workspace[];
  readonly workspaceList?: DashboardWorkspaceListMeta;
}

function compactDashboardActivityEvent(event: ActivityEvent): ActivityEvent {
  return {
    ...event,
    metadata: compactDashboardActivityMetadata(event.metadata),
  };
}

function compactDashboardActivityMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DASHBOARD_ACTIVITY_METADATA_KEYS) {
    const value = metadata[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const DASHBOARD_ACTIVITY_METADATA_KEYS = [
  "capsuleId",
  "installationId",
  "deploymentId",
  "applyRunId",
  "operation",
  "phase",
  "policyStatus",
  "errorCode",
  "producerInstallationName",
  "changedOutputs",
  "reasons",
] as const;

interface DashboardWorkspaceListMeta {
  readonly total: number;
  readonly returned: number;
  readonly limit: number;
  readonly truncated: boolean;
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

async function listActiveWorkspacesForSession(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<readonly Workspace[]> {
  return (
    await listWorkspacesForSession(operations, store, sessionSubject)
  ).filter((workspace) => !isArchivedWorkspace(workspace));
}

async function listActiveWorkspaceProjectionForSession(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  options: {
    readonly limit: number;
    readonly ensureWorkspaceId?: string;
  },
): Promise<{
  readonly workspaces: readonly Workspace[];
  readonly meta: DashboardWorkspaceListMeta;
}> {
  const all = await listActiveWorkspacesForSession(
    operations,
    store,
    sessionSubject,
  );
  const sorted = [...all].sort(compareWorkspaceMostRecentFirst);
  const limited = limitWorkspaces(
    sorted,
    options.limit,
    options.ensureWorkspaceId,
  );
  return {
    workspaces: limited,
    meta: workspaceListMeta(limited, all.length, options.limit),
  };
}

function limitWorkspaces(
  workspaces: readonly Workspace[],
  limit: number,
  ensureWorkspaceId?: string,
): readonly Workspace[] {
  const limited = workspaces.slice(0, limit);
  if (
    ensureWorkspaceId === undefined ||
    limited.some((workspace) => workspace.id === ensureWorkspaceId)
  ) {
    return limited;
  }
  const selected = workspaces.find(
    (workspace) => workspace.id === ensureWorkspaceId,
  );
  if (!selected) return limited;
  return [
    selected,
    ...limited.filter((workspace) => workspace.id !== selected.id),
  ].slice(0, limit);
}

function workspaceListMeta(
  workspaces: readonly Workspace[],
  total: number,
  limit: number,
): DashboardWorkspaceListMeta {
  return {
    total,
    returned: workspaces.length,
    limit,
    truncated: total > workspaces.length,
  };
}

function compareWorkspaceMostRecentFirst(a: Workspace, b: Workspace): number {
  const aTime = a.updatedAt || a.createdAt;
  const bTime = b.updatedAt || b.createdAt;
  return bTime.localeCompare(aTime) || a.id.localeCompare(b.id);
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
    .map(capsuleCurrentStateVersionId)
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
    .map((capsule) => {
      const id = capsuleCurrentStateVersionId(capsule);
      return id ? byId.get(id) : undefined;
    })
    .filter((row): row is PublicDeployment => row !== undefined);
}

function capsuleCurrentStateVersionId(capsule: Capsule): string | undefined {
  return capsule.currentStateVersionId ?? capsule.currentDeploymentId;
}

async function listDashboardInstallConfigs(
  operations: ControlPlaneOperations,
  listedConfigs: readonly InstallConfig[],
  capsules: readonly Capsule[],
  limit: number,
): Promise<readonly PublicInstallConfig[]> {
  const referencedIds = orderedReferencedInstallConfigIds(capsules);
  const referencedIdSet = new Set(referencedIds);
  const byId = new Map<string, InstallConfig>();
  const result: InstallConfig[] = [];
  let listedCount = 0;

  const append = (
    config: InstallConfig,
    options: { readonly referenced: boolean },
  ): void => {
    if (byId.has(config.id)) return;
    if (!isDashboardInstallConfigVisible(config, options)) return;
    byId.set(config.id, config);
    result.push(config);
  };

  for (const config of listedConfigs) {
    if (listedCount < limit) {
      append(config, { referenced: referencedIdSet.has(config.id) });
      listedCount += 1;
      continue;
    }
    if (referencedIdSet.has(config.id)) {
      append(config, { referenced: true });
    }
  }

  for (const id of referencedIds) {
    if (byId.has(id)) continue;
    try {
      append(await operations.installations.getInstallConfig(id), {
        referenced: true,
      });
    } catch {
      // A stale Capsule row can point at a retired or deleted config. The
      // launcher can still show the Capsule from its own record; do not fail
      // the whole overview projection for missing presentation metadata.
    }
  }

  return result.map(publicInstallConfig);
}

function isDashboardInstallConfigVisible(
  config: InstallConfig,
  options: { readonly referenced: boolean },
): boolean {
  if (isSelectableInstallConfig(config)) return true;
  return options.referenced && config.catalog?.surface === "service";
}

function orderedReferencedInstallConfigIds(
  capsules: readonly Capsule[],
): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const capsule of capsules) {
    const id = capsule.installConfigId;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
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
