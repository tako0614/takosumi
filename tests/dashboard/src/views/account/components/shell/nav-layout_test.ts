import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sidebarSource = readFileSync(
  resolve(
    here,
    "../../../../../../../dashboard/src/views/account/components/shell/Sidebar.tsx",
  ),
  "utf8",
);
const mobileTabsSource = readFileSync(
  resolve(
    here,
    "../../../../../../../dashboard/src/views/account/components/shell/MobileTabs.tsx",
  ),
  "utf8",
);
const spaceSwitcherSource = readFileSync(
  resolve(
    here,
    "../../../../../../../dashboard/src/views/account/components/shell/SpaceSwitcher.tsx",
  ),
  "utf8",
);
const userMenuSource = readFileSync(
  resolve(
    here,
    "../../../../../../../dashboard/src/views/account/components/auth/UserMenu.tsx",
  ),
  "utf8",
);
const shellCssSource = readFileSync(
  resolve(here, "../../../../../../../dashboard/src/styles/shell.css"),
  "utf8",
);

describe("dashboard shell navigation layout", () => {
  test("keeps desktop navigation service-first with support routes out of primary chrome", () => {
    expect(sidebarSource).toContain("const PRIMARY");
    expect(sidebarSource).toContain("const ACCOUNT");
    expect(sidebarSource).not.toContain("const ADVANCED");
    expect(sidebarSource).toContain('labelKey: "nav.home"');
    expect(sidebarSource).toContain('labelKey: "nav.add"');
    expect(sidebarSource).not.toContain('labelKey: "nav.notifications"');
    expect(sidebarSource).not.toContain('labelKey: "nav.connections"');
    expect(sidebarSource).not.toContain('labelKey: "nav.billing"');
    expect(sidebarSource).not.toContain('labelKey: "nav.activity"');
    expect(sidebarSource).not.toContain('href: "/notifications"');
    expect(sidebarSource).not.toContain("takosumi.com/docs");
    expect(sidebarSource).toContain('aria-label={t("nav.accountSection")}');
    expect(sidebarSource).not.toContain('class="sidebar-advanced"');
    expect(sidebarSource).toContain('class="sidebar-section-label"');
    expect(en["nav.accountSection"]).toBe("Account");
    expect(ja["nav.accountSection"]).toBe("アカウント");
    expect(en["spaceSettings.title"]).toBe("Team settings");
    expect(ja["spaceSettings.title"]).toBe("チーム設定");
  });

  test("keeps mobile tabs focused on everyday destinations", () => {
    expect(mobileTabsSource).toContain('href: "/"');
    expect(mobileTabsSource).toContain('href: "/new"');
    expect(mobileTabsSource).toContain('href: "/account"');
    expect(mobileTabsSource).not.toContain('href: "/notifications"');
    expect(mobileTabsSource).not.toContain('href: "/connections"');
    expect(mobileTabsSource).not.toContain("icon: Plug");
    expect(shellCssSource).toContain("grid-template-columns: repeat(3, 1fr);");
    expect(spaceSwitcherSource).not.toContain("topbar-create-space");
    expect(spaceSwitcherSource).not.toContain("createSpace");
    expect(spaceSwitcherSource).toContain("loadedSpaces().length > 1");
    expect(spaceSwitcherSource).toContain("createEffect");
    expect(spaceSwitcherSource).not.toContain("@{s.handle}");
    expect(shellCssSource).not.toContain(".topbar-create-space");
  });

  test("keeps paid billing out of the shared account menu unless Cloud is running", () => {
    expect(userMenuSource).toContain("isTakosumiCloudRuntime");
    expect(userMenuSource).toContain('href="/billing"');
    expect(userMenuSource).toContain('t("nav.billing")');
    expect(userMenuSource).toContain("dashboardDocsHref");
  });
});
