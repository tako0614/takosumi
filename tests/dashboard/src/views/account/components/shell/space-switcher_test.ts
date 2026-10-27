/**
 * The space switcher (a space is a Workspace): out of the way for one space,
 * by name for two or more, and new spaces by purpose.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../../dashboard/src/i18n/ja.ts";
import { t } from "../../../../../../../dashboard/src/i18n/index.ts";
import {
  duplicatedSpaceNames,
  isGeneratedSpaceHandle,
  newSpaceHandle,
  spaceDisambiguator,
  spaceName,
  workspaceTypeForPurpose,
} from "../../../../../../../dashboard/src/lib/space-labels.ts";

const sourceRoot = resolve(import.meta.dir, "../../../../../../../dashboard/src");
const read = (relative: string) => readFileSync(resolve(sourceRoot, relative), "utf8");
const switcherSource = read("views/account/components/shell/SpaceSwitcher.tsx");
const sidebarSource = read("views/account/components/shell/Sidebar.tsx");
const topBarSource = read("views/account/components/shell/TopBar.tsx");
const shellCssSource = read("styles/shell.css");

describe("single-space rule", () => {
  test("renders nothing until there are two or more spaces", () => {
    expect(switcherSource).toContain(
      "const visible = () => !workspaces.loading && loadedWorkspaces().length >= 2;",
    );
    expect(switcherSource).toContain("<Show when={visible() || workspaces.error}>");
    // No zero/one-space chip or "create" call-to-action in the chrome.
    expect(switcherSource).not.toContain("loadedWorkspaces().length > 0");
    expect(switcherSource).not.toContain("empty-cta");
    // Both mounts sit in wrappers that take no room when empty.
    expect(sidebarSource).toContain('<div class="sidebar-space">');
    expect(sidebarSource).toContain("<SpaceSwitcher />");
    expect(topBarSource).toContain("<SpaceSwitcher compact />");
    expect(shellCssSource).toContain(".sidebar-space:empty {\n  display: none;");
  });

  test("a failed list read is reported, never treated as having no spaces", () => {
    expect(switcherSource).toContain("if (workspaces.error) return;");
    expect(switcherSource).toContain("fetchFailedMessage(workspaces.error, t)");
    expect(switcherSource).toContain('class="space-switcher-error"');
  });
});

describe("spaces by name", () => {
  test("never shows a generated handle; a chosen handle only tells duplicates apart", () => {
    expect(isGeneratedSpaceHandle("workspace-m3k9ab-x7y2zq")).toBe(true);
    expect(isGeneratedSpaceHandle(newSpaceHandle())).toBe(true);
    expect(isGeneratedSpaceHandle("alpha-lab")).toBe(false);
    const created = "2026-08-01T00:00:00.000Z";
    expect(
      spaceName({ displayName: "workspace-m3k9ab-x7y2zq", handle: "workspace-m3k9ab-x7y2zq" }),
    ).toBe(t("space.unnamed"));
    expect(spaceName({ displayName: "", handle: "workspace-a-b" })).toBe(t("space.unnamed"));
    expect(spaceName({ displayName: "  Work  ", handle: "workspace-a-b" })).toBe("Work");
    expect(spaceName({ displayName: "", handle: "alpha" })).toBe("alpha");
    expect(spaceDisambiguator({ handle: "alpha-lab", createdAt: created })).toBe("@alpha-lab");
    expect(spaceDisambiguator({ handle: "workspace-a-b", createdAt: created })).not.toContain("workspace-");
    expect(
      [...duplicatedSpaceNames([
        { displayName: "Alpha", handle: "alpha" },
        { displayName: "Alpha", handle: "alpha-lab" },
        { displayName: "Beta", handle: "beta" },
      ])],
    ).toEqual(["Alpha"]);
  });

  test("the menu lists names and adds a hint only for duplicates", () => {
    expect(switcherSource).toContain("{spaceName(workspace)}");
    expect(switcherSource).toContain("<Show when={duplicates().has(spaceName(workspace))}>");
    expect(switcherSource).toContain("{spaceDisambiguator(workspace)}");
    expect(switcherSource).not.toContain("@${workspace.handle}");
    expect(switcherSource).toContain('role="menuitemradio"');
    expect(switcherSource).toContain(
      "aria-checked={workspace.id === selectedWorkspaceId()}",
    );
    expect(switcherSource).toContain('t("space.switcherAria", { name: selectedName() })');
    expect(ja["space.switcherAria"]).toContain("スペースを切り替え");
    expect(en["space.switcherAria"]).toContain("Switch space");
  });
});

describe("new spaces by purpose", () => {
  test("offers 環境を分ける and チームで使う; a team continues to invites", () => {
    expect(switcherSource).toContain('setCreating("environment")');
    expect(switcherSource).toContain('setCreating("team")');
    expect(switcherSource).toContain('if (purpose === "team") navigate("/account/members");');
    expect(switcherSource).toContain('href="/account/space"');
    expect(workspaceTypeForPurpose("team")).toBe("organization");
    expect(workspaceTypeForPurpose("environment")).toBe("personal");
    // The create form is a dialog, not invalid menu content.
    expect(switcherSource).toContain('role={creating() ? "dialog" : "menu"}');
  });

  test("bounded reads with load-more keep every space reachable", () => {
    expect(switcherSource).toContain("limit: DASHBOARD_WORKSPACE_LIST_LIMIT");
    expect(switcherSource).toContain("const cursor = page()?.nextCursor");
    expect(switcherSource).toContain('t("common.loadMore")');
    expect(switcherSource).toContain("mergeWorkspaceLists(");
  });

  test("switching away from an app or run page returns to ホーム", () => {
    expect(switcherSource).toContain("ENTITY_SCOPED_ROUTES");
    expect(switcherSource).toContain('navigate("/");');
    expect(switcherSource).toContain("setCurrentWorkspaceId(id);");
    expect(switcherSource).toContain("untrack(currentWorkspaceId)");
  });
});
