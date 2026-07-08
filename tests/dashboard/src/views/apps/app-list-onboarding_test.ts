import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(resolve(here, "../../../../../dashboard/src", rel), "utf8");

const appListSource = read("views/apps/AppListView.tsx");
const appViewsCssSource = read("styles/app-views.css");
const installationsUiSource = read("lib/capsules-ui.ts");

describe("AppListView app launcher", () => {
  test("first-run home onboards to add a service", () => {
    expect(appListSource).toContain("function WorkspaceStartPanel");
    expect(appListSource).toContain("visibleCapsules().length > 0");
    expect(appListSource).toContain("listWorkspacesCached");
    expect(appListSource).toContain("selectAvailableWorkspaceId");
    expect(appListSource).toContain("if (chosen !== current)");
    expect(appListSource).toContain("ensureAccessibleWorkspaceSelection");
    expect(appListSource).toContain("clearWorkspaceProjectionCaches");
    expect(appListSource).toContain('href="/new"');
    expect(appListSource).toContain('t("apps.start.optionStore")');
    expect(appListSource).not.toContain('href="/new?mode=link"');
    expect(appListSource).not.toContain('t("apps.start.add")');
  });

  test("apps page is a grid of launchable app surfaces, not every service row", () => {
    // Prefer declared app metadata, but also keep plain OpenTofu apps visible
    // when they expose a launch URL. One service may contribute several tiles.
    expect(installationsUiSource).toContain(
      "export function appSurfacesFromOutputs",
    );
    expect(installationsUiSource).toContain(
      "export function appSurfacesFromDeployment",
    );
    expect(installationsUiSource).toContain("export interface AppSurface");
    expect(installationsUiSource).toContain(
      "export function isVisibleServiceCapsule",
    );
    expect(installationsUiSource).toContain('inst.status !== "destroyed"');
    // Launcher reads surface URLs ungated so the tile opens the app's link.
    expect(appListSource).toContain("appSurfacesFromOutputs");
    expect(appListSource).toContain("getDashboardOverviewCached");
    expect(appListSource).toContain("listCapsulesCached");
    expect(appListSource).toContain("listCurrentStateVersionsCached");
    expect(appListSource).toContain("listInstallConfigsCached");
    expect(appListSource).toContain("overview()?.nextCapsuleCursor");
    expect(appListSource).toContain("mergeById");
    expect(appListSource).toContain("surfacesByCapsule");
    expect(appListSource).toContain("overview()?.currentStateVersions");
    expect(appListSource).not.toMatch(/\bgetDeployment\(/);
    expect(appListSource).toContain("const appTiles = createMemo");
    expect(appListSource).toContain("compareAppTiles");
    expect(appListSource).toContain("appTileLabel");
    expect(appListSource).toContain("return tiles.sort(compareAppTiles)");
    expect(appListSource).toContain(
      "Number(needsAttention(b.inst)) - Number(needsAttention(a.inst))",
    );
    expect(appListSource).toContain("function AppLauncher");
    expect(appListSource).toContain("function AppTileView");
    expect(appListSource).toContain("isVisibleServiceCapsule");
    // Phone-home-screen launcher: an icon grid + a trailing add tile.
    expect(appListSource).toContain('class="av-launcher"');
    expect(appListSource).toContain('class="av-tile"');
    expect(appListSource).toContain('class="av-tile av-tile-add"');
    expect(appListSource).toContain('class="av-tile-manage"');
    expect(appListSource).toContain('class="av-tile-actions"');
    expect(appListSource).toContain('t("apps.manage")');
    // The launcher tile keeps only "manage" — no destructive delete affordance.
    expect(appListSource).not.toContain("av-tile-delete");
    expect(appListSource).toContain("av-tile-name");
    // No admin-console fields on the launcher (those live on /services).
    expect(appListSource).not.toContain("StatusBadge");
    expect(appListSource).not.toContain("PageHeader");
    expect(appListSource).not.toContain("relativeTime");
    expect(appListSource).not.toContain("inst.environment");
    expect(appListSource).not.toContain("av-attention");
    // Old "every service" launcher component names are gone.
    expect(appListSource).not.toContain("function ServiceList");
    expect(appListSource).not.toContain("function ServiceTile");
  });

  test("recovers when the persisted Workspace is no longer accessible", () => {
    expect(appListSource).toContain("overview.error as ControlApiError");
    expect(appListSource).toContain("error.status !== 403");
    expect(appListSource).toContain("error.status !== 404");
    expect(appListSource).toContain("listWorkspacesCached({");
    expect(appListSource).toContain("force: options.force");
    expect(appListSource).toContain(
      "selectedWorkspaceId: current || undefined",
    );
    expect(appListSource).toContain("clearDashboardOverviewCache(id)");
    expect(appListSource).toContain("clearCapsuleListCache(id)");
    expect(appListSource).toContain("clearCurrentStateVersionCache(id)");
    expect(appListSource).toContain("clearInstallConfigListCache(id)");
  });

  test("tile face is image → declared icon → kind glyph; empty points at the service list", () => {
    expect(appListSource).toContain("imageSrc()");
    expect(appListSource).toContain("emojiIcon()");
    expect(appListSource).toContain('class="av-tile-image"');
    expect(appListSource).toContain('class="av-tile-emoji"');
    expect(appListSource).toContain("av-tile-icon-image");
    // No declared app → point at the full service list (and add).
    expect(appListSource).toContain("function AppsEmptyPanel");
    expect(appListSource).toContain('href="/services"');
    expect(appListSource).toContain('href="/new"');
    expect(appListSource).toContain('t("apps.add")');
    expect(appListSource).toContain('t("apps.empty.viewServices")');
  });

  test("keeps empty app copy action-oriented and non-procedural in both locales", () => {
    expect(en).not.toHaveProperty("apps.start.add");
    expect(ja).not.toHaveProperty("apps.start.add");
    expect(en).not.toHaveProperty("apps.staleReason");
    expect(ja).not.toHaveProperty("apps.staleReason");
    expect(en["apps.subtitle"]).not.toContain("manage");
    expect(ja["apps.subtitle"]).not.toContain("管理");
    expect(en["apps.empty.viewServices"]).toBeTruthy();
    expect(ja["apps.empty.viewServices"]).toBeTruthy();
  });

  test("keeps the launcher responsive on mobile", () => {
    expect(appViewsCssSource).toContain(".av-start");
    expect(appViewsCssSource).toContain(".av-launcher");
    expect(appViewsCssSource).toContain(".av-tile");
    expect(appViewsCssSource).toContain(".av-tile-icon");
    expect(appViewsCssSource).toContain(".av-tile-actions");
    expect(appViewsCssSource).toContain(".av-tile-manage");
    expect(appViewsCssSource).toContain(".av-tile-dot");
    expect(appViewsCssSource).toContain(".av-tile-image");
    expect(appViewsCssSource).toContain(".av-tile-emoji");
    expect(appViewsCssSource).not.toContain(".av-service-grid");
    expect(appViewsCssSource).not.toContain(".av-service-card");
  });

  test("opens the surface URL when present, else the service screen", () => {
    expect(appListSource).toContain("function AppTileView");
    expect(appListSource).toContain("when={surface().url}");
    expect(appListSource).toContain("appSurfacesFromOutputs");
    expect(appListSource).toContain('target="_blank"');
    expect(appListSource).toContain("props.openDetail(tile.inst)");
    expect(appListSource).toContain('class="av-tile-manage"');
    // Tapping the icon goes straight to the app's link (declared surface URL).
    expect(appListSource).toContain("href={url()}");
    expect(appListSource).not.toContain("window.open");
    // Needs-attention is a corner dot + screen-reader label, not a status pill.
    expect(appListSource).toContain("av-tile-dot");
    expect(appListSource).toContain('t("apps.needsAttention")');
    expect(appListSource).toContain('class="sr-only"');
  });
});
