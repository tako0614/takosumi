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
const workspaceSwitcherSource = read(
  "views/account/components/shell/WorkspaceSwitcher.tsx",
);
const userMenuSource = read("views/account/components/auth/UserMenu.tsx");
const runtimeCapabilitiesSource = read("lib/runtime-capabilities.ts");
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

  test("keeps focus within account sections and announces prefix-active navigation", () => {
    // An app's sections are fragments (`/apps/:id#settings`): the pathname,
    // and so the focus key, stays the same while moving between them.
    expect(appShellSource).not.toContain('segments[0] === "workloads"');
    expect(appShellSource).toContain('if (segments[0] === "account") return "account";');
    expect(appShellSource).toContain("return location.pathname;");
    expect(sidebarSource).toMatch(
      /aria-current=\{\s*isNavActive\(loc\.pathname, item\) \? "page" : undefined/,
    );
    expect(mobileTabsSource).toContain(
      'aria-current={isNavActive(loc.pathname, tab) ? "page" : undefined}',
    );
  });

  test("the chrome is a route-level layout, not a per-view wrapper", () => {
    expect(shellLayoutSource).toContain("AuthGuard");
    expect(shellLayoutSource).toContain(
      "<AppShell>{props.children}</AppShell>",
    );
    expect(indexSource).toContain("<Route component={ShellLayout}>");
    for (const rel of [
      "views/apps/AppListView.tsx",
      "views/new/InstallView.tsx",
      "views/runs/RunView.tsx",
      "views/account/AccountView.tsx",
      "views/workspace/ConnectionsView.tsx",
    ]) {
      expect(read(rel)).not.toContain("AppShell");
    }
  });

  test("the primary nav is the four behaviors: home / store / connections / account", () => {
    const primary = navSource.slice(
      navSource.indexOf("export const PRIMARY_NAV"),
      navSource.indexOf("export const SECTION_TITLES"),
    );
    const hrefs = [...primary.matchAll(/href: "([^"]+)"/gu)].map((m) => m[1]);
    expect(hrefs).toEqual(["/", "/new", "/connections", "/account"]);
    expect(primary).toContain('labelKey: "nav.home"');
    expect(primary).toContain('labelKey: "nav.store"');
    expect(primary).toContain('labelKey: "nav.connections"');
    expect(primary).toContain('labelKey: "nav.account"');
    // An app's page and its run details keep ホーム selected.
    expect(primary).toContain('alsoActiveOn: ["/apps", "/runs", "/run-groups"]');
    // Nothing else is a destination: no settings hub or manage catalog.
    expect(navSource).not.toContain("MANAGE_DESTINATIONS");
    expect(navSource).not.toContain('"/settings');
    expect(navSource).not.toContain("/advanced");
    // Sidebar and mobile tabs render the shared model — no hard-coded hrefs.
    expect(sidebarSource).toContain("PRIMARY_NAV");
    expect(sidebarSource).not.toContain('href: "/');
    expect(mobileTabsSource).toContain("PRIMARY_NAV");
    expect(mobileTabsSource).not.toContain('href: "/');
    expect(topBarSource).toContain('import { SECTION_TITLES } from "./nav.ts"');
    expect(topBarSource).not.toContain("const SECTION_TITLES");
    expect(ja["nav.home"]).toBe("ホーム");
    expect(ja["nav.store"]).toBe("ストア");
    expect(ja["nav.connections"]).toBe("接続");
    expect(ja["nav.account"]).toBe("アカウント");
    expect(en["nav.connections"]).toBe("Connections");
    expect(en["nav.account"]).toBe("Account");
  });

  test("top bar titles follow the four behaviors", () => {
    for (const [pattern, key] of [
      ["/^\\/$/", "nav.home"],
      ["/^\\/apps(\\/|$)/", "nav.app"],
      ["/^\\/runs(\\/|$)/", "nav.home"],
      ["/^\\/new(\\/|$)/", "nav.store"],
      ["/^\\/connections(\\/|$)/", "nav.connections"],
      ["/^\\/account(\\/|$)/", "nav.account"],
      ["/^\\/notifications(\\/|$)/", "nav.notifications"],
    ] as const) {
      expect(navSource).toContain(`[${pattern}, "${key}"]`);
    }
  });

  test("browse and install are ONE page: /new is the store tab, /store only redirects", () => {
    expect(indexSource).toContain('<Route path="/new" component={NewRoute} />');
    expect(indexSource).toContain("<InstallView />");
    expect(indexSource).not.toContain("StoreView");
    expect(indexSource).toContain('path="/store"');
    expect(indexSource).toContain('<RedirectWithQuery to="/new" />');
    expect(indexSource).toContain('path="/install"');
    const storeBrowserHosts = [
      "views/new/InstallView.tsx",
      "views/apps/AppListView.tsx",
      "views/account/AccountView.tsx",
    ].filter((rel) => read(rel).includes("<StoreBrowser"));
    expect(storeBrowserHosts).toEqual(["views/new/InstallView.tsx"]);
  });

  test("mobile bottom bar mirrors the sidebar with an icon and a short label", () => {
    expect(mobileTabsSource).toContain("<tab.icon size={22} aria-hidden=\"true\" />");
    expect(mobileTabsSource).toContain('<span class="mobile-tab-label">{t(tab.labelKey)}</span>');
    expect(shellCssSource).toContain(".mobile-tab-label");
    expect(shellCssSource).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(56px, 1fr));",
    );
  });

  test("top bar keeps the bell and profile, and the compact workspace switcher", () => {
    expect(topBarSource).not.toContain('href="/new"');
    expect(topBarSource).toContain('href="/notifications"');
    expect(topBarSource).toContain("<UserMenu />");
    expect(topBarSource).toContain("<WorkspaceSwitcher compact />");
    expect(shellCssSource).toContain(".topbar-mobile-workspace");
    expect(topBarSource).not.toContain("Wordmark");
  });

  test("the profile menu matches the nav: account, docs, display, sign-out last", () => {
    expect(userMenuSource).toContain('href="/account"');
    expect(userMenuSource).not.toContain('href="/runs"');
    expect(userMenuSource).not.toContain('href="/settings');
    expect(userMenuSource).not.toContain('href="/connections"');
    expect(userMenuSource).not.toContain('href="/advanced');
    // Sign-out is the last, plain item.
    expect(userMenuSource).not.toContain("user-menu-danger");
    expect(userMenuSource.lastIndexOf("onClick={signOut}")).toBeGreaterThan(
      userMenuSource.lastIndexOf('t("shell.theme")'),
    );
    // Docs stay host-relative on the standalone dashboard.
    expect(userMenuSource).toContain("dashboardDocsHref");
    expect(runtimeCapabilitiesSource).toContain(
      'isTakosEmbeddedRuntime() ? "https://docs.takos.jp" : "/docs/"',
    );
    expect(userMenuSource).not.toContain("app.takosumi.com");
    expect(userMenuSource).not.toContain("WorkspaceSwitcher");
    expect(userMenuSource).not.toContain("aria-haspopup");
    expect(userMenuSource).toContain("onSessionChange");
  });

  test("operator extension pages are listed on アカウント without Cloud code in OSS", () => {
    const profile = read("views/account/sections/ProfileSection.tsx");
    expect(profile).toContain("loadPlatformContributions");
    expect(profile).toContain('"navigation.manage"');
    expect(profile).toContain('rel="external"');
    expect(navSource).not.toContain('href: "/cloud"');
    expect(indexSource).not.toContain("CloudResourcesView");
  });
});
