import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(resolve(here, "../../../../../../../dashboard/src", rel), "utf8");

const appShellSource = read("views/account/components/shell/AppShell.tsx");
const topBarSource = read("views/account/components/shell/TopBar.tsx");
const spaceSwitcherSource = read(
  "views/account/components/shell/SpaceSwitcher.tsx",
);
const userMenuSource = read("views/account/components/auth/UserMenu.tsx");
const shellCssSource = read("styles/shell.css");

describe("dashboard shell navigation layout", () => {
  test("puts navigation in a single top bar over a full-width well — no sidebar / mobile tabs", () => {
    // The shell is just <TopBar> + content; the old sidebar and mobile tab bar
    // are gone (deleted, not merely hidden).
    expect(appShellSource).toContain("TopBar");
    expect(appShellSource).toContain('class="app-shell-content"');
    expect(appShellSource).not.toContain("Sidebar");
    expect(appShellSource).not.toContain("MobileTabs");
    expect(shellCssSource).toContain(".topbar");
    expect(shellCssSource).toContain(".app-shell-content");
    expect(shellCssSource).not.toContain(".sidebar");
    expect(shellCssSource).not.toContain(".mobile-tabs");
    expect(shellCssSource).not.toContain(".app-shell-main");
  });

  test("top bar is brand + add + notifications + profile, nothing else", () => {
    expect(topBarSource).toContain("Wordmark");
    expect(topBarSource).toContain('class="topbar-brand"');
    expect(topBarSource).toContain('href="/new"');
    expect(topBarSource).toContain('href="/notifications"');
    expect(topBarSource).toContain("<UserMenu />");
    // The workspace switcher moved into the profile menu, not the top bar.
    expect(topBarSource).not.toContain("SpaceSwitcher");
  });

  test("profile menu carries management routes (history / connections / settings) + workspace switch", () => {
    expect(userMenuSource).toContain("SpaceSwitcher");
    expect(userMenuSource).toContain('href="/runs"');
    expect(userMenuSource).toContain('href="/connections"');
    expect(userMenuSource).toContain('href="/advanced/workspace"');
    expect(userMenuSource).toContain('href="/account"');
    expect(userMenuSource).toContain('class="user-menu-workspace"');
    // Switcher stays read/select only (no inline space creation in the menu).
    expect(spaceSwitcherSource).toContain("loadedSpaces().length > 1");
    expect(spaceSwitcherSource).toContain("createEffect");
    expect(spaceSwitcherSource).not.toContain("createSpace");
    expect(spaceSwitcherSource).not.toContain("topbar-create-space");
    expect(spaceSwitcherSource).not.toContain("@{s.handle}");
    expect(shellCssSource).not.toContain(".topbar-create-space");
    // Management vocabulary stays parity across locales. (Keys are flat with
    // dots, so assert direct access — toHaveProperty would treat "a.b" as a
    // nested path.)
    expect(en["nav.runs"]).toBeTruthy();
    expect(ja["nav.runs"]).toBeTruthy();
    expect(en["nav.connections"]).toBeTruthy();
    expect(ja["nav.connections"]).toBeTruthy();
    expect(en["nav.spaceSettings"]).toBeTruthy();
    expect(ja["nav.spaceSettings"]).toBeTruthy();
    expect(en["spaceSettings.title"]).toBe("Team settings");
    expect(ja["spaceSettings.title"]).toBe("チーム設定");
  });

  test("keeps paid billing out of the shared account menu unless Cloud is running", () => {
    expect(userMenuSource).toContain("isTakosumiCloudRuntime");
    expect(userMenuSource).toContain('href="/billing"');
    expect(userMenuSource).toContain('t("nav.billing")');
    expect(userMenuSource).toContain("dashboardDocsHref");
  });
});
