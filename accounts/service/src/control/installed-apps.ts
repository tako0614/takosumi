/** Workspace-authorized, value-free app identities for Store discovery. */
import { hasCredentialQueryParams, installedAppSourceIsMatchable, installedAppSourceUrl, type InstalledAppSummary, type ListInstalledAppsResponse } from "takosumi-contract";
import { normalizeInstallConfigSourcePath } from "takosumi-contract/install-configs";
import type { InstallConfig } from "takosumi-contract";
import type { Source } from "takosumi-contract";
import { json, methodNotAllowed } from "../http-helpers.ts";
import { type ControlDispatchContext } from "./shared.ts";

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

/** The caller has already enforced the ordinary Workspace read boundary. */
export async function handleWorkspaceInstalledApps(
  ctx: ControlDispatchContext,
  workspaceId: string,
  method: string,
): Promise<Response> {
  if (method !== "GET") return methodNotAllowed("GET");
  const capsules = await ctx.operations.capsules.listCapsules(workspaceId);
  const live = capsules.filter((capsule) => capsule.workspaceId === workspaceId && capsule.status !== "destroyed");
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
      const config = configsById.get(capsule.installConfigId);
      const source = sourcesById.get(capsule.sourceId);
      if (!config || (config.workspaceId && config.workspaceId !== workspaceId) ||
        (source && source.workspaceId !== workspaceId) ||
        (!source && (!config.sourceSelector?.url || !config.sourceSelector.path))) {
        complete = false;
        return [];
      }
      const sourcePath = normalizeInstallConfigSourcePath(config.sourceSelector?.path ?? source!.defaultPath);
      const modulePath = normalizeInstallConfigSourcePath(config.modulePath ?? ".");
      const path = [sourcePath, modulePath].filter((part) => part !== ".").join("/") || ".";
      const sourceUrl = config.sourceSelector?.url ?? source!.url;
      const displaySourceUrl = installedAppSourceUrl(sourceUrl);
      if (!displaySourceUrl) {
        complete = false;
        return [];
      }
      const iconUrl = safeIconUrl(config.store?.iconUrl);
      return [{
        capsuleId: capsule.id,
        name: capsule.name,
        ...(config.store ? { displayName: config.store.name } : {}),
        ...(iconUrl ? { iconUrl } : {}),
        state: storeState(capsule),
        installedFrom: {
          url: displaySourceUrl,
          path,
          ...(installedAppSourceIsMatchable(sourceUrl) ? {} : { matchable: false as const }),
        },
      }];
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
