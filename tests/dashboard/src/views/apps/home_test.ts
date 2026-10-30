/**
 * Home (`/`) is the app launcher: every installed app is an icon tile with its
 * name under it. Apps that open come first; apps that cannot be opened yet
 * (installing, never applied, failed, being removed, stopped) still get a
 * muted tile with a status mark that opens the app page. Open targets come
 * only from authorized screens.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../dashboard/src");
const home = readFileSync(resolve(root, "views/apps/AppListView.tsx"), "utf8");
const ui = readFileSync(resolve(root, "views/app/app-ui.tsx"), "utf8");
const router = readFileSync(resolve(root, "index.tsx"), "utf8");
const css = readFileSync(resolve(root, "styles/app-views.css"), "utf8");

describe("Home", () => {
  test("lists every installed app, not only apps with a screen", () => {
    expect(home).toContain("listCapsulesCached(id, { includeDestroyed: false })");
    expect(home).toContain(".filter(isVisibleServiceCapsule)");
    expect(home).toContain("state: appState(inst)");
    expect(home).toContain("listAccessibleApps()");
    expect(home).toContain("getCapsuleApp(entry.capsuleId)");
    // No app is dropped for lacking a screen, and nothing is folded away.
    expect(home).not.toContain("if (!surfaces) continue");
    expect(home).not.toContain("<details");
    expect(home).toContain("sortHomeApps(home.error ? [] : home.latest?.apps ?? [], homeAppName, locale())");
  });

  test("draws each app as a launcher tile: icon or monogram, name under it", () => {
    expect(home).toContain('<ul class="av-launcher">');
    expect(home).toContain('data-testid="home-app"');
    expect(home).toContain('class="av-tile-icon"');
    expect(home).toContain("monogramFrameClass={kindClass(props.app.category)}");
    expect(home).toContain('<span class="av-tile-name">{name()}</span>');
    expect(home).not.toContain("ap-app-card");
    expect(css).toContain(".av-launcher {");
    expect(css).toContain("grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));");
  });

  test("an open tile opens only an authorized screen; every other tile opens the app page", () => {
    expect(home).toContain("listAuthorizedUiSurfaces(id)");
    expect(home).toContain("surfaces = openableScreens(view.screens);");
    expect(home).toContain("homeAppOpens(props.app) ? props.app.surfaces[0] : undefined");
    // The tile opens that screen the way this device chose or the app
    // declares; on a computer (and for the web) that is a new tab.
    expect(home).toContain("screenOpenRoute(props.app.inst.id, surface)");
    expect(home).toContain("{...openRouteAnchor(route())}");
    expect(ui).toContain('return { href: route.href, target: "_blank", rel: "noreferrer noopener" };');
    expect(home).toContain("aria-label={openRouteAria(route(), name())}");
    expect(ui).toContain('return t("app.open.aria", { name });');
    expect(home).toContain("const pageHref = () => appPageHref(props.app.inst.id);");
    expect(home).toContain("href={pageHref()} aria-label={name()}");
    expect(home).toContain('t("apps.manageAria", { name: name() })');
    expect(home).not.toContain("currentStateVersions");
    expect(home).not.toContain("installConfigs");
    expect(home).not.toContain("window.open");
  });

  test("apps that cannot be opened yet stay visible, muted, with a status mark in words", () => {
    for (const key of [
      "apps.state.needsAttention",
      "apps.state.updateAvailable",
      "apps.state.installing",
      "apps.state.uninstalling",
      "apps.state.stopped",
    ]) {
      expect(home).toContain(`"${key}"`);
    }
    expect(home).toContain('homeAppWaiting(props.app) ? "av-tile av-tile-waiting" : "av-tile"');
    expect(home).toContain("av-tile-dot av-tile-dot-${state().kind}");
    // The words are the tile link's accessible description, not color alone.
    expect(home).toContain("aria-describedby={describedBy()}");
    expect(home).toContain('<span class="av-tile-captions" id={captionId}>');
    expect(css).toContain(".av-tile-waiting .av-tile-icon {");
    // A shared app still says who shared it.
    expect(home).toContain('t("app.sharing.sharedBy", { name: props.app.ownerDisplayName ?? "" })');
  });

  test("keeps the app count and the find-apps entry", () => {
    expect(home).toContain('<span class="av-section-head-count">{apps().length}</span>');
    expect(home).toContain('<a class="av-tile av-tile-add" href="/new">');
    expect(home).toContain('t("apps.browse")');
  });

  test("uses legacy list only when app ownership is unavailable and retains the first-run panel", () => {
    expect(home).toContain("if (accessible !== undefined)");
    expect(home).toContain("selectAvailableWorkspaceId");
    expect(home).not.toContain("createWorkspace");
    expect(home).toContain("function AppStartPanel");
    expect(home).toContain('href="/new"');
  });

  test("a failed screen read keeps the apps and says some may not open", () => {
    expect(home).toContain("home.latest?.surfacesFailed");
    expect(home).toContain('t("apps.listIncomplete")');
    expect(home).toContain("refetch()");
  });

  test("Home is the all-apps list: /apps and /workloads redirect there; an app's page is /apps/:id", () => {
    expect(router).not.toContain("WorkloadListView");
    expect(router).toContain('path="/" component={AppListView}');
    expect(router).toContain('path="/apps" component={() => <Navigate href="/" />}');
    expect(router).toContain('path="/workloads" component={() => <Navigate href="/" />}');
    expect(router).toContain('path="/apps/:id" component={AppPage}');
    expect(router).toContain('path="/workloads/:id" component={RedirectLegacyAppPage}');
    expect(router).toContain('path="/workloads/:id/:tab" component={RedirectLegacyAppPage}');
  });
});
