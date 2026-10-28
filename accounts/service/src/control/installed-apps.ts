/** Workspace-authorized, value-free app identities for Store discovery. */
import { installedAppSourceIsMatchable, installedAppSourceUrl, type InstalledAppSummary, type ListInstalledAppsResponse } from "takosumi-contract";
import { normalizeInstallConfigSourcePath } from "takosumi-contract/install-configs";
import { json, methodNotAllowed } from "../http-helpers.ts";
import { type ControlDispatchContext, controlPlaneUnavailable } from "./shared.ts";
import { readCapsuleAppView } from "./capsule-app.ts";

/** The caller has already enforced the ordinary Workspace read boundary. */
export async function handleWorkspaceInstalledApps(
  ctx: ControlDispatchContext,
  workspaceId: string,
  method: string,
): Promise<Response> {
  if (method !== "GET") return methodNotAllowed("GET");
  if (typeof ctx.operations.listCapsuleRunsPage !== "function") {
    return controlPlaneUnavailable();
  }
  const capsules = await ctx.operations.capsules.listCapsules(workspaceId);
  const installedApps: InstalledAppSummary[] = [];
  const now = Date.now();
  for (const capsule of capsules) {
    if (capsule.workspaceId !== workspaceId || capsule.status === "destroyed") continue;
    const [app, config, source] = await Promise.all([
      readCapsuleAppView(ctx, capsule, now),
      ctx.operations.capsules.getInstallConfig(capsule.installConfigId),
      ctx.operations.getSource(capsule.sourceId).then((response) => response.source),
    ]);
    const sourcePath = normalizeInstallConfigSourcePath(config.sourceSelector?.path ?? source.defaultPath);
    const modulePath = normalizeInstallConfigSourcePath(config.modulePath ?? ".");
    const path = [sourcePath, modulePath].filter((part) => part !== ".").join("/") || ".";
    const sourceUrl = config.sourceSelector?.url ?? source.url;
    installedApps.push({
      capsuleId: app.capsuleId,
      name: app.name,
      ...(app.displayName ? { displayName: app.displayName } : {}),
      ...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
      state: app.state,
      primaryAction: app.primaryAction,
      installedFrom: {
        url: installedAppSourceUrl(sourceUrl),
        path,
        ...(installedAppSourceIsMatchable(sourceUrl) ? {} : { matchable: false as const }),
      },
    });
  }
  return json({ installedApps } satisfies ListInstalledAppsResponse, 200, {
    "cache-control": "no-store",
  });
}
