/**
 * Dashboard read projections.
 *
 * This route is deliberately a read-only dashboard projection, not a new
 * control-plane mutation surface. It batches the data needed by the everyday
 * installed-Capsule/service-list views so the SPA does not open a waterfall of
 * authenticated `/api/v1/*` requests on first paint. Runtime launcher surfaces
 * remain authoritative Interface/InterfaceBinding reads and are deliberately
 * not synthesized into this projection.
 */
import type { Workspace } from "takosumi-contract/workspaces";
import type {
  Capsule,
  InstallConfig,
  PublicCapsule,
  PublicInstallConfig,
} from "takosumi-contract/install-configs";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { PublicStateVersion } from "takosumi-contract/state-versions";
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
  type ControlSession,
  publicCapsule,
  publicStateVersion,
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
const DASHBOARD_NOTIFICATION_WORKSPACE_LIMIT = 12;
const DASHBOARD_NOTIFICATION_FEED_LIMIT = 60;
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
      dashboardBootstrap(ctx.operations, ctx.store, ctx.session, ctx.url),
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
      dashboardOverview(ctx.operations, ctx.store, ctx.session, ctx.url),
    );
    return appendServerTiming(response, timings);
  }
  return undefined;
}

async function dashboardBootstrap(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  url: URL,
): Promise<Response> {
  const sessionSubject = session.subject;
  const includeWorkspaces =
    url.searchParams.get("includeWorkspaces") !== "false";
  const includeNotifications =
    url.searchParams.get("includeNotifications") === "true";
  const selectedWorkspaceId = stringValue(
    url.searchParams.get("workspaceId") ?? undefined,
  );
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
  const workspaceList =
    includeWorkspaces || includeNotifications
      ? await listActiveWorkspaceProjectionForSession(
          operations,
          store,
          sessionSubject,
          {
            limit: workspaceLimit,
            ensureWorkspaceId: selectedWorkspaceId,
          },
        )
      : undefined;
  const notifications =
    includeNotifications && workspaceList
      ? await listDashboardNotifications(
          operations,
          workspaceList.workspaces,
          selectedWorkspaceId,
        )
      : undefined;
  return json(
    {
      session: { subject: sessionSubject },
      ...(includeWorkspaces && workspaceList
        ? {
            workspaces: workspaceList.workspaces,
            workspaceList: workspaceList.meta,
          }
        : {}),
      ...(notifications ? { notifications } : {}),
    } satisfies DashboardBootstrapResponse,
    200,
    { "cache-control": "no-store" },
  );
}

async function dashboardOverview(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  url: URL,
): Promise<Response> {
  const sessionSubject = session.subject;
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
    (await operations.workspaces.getWorkspace(selectedWorkspaceId));
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
    session,
    workspaceId: selectedWorkspace.id,
    workspace: selectedWorkspace,
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
    operations.capsules.listCapsulesPage(selectedWorkspace.id, {
      limit: capsuleLimit,
      includeDestroyed: false,
    }),
    optionalDashboardProjection(
      operations.activity.list(selectedWorkspace.id, activityLimit),
      [],
    ),
    optionalDashboardProjection(
      listDashboardInstallConfigCandidates(
        operations,
        selectedWorkspace.id,
        installConfigLimit,
      ),
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
    activity: activity.map((event) => compactDashboardActivityEvent(event)),
    installConfigs: visibleInstallConfigs,
    ...(capsulePage.nextCursor !== undefined
      ? { nextCapsuleCursor: capsulePage.nextCursor }
      : {}),
  } satisfies DashboardOverviewResponse);
}

async function optionalDashboardProjection<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs = DASHBOARD_OPTIONAL_PROJECTION_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(
          () => {
            resolve(fallback);
          },
          Math.max(0, timeoutMs),
        );
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
  readonly currentStateVersions: readonly PublicStateVersion[];
  readonly activity: readonly ActivityEvent[];
  readonly installConfigs: readonly PublicInstallConfig[];
  readonly nextCapsuleCursor?: string;
}

interface DashboardBootstrapResponse {
  readonly session: { readonly subject: string };
  readonly workspaces?: readonly Workspace[];
  readonly workspaceList?: DashboardWorkspaceListMeta;
  readonly notifications?: readonly DashboardNotificationFeedEntry[];
}

interface DashboardNotificationFeedEntry {
  readonly event: ActivityEvent;
  readonly workspaceHandle: string;
}

async function listDashboardNotifications(
  operations: ControlPlaneOperations,
  workspaces: readonly Workspace[],
  selectedWorkspaceId: string | undefined,
): Promise<readonly DashboardNotificationFeedEntry[]> {
  const recent = workspaces.slice(0, DASHBOARD_NOTIFICATION_WORKSPACE_LIMIT);
  const selected = selectedWorkspaceId
    ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
    : undefined;
  const candidates = selected
    ? [
        selected,
        ...recent.filter((workspace) => workspace.id !== selected.id),
      ].slice(0, DASHBOARD_NOTIFICATION_WORKSPACE_LIMIT)
    : recent;
  if (candidates.length === 0) return [];
  const handles = new Map(
    candidates.map((workspace) => [workspace.id, workspace.handle]),
  );
  const deadline = Date.now() + DASHBOARD_OPTIONAL_PROJECTION_TIMEOUT_MS;
  const events = await optionalDashboardProjection(
    operations.activity.listAcrossWorkspaces(
      candidates.map((workspace) => workspace.id),
      DASHBOARD_NOTIFICATION_FEED_LIMIT,
    ),
    [],
    remainingDashboardProjectionMs(deadline),
  );
  if (events.length === 0) return [];
  const capsuleIds = [
    ...new Set(
      events
        .map(dashboardActivityCapsuleId)
        .filter((id): id is string => id !== undefined),
    ),
  ];
  const remainingMs = remainingDashboardProjectionMs(deadline);
  const capsules =
    capsuleIds.length === 0 || remainingMs === 0
      ? []
      : await optionalDashboardProjection(
          operations.capsules.getCapsulesByIds(capsuleIds),
          [],
          remainingMs,
        );
  const capsulesById = new Map(
    capsules.map((capsule) => [capsule.id, capsule] as const),
  );
  return events.map((event) => ({
    event: compactDashboardActivityEvent(
      event,
      dashboardActivityCapsuleName(event, capsulesById),
    ),
    workspaceHandle: handles.get(event.workspaceId) ?? event.workspaceId,
  }));
}

function remainingDashboardProjectionMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function dashboardActivityCapsuleId(event: ActivityEvent): string | undefined {
  const value = event.metadata.capsuleId;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return event.targetType === "capsule" && event.targetId.trim().length > 0
    ? event.targetId.trim()
    : undefined;
}

function dashboardActivityCapsuleName(
  event: ActivityEvent,
  capsulesById: ReadonlyMap<string, Capsule>,
): string | undefined {
  const recordedName = event.metadata.capsuleName;
  if (typeof recordedName === "string" && recordedName.trim().length > 0) {
    return recordedName;
  }
  const capsuleId = dashboardActivityCapsuleId(event);
  if (!capsuleId) return undefined;
  const capsule = capsulesById.get(capsuleId);
  return capsule?.workspaceId === event.workspaceId ? capsule.name : undefined;
}

function compactDashboardActivityEvent(
  event: ActivityEvent,
  capsuleName?: string,
): ActivityEvent {
  return {
    ...event,
    metadata: {
      ...compactDashboardActivityMetadata(event.metadata),
      ...(capsuleName ? { capsuleName } : {}),
    },
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
  "capsuleName",
  "name",
  "environment",
  "provider",
  "outputCount",
  "stateVersionId",
  "applyRunId",
  "operation",
  "phase",
  "policyStatus",
  "errorCode",
  "producerCapsuleName",
  "changedOutputs",
  "reasons",
] as const;

interface DashboardWorkspaceListMeta {
  readonly total?: number;
  readonly returned: number;
  readonly limit: number;
  readonly truncated: boolean;
}

async function listActiveWorkspaceProjectionForSession(
  operations: ControlPlaneOperations,
  _store: AccountsStore,
  sessionSubject: string,
  options: {
    readonly limit: number;
    readonly ensureWorkspaceId?: string;
  },
): Promise<{
  readonly workspaces: readonly Workspace[];
  readonly meta: DashboardWorkspaceListMeta;
}> {
  const workspaces: Workspace[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  do {
    const page = await operations.workspaces.listWorkspacesForAccountPage(
      sessionSubject,
      {
        includeArchived: false,
        includeTotal: false,
        order: "updated_desc",
        limit: options.limit - workspaces.length,
        ...(cursor ? { cursor } : {}),
      },
    );
    total = page.total;
    workspaces.push(...page.items);
    cursor = page.nextCursor;
  } while (workspaces.length < options.limit && cursor !== undefined);

  let limited = workspaces.slice(0, options.limit);
  if (
    options.ensureWorkspaceId !== undefined &&
    !limited.some((workspace) => workspace.id === options.ensureWorkspaceId)
  ) {
    const selected = await operations.workspaces.getWorkspaceForAccount(
      sessionSubject,
      options.ensureWorkspaceId,
    );
    if (selected && !isArchivedWorkspace(selected)) {
      limited = [
        selected,
        ...limited.filter((workspace) => workspace.id !== selected.id),
      ].slice(0, options.limit);
    }
  }
  return {
    workspaces: limited,
    meta: workspaceListMeta(
      limited,
      total,
      options.limit,
      cursor !== undefined,
    ),
  };
}

function workspaceListMeta(
  workspaces: readonly Workspace[],
  total: number | undefined,
  limit: number,
  hasMore = false,
): DashboardWorkspaceListMeta {
  return {
    ...(total === undefined ? {} : { total }),
    returned: workspaces.length,
    limit,
    truncated: hasMore || (total !== undefined && total > workspaces.length),
  };
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
): Promise<readonly PublicStateVersion[]> {
  const ids = capsules
    .map(capsuleCurrentStateVersionId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return [];
  const rows = operations.listStateVersionsByIds
    ? await operations.listStateVersionsByIds(ids)
    : operations.listStateVersionsByWorkspace
      ? (await operations.listStateVersionsByWorkspace(workspaceId)).filter(
          (row) => ids.includes(row.id),
        )
      : await Promise.all(
          ids.map(
            async (id) => (await operations.getStateVersion(id)).stateVersion,
          ),
        );
  const byId = new Map(rows.map((row) => [row.id, publicStateVersion(row)]));
  return capsules
    .map((capsule) => {
      const id = capsuleCurrentStateVersionId(capsule);
      return id ? byId.get(id) : undefined;
    })
    .filter((row): row is PublicStateVersion => row !== undefined);
}

function capsuleCurrentStateVersionId(capsule: Capsule): string | undefined {
  return capsule.currentStateVersionId;
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

  const missingIds = referencedIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    try {
      const configs = operations.capsules.getInstallConfigsByIds
        ? await operations.capsules.getInstallConfigsByIds(missingIds)
        : await Promise.all(
            missingIds.map((id) => operations.capsules.getInstallConfig(id)),
          );
      for (const config of configs) {
        append(config, { referenced: true });
      }
    } catch {
      // A stale Capsule row can point at a retired or deleted config. The
      // installed-service list can still show the Capsule from its own record;
      // do not fail the whole overview projection for missing Store
      // presentation metadata. This never creates a runtime launcher surface.
    }
  }

  return result.map(publicInstallConfig);
}

async function listDashboardInstallConfigCandidates(
  operations: ControlPlaneOperations,
  workspaceId: string,
  limit: number,
): Promise<readonly InstallConfig[]> {
  const listUnionPage = operations.capsules.listInstallConfigUnionPage;
  if (listUnionPage) {
    return collectInstallConfigScope(limit, (params) =>
      listUnionPage.call(operations.capsules, workspaceId, params, {
        includeInternal: true,
      }),
    );
  }
  const listSharedPage = operations.capsules.listSharedInstallConfigsPage;
  const listScopedPage = operations.capsules.listInstallConfigsPage;
  if (!listSharedPage || !listScopedPage) {
    const [shared, scoped] = await Promise.all([
      operations.capsules.listSharedInstallConfigs({ includeInternal: true }),
      operations.capsules.listInstallConfigs(workspaceId, {
        includeInternal: true,
      }),
    ]);
    return [...shared, ...scoped].sort(compareInstallConfigs);
  }
  const [shared, scoped] = await Promise.all([
    collectInstallConfigScope(limit, (params) =>
      listSharedPage.call(operations.capsules, params, {
        includeInternal: true,
      }),
    ),
    collectInstallConfigScope(limit, (params) =>
      listScopedPage.call(operations.capsules, workspaceId, params, {
        includeInternal: true,
      }),
    ),
  ]);
  return [...shared, ...scoped].sort(compareInstallConfigs);
}

async function collectInstallConfigScope(
  limit: number,
  load: (params: {
    readonly limit: number;
    readonly cursor?: string;
  }) => Promise<{
    readonly items: readonly InstallConfig[];
    readonly nextCursor?: string;
  }>,
): Promise<readonly InstallConfig[]> {
  const rows: InstallConfig[] = [];
  let cursor: string | undefined;
  do {
    const page = await load({
      limit: limit - rows.length,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (rows.length < limit && cursor !== undefined);
  return rows;
}

function compareInstallConfigs(a: InstallConfig, b: InstallConfig): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function isDashboardInstallConfigVisible(
  config: InstallConfig,
  options: { readonly referenced: boolean },
): boolean {
  if (isSelectableInstallConfig(config)) return true;
  return options.referenced && config.store?.surface === "service";
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
