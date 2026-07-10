import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(
    resolve(here, "../../../../../../../dashboard/src", rel),
    "utf8",
  );

const appShellSource = read("views/account/components/shell/AppShell.tsx");
const shellLayoutSource = read(
  "views/account/components/shell/ShellLayout.tsx",
);
const navSource = read("views/account/components/shell/nav.ts");
const sidebarSource = read("views/account/components/shell/Sidebar.tsx");
const mobileTabsSource = read("views/account/components/shell/MobileTabs.tsx");
const topBarSource = read("views/account/components/shell/TopBar.tsx");
const spaceSwitcherSource = read(
  "views/account/components/shell/WorkspaceSwitcher.tsx",
);
const workspaceSettingsSource = read(
  "views/workspace/WorkspaceSettingsView.tsx",
);
const userMenuSource = read("views/account/components/auth/UserMenu.tsx");
const indexSource = read("index.tsx");
const shellCssSource = read("styles/shell.css");

describe("dashboard shell navigation layout", () => {
  test("composes a persistent sidebar + top bar + mobile tabs over the content", () => {
    expect(appShellSource).toContain("import Sidebar");
    expect(appShellSource).toContain("import MobileTabs");
    expect(appShellSource).toContain("<Sidebar />");
    expect(appShellSource).toContain("<MobileTabs />");
    expect(appShellSource).toContain('class="app-shell-main"');
    expect(appShellSource).toContain('class="app-shell-content"');
    expect(shellCssSource).toContain(".sidebar");
    expect(shellCssSource).toContain(".mobile-tabs");
    expect(shellCssSource).toContain(
      "grid-template-columns: var(--tg-sidebar-w) 1fr;",
    );
  });

  test("the chrome is a route-level layout, not a per-view wrapper", () => {
    // ShellLayout = AuthGuard + AppShell, mounted once in the route table.
    expect(shellLayoutSource).toContain("AuthGuard");
    expect(shellLayoutSource).toContain(
      "<AppShell>{props.children}</AppShell>",
    );
    expect(indexSource).toContain("<Route component={ShellLayout}>");
    // No view may re-wrap itself in the chrome (the layout owns it).
    const viewsThatMustNotWrap = [
      "views/apps/AppListView.tsx",
      "views/store/StoreView.tsx",
      "views/new/NewAppView.tsx",
      "views/runs/RunView.tsx",
      "views/workspace/WorkspaceSettingsView.tsx",
      "views/settings/SettingsView.tsx",
      "views/settings/ManageView.tsx",
    ];
    for (const rel of viewsThatMustNotWrap) {
      expect(read(rel)).not.toContain("AppShell");
    }
  });

  test("nav.ts is the single source of truth: home / store / settings everywhere", () => {
    // The consumer trio, in order.
    const primary = navSource.slice(
      navSource.indexOf("PRIMARY_NAV"),
      navSource.indexOf("ManageDestination"),
    );
    expect(primary).toContain('href: "/", labelKey: "nav.home"');
    expect(primary).toContain('href: "/store", labelKey: "nav.store"');
    expect(primary).toContain('href: "/settings", labelKey: "nav.settings"');
    // Deploy-console destinations stay OUT of the primary nav.
    for (const banned of ['"/new"', '"/runs"', '"/account"', '"/services"']) {
      expect(primary).not.toContain(`href: ${banned}`);
    }
    // Sidebar and mobile tabs render the shared model — no hard-coded hrefs.
    expect(sidebarSource).toContain("PRIMARY_NAV");
    expect(sidebarSource).not.toContain('href: "/');
    expect(mobileTabsSource).toContain("PRIMARY_NAV");
    expect(mobileTabsSource).not.toContain('href: "/');
    // TopBar titles derive from the same module.
    expect(topBarSource).toContain('import { SECTION_TITLES } from "./nav.ts"');
    expect(topBarSource).not.toContain("const SECTION_TITLES");
  });

  test("hosting management is relocated, not removed: /settings/manage catalogs every surface", () => {
    // 機能は消さず移設 — every old console destination stays reachable.
    for (const href of [
      '"/services"',
      '"/connections"',
      '"/cloud"',
      '"/runs"',
      '"/graph"',
      '"/activity"',
      '"/advanced/workspace"',
    ]) {
      expect(navSource).toContain(`href: ${href}`);
    }
    // …and their routes stay alive in the route table.
    for (const route of [
      '<Route path="/services" component={ServiceListView} />',
      '<Route path="/connections" component={ConnectionsView} />',
      '<Route path="/cloud" component={CloudResourcesView} />',
      '<Route path="/runs" component={RunsListView} />',
      '<Route path="/graph" component={GraphView} />',
      '<Route path="/activity" component={ActivityView} />',
      '<Route path="/advanced/workspace" component={AdvancedWorkspaceView} />',
    ]) {
      expect(indexSource).toContain(route);
    }
    // The settings hub links to the catalog.
    expect(read("views/settings/SettingsView.tsx")).toContain(
      '"/settings/manage"',
    );
    expect(read("views/settings/ManageView.tsx")).toContain(
      "MANAGE_DESTINATIONS",
    );
  });

  test("Workspace backups/shares are reachable via the manage catalog (not the settings tab strip)", () => {
    // These tabs are deliberately kept out of the normal settings tab strip
    // (see space-settings-user-noise_test) but must still be reachable — the
    // manage catalog is their home.
    for (const href of [
      '"/advanced/workspace/backups"',
      '"/advanced/workspace/shares"',
    ]) {
      expect(navSource).toContain(`href: ${href}`);
    }
  });

  test("Cloud-only manage entries are runtime-gated off Cloud", () => {
    // The /cloud entry renders an "unavailable" dead-end on self-host/Takos, so
    // the manage catalog gates it behind the Cloud runtime.
    const cloudEntry = navSource.slice(
      navSource.indexOf('href: "/cloud"'),
      navSource.indexOf('href: "/cloud"') + 200,
    );
    expect(cloudEntry).toContain("cloudOnly: true");
    const manageSource = read("views/settings/ManageView.tsx");
    expect(manageSource).toContain("isTakosumiCloudRuntime");
    expect(manageSource).toContain("dest.cloudOnly");
  });

  test("the store is a first-class tab (no /store → /new bounce)", () => {
    expect(indexSource).toContain(
      '<Route path="/store" component={StoreView} />',
    );
    expect(indexSource).not.toContain(
      '<Route path="/store" component={() => <RedirectWithQuery to="/new" />} />',
    );
    // /new stays alive as the install-execution flow (external /install links).
    expect(indexSource).toContain(
      '<Route path="/new" component={NewAppView} />',
    );
    expect(indexSource).toContain('path="/install"');
  });

  test("mobile bottom bar mirrors the sidebar trio, icon-only", () => {
    expect(mobileTabsSource).toContain("<tab.icon size={24} />");
    expect(mobileTabsSource).not.toContain("mobile-tab-label");
    expect(mobileTabsSource).toContain("aria-label={t(tab.labelKey)}");
    expect(shellCssSource).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(56px, 1fr));",
    );
    expect(shellCssSource).not.toContain(".topbar-icon-btn.topbar-add");
  });

  test("top bar keeps mobile workspace switching without returning brand chrome", () => {
    expect(topBarSource).not.toContain('href="/new"');
    expect(topBarSource).toContain('href="/notifications"');
    expect(topBarSource).toContain("<UserMenu />");
    expect(topBarSource).toContain("<WorkspaceSwitcher compact />");
    expect(shellCssSource).toContain(".topbar-mobile-workspace");
    expect(shellCssSource).toContain("max-width: none;");
    expect(topBarSource).not.toContain("Wordmark");
    expect(topBarSource).not.toContain("topbar-brand");
  });

  test("profile menu keeps account + history shortcuts under the settings IA", () => {
    expect(userMenuSource).toContain('href="/runs"');
    expect(userMenuSource).toContain('href="/settings/account"');
    // Docs link must stay host-relative on the standalone dashboard so a
    // self-hosted deployment never points at app.takosumi.com.
    expect(userMenuSource).toContain("docsHref");
    expect(userMenuSource).toContain('"/docs/"');
    expect(userMenuSource).not.toContain("app.takosumi.com");
    expect(userMenuSource).not.toContain("WorkspaceSwitcher");
    expect(userMenuSource).not.toContain('href="/connections"');
    expect(userMenuSource).not.toContain('href="/advanced/workspace"');
    expect(userMenuSource).not.toContain('href="/billing"');
    // Switcher stays read/select only (no inline workspace creation), but
    // remains visibly current even when there is only one workspace.
    expect(spaceSwitcherSource).toContain("loadedWorkspaces().length > 0");
    expect(spaceSwitcherSource).toContain('href="/advanced/workspace"');
    expect(spaceSwitcherSource).toContain("topbar-workspace-settings");
    expect(spaceSwitcherSource).not.toContain("disabled={");
    expect(spaceSwitcherSource).not.toContain("createSpace");
    // Vocabulary parity. Keys are flat with dots, so assert direct access —
    // toHaveProperty would treat "a.b" as a nested path.
    expect(en["nav.settings"]).toBe("Settings");
    expect(ja["nav.settings"]).toBe("設定");
    expect(en["nav.home"]).toBe("Home");
    expect(ja["nav.home"]).toBe("ホーム");
    expect(en["nav.connections"]).toBeTruthy();
    expect(ja["nav.connections"]).toBeTruthy();
    expect(en["nav.primary"]).toBeTruthy();
    expect(ja["nav.primary"]).toBeTruthy();
    expect(en["settings.manage.title"]).toBeTruthy();
    expect(ja["settings.manage.title"]).toBeTruthy();
    expect(en["workspace.settings"]).toBe("Workspace settings");
    expect(ja["workspace.settings"]).toBe("ワークスペース設定");
    expect(en["workspace.change"]).toBe("Switch");
    expect(ja["workspace.change"]).toBe("切り替え");
    expect(en["workspaceSettings.title"]).toBe("Settings");
    expect(ja["workspaceSettings.title"]).toBe("設定");
  });

  test("workspace switcher and settings tabs keep visible selection and loaded data aligned", () => {
    expect(spaceSwitcherSource).toContain(
      "const selectedWorkspaceId = createMemo",
    );
    expect(spaceSwitcherSource).toContain('class="topbar-workspace-row"');
    expect(spaceSwitcherSource).toContain('class="topbar-workspace-current"');
    expect(spaceSwitcherSource).toContain("selectedWorkspaceName()");
    expect(spaceSwitcherSource).toContain("switcherOpen()");
    // The picker is a popover menu (not a native <select>): the active
    // workspace is a checked menuitemradio, chosen by tapping the item.
    expect(spaceSwitcherSource).toContain('role="menuitemradio"');
    expect(spaceSwitcherSource).toContain(
      "aria-checked={workspace.id === selectedWorkspaceId()}",
    );
    expect(spaceSwitcherSource).not.toContain("topbar-workspace-select");
    expect(spaceSwitcherSource).toContain("setSwitcherOpen(false)");
    // a11y contract: the menu is named, and the trigger names the current
    // workspace (the compact/topbar variant shows only the avatar letter).
    expect(spaceSwitcherSource).toContain(
      "aria-labelledby={`${switcherId()}-label`}",
    );
    expect(spaceSwitcherSource).toContain('t("workspace.switcherAria"');
    // Popup is a role="group" of links/controls, not a menu — the trigger
    // must not claim aria-haspopup.
    expect(userMenuSource).not.toContain("aria-haspopup");
    expect(userMenuSource).toContain("onSessionChange");
    expect(workspaceSettingsSource).toContain("when={workspaceId()}");
    expect(workspaceSettingsSource).toContain("keyed");
    expect(workspaceSettingsSource).toContain(
      "<BillingTab workspaceId={id} />",
    );
    expect(workspaceSettingsSource).toContain(
      'href: "/advanced/workspace/cloud"',
    );
    expect(workspaceSettingsSource).toContain(
      'label: t("workspaceSettings.tab.cloud")',
    );
    expect(workspaceSettingsSource).toContain(
      'href: "/advanced/workspace/keys"',
    );
    expect(workspaceSettingsSource).toContain(
      'label: t("workspaceSettings.tab.keys")',
    );
    expect(workspaceSettingsSource).toContain(
      "<CloudResourcesPanel showHeader={false} />",
    );
    expect(workspaceSettingsSource).toContain(
      "<CloudApiKeysPanel showHeader={false} />",
    );
    expect(workspaceSettingsSource).not.toContain(
      "<BillingTab workspaceId={id()} />",
    );
  });
});
