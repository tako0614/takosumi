/** Value-free app identities for Store discovery. */
import { installDisplayName } from "./install-names.ts";
import { hasCredentialQueryParams, installedAppSourceIsMatchable, installedAppSourceUrl, isCanonicalRepositoryDirectoryPath, type InstalledAppSummary, type ListInstalledAppsResponse } from "takosumi-contract";
import { normalizeInstallConfigSourcePath } from "takosumi-contract/install-configs";
import type { Capsule, InstallConfig } from "takosumi-contract";
import type { Source } from "takosumi-contract";
import { json, methodNotAllowed } from "../http-helpers.ts";
import { type ControlDispatchContext } from "./shared.ts";
import { requireAppAccess, sourceCapsuleIds, workspaceAppVisibility } from "./app-authorization.ts";
import { readCapsuleAppSummaries, staleCapsuleAppUpdateAvailable } from "./capsule-app.ts";

function storeState(capsule: { status: string; currentStateVersionId?: string; currentStateGeneration: number }): InstalledAppSummary["state"] {
  if (!capsule.currentStateVersionId && capsule.currentStateGeneration === 0) return "installing";
  if (capsule.status === "uninstalled") return "uninstall_scheduled";
  if (capsule.status === "disabled") return "stopped";
  if (capsule.status === "error") return "needs_attention";
  return "installed";
}

function safeIconUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
        !hasCredentialQueryParams(url.searchParams)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function projectInstalledApp(
  capsule: Capsule,
  config: InstallConfig | undefined,
  source: Source | undefined,
  state: InstalledAppSummary["state"],
): InstalledAppSummary | undefined {
  if (!config || (config.workspaceId && config.workspaceId !== capsule.workspaceId) ||
    (source && source.workspaceId !== capsule.workspaceId) ||
    (!source && (!config.sourceSelector?.url || !config.sourceSelector.path))) return undefined;
  const rawSourcePath = config.sourceSelector?.path ?? source!.defaultPath;
  const rawModulePath = config.modulePath ?? ".";
  if (rawSourcePath.trim().startsWith("/") || rawModulePath.trim().startsWith("/")) return undefined;
  const sourcePath = normalizeInstallConfigSourcePath(rawSourcePath);
  const modulePath = normalizeInstallConfigSourcePath(rawModulePath);
  const path = [sourcePath, modulePath].filter((part) => part !== ".").join("/") || ".";
  if (!isCanonicalRepositoryDirectoryPath(path)) return undefined;
  const sourceUrl = config.sourceSelector?.url ?? source!.url;
  const displaySourceUrl = installedAppSourceUrl(sourceUrl);
  if (!displaySourceUrl) return undefined;
  const iconUrl = safeIconUrl(config.store?.iconUrl);
  const displayName = installDisplayName(capsule.name, config, displaySourceUrl);
  return {
    capsuleId: capsule.id,
    name: capsule.name,
    ...(displayName ? { displayName } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    state,
    installedFrom: {
      url: displaySourceUrl,
      path,
      ...(installedAppSourceIsMatchable(sourceUrl) ? {} : { matchable: false as const }),
    },
  };
}

/** Only used after the account list authorizes these exact Capsules. */
export async function readAccountInstalledApps(
  ctx: ControlDispatchContext,
  capsules: readonly Capsule[],
) {
  const getConfigs = ctx.operations.capsules.getInstallConfigsByIds;
  if (!capsules.length) return { installedApps: [], complete: true };
  if (!getConfigs) return undefined;
  let configs: ReadonlyMap<string, InstallConfig>;
  try {
    configs = new Map((await getConfigs.call(ctx.operations.capsules, [
      ...new Set(capsules.map((capsule) => capsule.installConfigId)),
    ])).map((config) => [config.id, config]));
  } catch {
    // The entire page depends on this read. Report an outage to the caller.
    return undefined;
  }

  const sourceReads = new Map<string, Promise<Source>>();
  const summaries = await readCapsuleAppSummaries(ctx,
    capsules.filter((capsule) => configs.has(capsule.installConfigId)), Date.now(), configs);
  const byId = new Map(summaries.map((summary) => [summary.capsuleId, summary]));
  const rows = await Promise.all(capsules.map(async (capsule) => {
    try {
      const config = configs.get(capsule.installConfigId);
      const summary = byId.get(capsule.id);
      if (!config || !summary) return undefined;
      let source: Source | undefined;
      if (!config.sourceSelector?.url || !config.sourceSelector.path) {
        if (!capsule.sourceId) return undefined;
        let read = sourceReads.get(capsule.sourceId);
        if (!read) {
          read = ctx.operations.getSource(capsule.sourceId).then(({ source }) => source);
          sourceReads.set(capsule.sourceId, read);
        }
        source = await read;
        if (source.id !== capsule.sourceId || source.workspaceId !== capsule.workspaceId) return undefined;
        if (source.ownerCapsuleId !== undefined) {
          if (source.ownerCapsuleId !== capsule.id) return undefined;
        } else {
          // An ownerless Source is shared by every live Capsule built from it.
          const ids = await sourceCapsuleIds(ctx.operations, source);
          if (!ids.includes(capsule.id)) return undefined;
          for (const capsuleId of ids) {
            const access = await requireAppAccess({
              operations: ctx.operations,
              store: ctx.store,
              session: ctx.session,
              workspaceId: capsule.workspaceId,
              capsuleId,
              action: "view",
              ...(ctx.session.requireCurrentMembership ? { allowWorkspaceFallback: false } : {}),
            });
            if (!access.ok) return undefined;
          }
        }
      }
      const app = projectInstalledApp(capsule, config, source, summary.state);
      if (app?.state === "installed" && await staleCapsuleAppUpdateAvailable(ctx.operations, capsule)) {
        return { ...app, updateAvailable: true as const };
      }
      return app;
    } catch {
      return undefined;
    }
  }));
  const installedApps = rows.filter((app) => app !== undefined);
  return { installedApps, complete: installedApps.length === capsules.length };
}

/** The caller has already enforced the ordinary Workspace read boundary. */
export async function handleWorkspaceInstalledApps(
  ctx: ControlDispatchContext,
  workspaceId: string,
  method: string,
): Promise<Response> {
  if (method !== "GET") return methodNotAllowed("GET");
  const capsules = await ctx.operations.capsules.listCapsules(workspaceId);
  const workspaceLive = capsules.filter((capsule) => capsule.workspaceId === workspaceId && capsule.status !== "destroyed");
  // Apps the caller cannot view are omitted (Workspace compat read).
  const visibility = await workspaceAppVisibility({
    operations: ctx.operations, session: ctx.session, capsuleIds: workspaceLive.map((capsule) => capsule.id),
  });
  const live = workspaceLive.filter((capsule) => visibility.allows([capsule.id]));
  const configIds = [...new Set(live.map((capsule) => capsule.installConfigId))];
  // One batch read avoids per-app D1 requests. Missing or unusable configs omit
  // only their own rows and make the summary explicitly incomplete.
  let complete = true;
  let configs: readonly InstallConfig[];
  try {
    configs = await (ctx.operations.capsules.getInstallConfigsByIds
      ? ctx.operations.capsules.getInstallConfigsByIds(configIds)
      : ctx.operations.capsules.listInstallConfigs(workspaceId, { includeInternal: true }));
  } catch {
    // An empty result here would falsely assert that no matching app is installed.
    complete = false;
    configs = [];
  }
  const configsById = new Map(configs.map((config) => [config.id, config]));
  if (live.some((capsule) => !configsById.has(capsule.installConfigId))) complete = false;
  const sourcesById = new Map<string, Source>();
  const neededSources = new Set(live.filter((capsule) => {
    const selector = configsById.get(capsule.installConfigId)?.sourceSelector;
    return configsById.has(capsule.installConfigId) && (!selector?.url || !selector.path);
  }).map((capsule) => capsule.sourceId));
  let sourcesTruncated = false;
  try {
    let cursor: string | undefined;
    // Legacy configs need Source fallback; bound its cost per request. Modern
    // selector-backed installs do not need this read at all.
    for (let pageIndex = 0; pageIndex < 8 && neededSources.size > sourcesById.size; pageIndex += 1) {
      const page = await ctx.operations.listSources(workspaceId, { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const source of page.sources) {
        if (neededSources.has(source.id)) sourcesById.set(source.id, source);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    sourcesTruncated = Boolean(cursor && neededSources.size > sourcesById.size);
  } catch {
    // Keep the rows whose source already resolved; do not start per-app reads.
    if (neededSources.size > sourcesById.size) complete = false;
  }
  if (sourcesTruncated) complete = false;
  const installedApps = live.flatMap((capsule): InstalledAppSummary[] => {
    try {
      const app = projectInstalledApp(
        capsule, configsById.get(capsule.installConfigId), sourcesById.get(capsule.sourceId), storeState(capsule),
      );
      if (app) return [app];
      complete = false;
      return [];
    } catch {
      // One malformed app cannot take away the Store or its Install action.
      complete = false;
      return [];
    }
  });
  return json({ installedApps, complete } satisfies ListInstalledAppsResponse, 200, {
    "cache-control": "no-store",
  });
}
