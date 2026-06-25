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
  "views/account/components/shell/SpaceSwitcher.tsx",
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

  test("sidebar leads with everyday surfaces: apps / services / add / accounts / settings (+ Cloud billing)", () => {
    // Apps (/) and the full Services list (/services) are split into two nav
    // items; `/` is the app launcher, `/services` the technical list.
    expect(sidebarSource).toContain('labelKey: "nav.apps"');
    expect(sidebarSource).toContain('href: "/services"');
    expect(sidebarSource).toContain('labelKey: "nav.services"');
    expect(sidebarSource).toContain('href: "/connections"');
    expect(sidebarSource).toContain('labelKey: "nav.connections"');
    expect(sidebarSource).toContain('href: "/advanced/workspace"');
    expect(sidebarSource).toContain('labelKey: "nav.spaceSettings"');
    // "Add a service" is a first-class sidebar item (mirrors the launcher).
    expect(sidebarSource).toContain('href: "/new"');
    expect(sidebarSource).toContain('labelKey: "nav.add"');
    // Billing is a sidebar item, Cloud-only.
    expect(sidebarSource).toContain("isTakosumiCloudRuntime");
    expect(sidebarSource).toContain('href="/billing"');
    expect(sidebarSource).toContain('t("nav.billing")');
    // The workspace switcher moved out of the profile menu into the sidebar.
    expect(sidebarSource).toContain("SpaceSwitcher");
    // Runs / notifications are NOT first-class sidebar items.
    expect(sidebarSource).not.toContain('href: "/runs"');
    expect(sidebarSource).not.toContain('href: "/notifications"');
  });

  test("mobile keeps persistent navigation and exposes services plus the Store", () => {
    expect(mobileTabsSource).toContain('href: "/"');
    expect(mobileTabsSource).toContain('href: "/services"');
    expect(mobileTabsSource).toContain('href: "/store"');
    expect(mobileTabsSource).toContain('href: "/new"');
    expect(mobileTabsSource).toContain('href: "/connections"');
    expect(mobileTabsSource).toContain('href: "/advanced/workspace"');
    expect(mobileTabsSource).not.toContain('href: "/account"');
    expect(shellCssSource).toContain("grid-template-columns: repeat(6, 1fr);");
    expect(shellCssSource).toContain(".topbar-icon-btn.topbar-add");
    expect(shellCssSource).toContain("display: inline-flex;");
  });

  test("top bar is actions-only; brand + workspace switch live in the sidebar", () => {
    expect(topBarSource).toContain('href="/new"');
    expect(topBarSource).toContain('href="/notifications"');
    expect(topBarSource).toContain("<UserMenu />");
    expect(topBarSource).not.toContain("Wordmark");
    expect(topBarSource).not.toContain("topbar-brand");
    expect(topBarSource).not.toContain("SpaceSwitcher");
  });

  test("profile menu keeps account + history; connections/settings/billing/switcher moved to the sidebar", () => {
    expect(userMenuSource).toContain('href="/runs"');
    expect(userMenuSource).toContain('href="/account"');
    expect(userMenuSource).toContain("dashboardDocsHref");
    expect(userMenuSource).not.toContain("SpaceSwitcher");
    expect(userMenuSource).not.toContain('href="/connections"');
    expect(userMenuSource).not.toContain('href="/advanced/workspace"');
    expect(userMenuSource).not.toContain('href="/billing"');
    // Switcher stays read/select only (no inline space creation).
    expect(spaceSwitcherSource).toContain("loadedSpaces().length > 1");
    expect(spaceSwitcherSource).not.toContain("createSpace");
    // Management vocabulary parity. Keys are flat with dots, so assert direct
    // access — toHaveProperty would treat "a.b" as a nested path.
    expect(en["nav.connections"]).toBeTruthy();
    expect(ja["nav.connections"]).toBeTruthy();
    expect(en["nav.spaceSettings"]).toBeTruthy();
    expect(ja["nav.spaceSettings"]).toBeTruthy();
    expect(en["spaceSettings.title"]).toBe("Team settings");
    expect(ja["spaceSettings.title"]).toBe("チーム設定");
  });
});
