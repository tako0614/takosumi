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

  test("sidebar leads with app-first surfaces and keeps hosting management lower", () => {
    expect(sidebarSource).toContain('labelKey: "nav.apps"');
    expect(sidebarSource).toContain('href: "/new"');
    expect(sidebarSource).toContain('labelKey: "nav.add"');
    expect(sidebarSource).toContain('href: "/runs"');
    expect(sidebarSource).toContain('labelKey: "nav.runs"');
    expect(sidebarSource).toContain('href: "/account"');
    expect(sidebarSource).toContain('labelKey: "nav.account"');
    expect(sidebarSource).not.toContain('href: "/store"');
    expect(sidebarSource).not.toContain('labelKey: "nav.store"');
    expect(sidebarSource).toContain("const MANAGE");
    expect(sidebarSource).toContain("sidebar-nav-manage");
    // Apps (/) stays the launcher; the full Services list remains secondary.
    expect(sidebarSource).toContain('href: "/services"');
    expect(sidebarSource).toContain('labelKey: "nav.services"');
    expect(sidebarSource).not.toContain('href: "/connections"');
    expect(sidebarSource).not.toContain('labelKey: "nav.connections"');
    expect(sidebarSource).toContain('href: "/advanced/workspace"');
    expect(sidebarSource).toContain('labelKey: "nav.workspaceSettings"');
    // Cloud/Billing stay off the primary shell and are reached from settings.
    expect(sidebarSource).toContain("isTakosumiCloudRuntime");
    expect(sidebarSource).not.toContain('href="/billing"');
    expect(sidebarSource).not.toContain('href="/cloud"');
    // The workspace switcher moved out of the profile menu into the sidebar.
    expect(sidebarSource).toContain("WorkspaceSwitcher");
    expect(sidebarSource.indexOf('class="sidebar-workspace"')).toBeLessThan(
      sidebarSource.indexOf('class="sidebar-nav"'),
    );
    // Notifications are still an attention affordance, not a sidebar item.
    expect(sidebarSource).not.toContain('href: "/notifications"');
  });

  test("mobile bottom bar is the app-first launcher/add/settings trio, icon-only", () => {
    expect(mobileTabsSource).toContain('href: "/"');
    expect(mobileTabsSource).toContain('href: "/new"');
    expect(mobileTabsSource).toContain('href: "/advanced/workspace"');
    // Account + activity moved to the top-bar profile avatar; hosting internals
    // stay out of the bottom bar entirely.
    expect(mobileTabsSource).not.toContain('href: "/account"');
    expect(mobileTabsSource).not.toContain('href: "/runs"');
    expect(mobileTabsSource).not.toContain('href: "/store"');
    expect(mobileTabsSource).not.toContain('href: "/services"');
    expect(mobileTabsSource).not.toContain('href: "/connections"');
    // Icons carry the meaning; the two-character labels are gone (the
    // accessible name stays as aria-label on each link).
    expect(mobileTabsSource).not.toContain("mobile-tab-label");
    expect(mobileTabsSource).toContain("aria-label={tab.label()}");
    expect(shellCssSource).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(56px, 1fr));",
    );
    // The redundant mobile top-bar "+ add" is gone (the bottom bar owns add).
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

  test("profile menu keeps account + history; connections/settings/billing/switcher moved to the sidebar", () => {
    expect(userMenuSource).toContain('href="/runs"');
    expect(userMenuSource).toContain('href="/account"');
    expect(userMenuSource).toContain("dashboardDocsHref");
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
    // Management vocabulary parity. Keys are flat with dots, so assert direct
    // access — toHaveProperty would treat "a.b" as a nested path.
    expect(en["nav.connections"]).toBeTruthy();
    expect(ja["nav.connections"]).toBeTruthy();
    expect(en["nav.primary"]).toBeTruthy();
    expect(ja["nav.primary"]).toBeTruthy();
    expect(en["nav.workspaceSettings"]).toBeTruthy();
    expect(ja["nav.workspaceSettings"]).toBeTruthy();
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
