/**
 * Home (`/`) shows every installed app as the "keep my apps" overview
 * (TASK-0115): apps without a screen, installing, needing attention and with
 * an update all appear, each with its state in words, and Open appears only
 * for screens an authorized Interface provides.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../dashboard/src");
const home = readFileSync(resolve(root, "views/apps/AppListView.tsx"), "utf8");
const router = readFileSync(resolve(root, "index.tsx"), "utf8");

describe("Home", () => {
  test("lists every installed app, not only apps with a screen", () => {
    expect(home).toContain("listCapsulesCached(id, { includeDestroyed: false })");
    expect(home).toContain(".filter(isVisibleServiceCapsule)");
    expect(home).toContain("state: appState(inst)");
    expect(home).toContain("surfaces: surfaces.get(inst.id) ?? []");
    // No app is dropped for lacking a screen.
    expect(home).not.toContain("if (!surfaces) continue");
    expect(home).toContain(".sort(compareHomeApps)");
    expect(home).toContain("appStateRank(a.state) - appStateRank(b.state)");
  });

  test("says each app's state in words and opens only authorized screens", () => {
    for (const key of [
      "apps.state.needsAttention",
      "apps.state.updateAvailable",
      "apps.state.installing",
      "apps.state.uninstalling",
    ]) {
      expect(home).toContain(`"${key}"`);
    }
    expect(home).toContain("listAuthorizedUiSurfaces(id)");
    expect(home).toContain("<OpenAppButton surfaces={props.app.surfaces}");
    expect(home).not.toContain("currentStateVersions");
    expect(home).not.toContain("installConfigs");
    expect(home).not.toContain("window.open");
    // Each card's name opens its app page; the card has one primary action.
    expect(home).toContain("const pageHref = () => appPageHref(props.app.inst.id);");
    expect(home).toContain('t("apps.manageAria", { name: name() })');
  });

  test("keeps Workspace recovery and the first-run panel", () => {
    expect(home).toContain("ensureAccessibleWorkspaceSelection");
    expect(home).toContain("error.status !== 403");
    expect(home).toContain("clearInstallConfigListCache(id)");
    expect(home).toContain("function WorkspaceStartPanel");
    expect(home).toContain('href="/new"');
  });

  test("a failed screen read keeps the apps and says Open may be missing", () => {
    expect(home).toContain("surfacesFailed()");
    expect(home).toContain('t("apps.listIncomplete")');
    expect(home).toContain("refetchUiSurfaces()");
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
