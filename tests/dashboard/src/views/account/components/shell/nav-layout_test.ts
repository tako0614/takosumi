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
  test("keeps desktop navigation task-first with management separated", () => {
    expect(sidebarSource).toContain("const PRIMARY");
    expect(sidebarSource).toContain("const MANAGE");
    expect(sidebarSource).toContain('labelKey: "nav.home"');
    expect(sidebarSource).toContain('labelKey: "nav.add"');
    expect(sidebarSource).toContain('aria-label={t("nav.manage")}');
    expect(sidebarSource).toContain('class="sidebar-section-label"');
    expect(en["nav.manage"]).toBe("Manage");
    expect(ja["nav.manage"]).toBe("管理");
  });

  test("keeps mobile tabs and grid column count aligned", () => {
    expect(mobileTabsSource).toContain('href: "/connections"');
    expect(mobileTabsSource).toContain("icon: Plug");
    expect(shellCssSource).toContain("grid-template-columns: repeat(5, 1fr);");
  });
});
