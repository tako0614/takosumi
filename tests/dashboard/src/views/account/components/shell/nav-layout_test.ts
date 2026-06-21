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
const shellCssSource = readFileSync(
  resolve(here, "../../../../../../../dashboard/src/styles/shell.css"),
  "utf8",
);

describe("dashboard shell navigation layout", () => {
  test("keeps desktop navigation service-first with advanced routes folded", () => {
    expect(sidebarSource).toContain("const PRIMARY");
    expect(sidebarSource).toContain("const ACCOUNT");
    expect(sidebarSource).toContain("const ADVANCED");
    expect(sidebarSource).toContain('labelKey: "nav.home"');
    expect(sidebarSource).toContain('labelKey: "nav.add"');
    expect(sidebarSource).toContain('labelKey: "nav.notifications"');
    expect(sidebarSource).toContain('aria-label={t("nav.accountSection")}');
    expect(sidebarSource).toContain('class="sidebar-advanced"');
    expect(sidebarSource).toContain('class="sidebar-section-label"');
    expect(en["nav.accountSection"]).toBe("Account");
    expect(ja["nav.accountSection"]).toBe("アカウント");
    expect(en["nav.advanced"]).toBe("Advanced");
    expect(ja["nav.advanced"]).toBe("詳細");
  });

  test("keeps mobile tabs focused on everyday destinations", () => {
    expect(mobileTabsSource).toContain('href: "/"');
    expect(mobileTabsSource).toContain('href: "/new"');
    expect(mobileTabsSource).toContain('href: "/notifications"');
    expect(mobileTabsSource).toContain('href: "/account"');
    expect(mobileTabsSource).not.toContain('href: "/connections"');
    expect(mobileTabsSource).not.toContain("icon: Plug");
    expect(shellCssSource).toContain("grid-template-columns: repeat(4, 1fr);");
  });
});
