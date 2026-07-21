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
    expect(appListSource).toContain("appTiles().length > 0");
    expect(appListSource).toContain("listWorkspacesCached");
    expect(appListSource).toContain("selectAvailableWorkspaceId");
    expect(appListSource).toContain("if (chosen !== current)");
    expect(appListSource).toContain("ensureAccessibleWorkspaceSelection");
    expect(appListSource).toContain("clearWorkspaceProjectionCaches");
    // Add CTAs land on the merged ストア page (browse + add in one place).
    expect(appListSource).toContain('href="/new"');
    expect(appListSource).not.toContain('href="/store"');
    expect(appListSource).toContain('t("apps.start.optionStore")');
    expect(appListSource).not.toContain('href="/new?mode=link"');
    expect(appListSource).not.toContain('t("apps.start.add")');
  });

  test("apps page joins the Capsule ledger to authorized UI-surface Interfaces only", () => {
    expect(installationsUiSource).not.toContain(
      "appSurfaceFromProjectedOutputs",
    );
    expect(installationsUiSource).not.toContain("appSurfacesFromOutputs");
    expect(installationsUiSource).not.toContain("outputs.apps");
    expect(installationsUiSource).not.toContain("outputs.app_name");
    expect(installationsUiSource).not.toContain("outputs.app_icon");
    expect(installationsUiSource).not.toContain("outputs.app_image");
    expect(installationsUiSource).not.toContain("appSurfacesFromDeployment");
    expect(installationsUiSource).toContain("export interface AppSurface");
    expect(installationsUiSource).toContain(
      "export function isVisibleServiceCapsule",
    );
    expect(installationsUiSource).toContain('inst.status !== "destroyed"');
    expect(appListSource).toContain("listAuthorizedUiSurfaces");
    expect(appListSource).toContain("refreshSession");
    expect(appListSource).toContain("session.subject");
    expect(appListSource).toContain("surface.capsuleId");
    expect(appListSource).toContain("surface.interfaceId");
    expect(appListSource).not.toContain("appSurfaceFromInstallConfigStore");
    expect(appListSource).not.toContain("appSurfacesFromDeployment");
    expect(appListSource).toContain("getDashboardOverviewCached");
    expect(appListSource).toContain("listCapsulesCached");
    expect(appListSource).not.toContain("listCurrentStateVersionsCached");
    expect(appListSource).not.toContain("listInstallConfigsCached");
    expect(appListSource).toContain("overview()?.nextCapsuleCursor");
    expect(appListSource).toContain("mergeById");
    expect(appListSource).toContain("surfacesByCapsule");
    expect(appListSource).not.toContain("overview()?.currentStateVersions");
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
    // One authorized Interface becomes one launcher tile.
    expect(appListSource).toContain("if (!surfaces) continue");
    expect(appListSource).not.toContain("key: `${inst.id}:store`");
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
    // Product identity comes from the Interface document; a display name must
    // never select a Takosumi-bundled product icon.
    expect(appListSource).not.toContain("CURATED_APP_ICONS");
    expect(appListSource).not.toContain("curatedAppIcon");
    expect(appListSource).not.toContain("yurucommu");
    expect(appListSource).not.toContain("takos-office");
    expect(appListSource).not.toContain("/tako.png");
    // A Capsule without a UI Interface stays on /services, not in the launcher.
    expect(appListSource).not.toContain("AppsEmptyPanel");
    expect(appListSource).toContain('href="/new"');
    expect(appListSource).not.toContain('href="/store"');
  });

  test("keeps empty app copy action-oriented and non-procedural in both locales", () => {
    expect(en).not.toHaveProperty("apps.start.add");
    expect(ja).not.toHaveProperty("apps.start.add");
    expect(en).not.toHaveProperty("apps.staleReason");
    expect(ja).not.toHaveProperty("apps.staleReason");
  });

  test("keeps the launcher responsive on mobile", () => {
    expect(appViewsCssSource).toContain(".av-start");
    expect(appViewsCssSource).toContain(".av-launcher");
    expect(appViewsCssSource).toContain(".av-tile");
    expect(appViewsCssSource).toContain(".av-tile-icon");
    expect(appViewsCssSource).toContain(".av-tile-actions");
    expect(appViewsCssSource).toContain(".av-tile-manage");
    expect(appViewsCssSource).toContain(".av-tile-dot");
    expect(appViewsCssSource).toContain(".av-tile-state");
    expect(appViewsCssSource).toContain(".av-tile-image");
    expect(appViewsCssSource).toContain(".av-tile-emoji");
    expect(appViewsCssSource).not.toContain(".av-service-grid");
    expect(appViewsCssSource).not.toContain(".av-service-card");
  });

  test("opens the authorized Interface URL and keeps Capsule management separate", () => {
    expect(appListSource).toContain("function AppTileView");
    expect(appListSource).toContain("when={openUrl()}");
    // The resolved, authorized Interface supplies the URL directly.
    expect(appListSource).toContain("listAuthorizedUiSurfaces");
    expect(appListSource).not.toContain("appSurfaceFromInstallConfigStore");
    expect(appListSource).not.toContain("appSurfacesFromDeployment");
    expect(appListSource).toContain('target="_blank"');
    expect(appListSource).toContain('class="av-tile-manage"');
    // Tapping the icon goes straight to the explicitly projected launch URL.
    expect(appListSource).toContain("href={url()}");
    expect(appListSource).not.toContain("window.open");
    // Needs-attention is a corner dot + screen-reader label, not a status pill.
    expect(appListSource).toContain("av-tile-dot");
    expect(appListSource).toContain('t("apps.needsAttention")');
    expect(appListSource).toContain('class="sr-only"');
  });

  test("never derives launch readiness or URLs from StateVersion or Store data", () => {
    expect(appListSource).not.toContain("deployedCapsuleIds");
    expect(appListSource).not.toContain("currentStateVersions");
    expect(appListSource).not.toContain("installConfigs");
    expect(appListSource).not.toContain("store?.kind");
    expect(appListSource).not.toContain("planned URL");
    expect(appListSource).toContain("surface.url");
  });

  test("a failed supplemental full-list fetch is surfaced, not silent truncation", () => {
    expect(appListSource).toContain("fullCapsules.error");
    expect(appListSource).toContain("uiSurfaces.error");
    expect(appListSource).toContain("retryFullFetch");
    expect(appListSource).toContain('t("apps.listIncomplete")');
    expect(appListSource).toContain('t("common.retry")');
    expect(en["apps.listIncomplete"]).toBeTruthy();
    expect(ja["apps.listIncomplete"]).toBeTruthy();
  });
});
