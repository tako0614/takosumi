import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../../dashboard/src/i18n/ja.ts";

const sourceRoot = resolve(import.meta.dir, "../../../../../../../dashboard/src");
const read = (relative: string) => readFileSync(resolve(sourceRoot, relative), "utf8");
const switcherSource = read(
  "views/account/components/shell/WorkspaceSwitcher.tsx",
);
const shellCssSource = read("styles/shell.css");

describe("personal-first Workspace switcher", () => {
  test("keeps the Workspace noun and current name visible in compact mobile chrome", () => {
    expect(switcherSource).toContain("selectedWorkspaceName()");
    expect(switcherSource).toContain('class="topbar-workspace-name"');
    expect(switcherSource).toContain("workspaceNameCounts");
    expect(switcherSource).toContain("topbar-workspace-item-handle");
    expect(shellCssSource).toContain("text-overflow: ellipsis;");
    expect(shellCssSource).toContain(
      ".topbar-workspace.compact .topbar-workspace-name {\n    display: block;",
    );
    expect(shellCssSource).not.toContain(
      ".topbar-workspace.compact .topbar-workspace-name {\n    display: none;",
    );
  });

  test("only adds quiet handles when display names collide", () => {
    expect(switcherSource).toContain("showsWorkspaceHandle");
    expect(switcherSource).toContain("workspace.displayName?.trim()");
    expect(switcherSource).toContain("workspaceNameCounts().get(workspaceName(workspace))");
    expect(switcherSource).toContain("workspaceHandleLabel(workspace)");
  });

  test("creates a personal Workspace from purpose/name without exposing global ID grammar", () => {
    expect(switcherSource).toContain("handle: newWorkspaceHandle(),");
    expect(switcherSource).toContain('type: "personal"');
    expect(switcherSource).toContain('t("workspace.create.nameLabel")');
    expect(switcherSource).toContain('t("workspace.create.purposeHelp")');
    expect(switcherSource).toContain("required");
    expect(switcherSource).toContain("aria-describedby");
    expect(switcherSource).toContain("create-name-help");
    expect(switcherSource).toContain("create-error");
    for (const term of [
      "createHandle",
      "handleEdited",
      "isValidWorkspaceHandle",
      "slugifyWorkspaceHandle",
      "workspace.create.idLabel",
      "workspace.create.idPlaceholder",
    ]) {
      expect(switcherSource).not.toContain(term);
    }
    expect(en["workspace.create.nameLabel"]).toContain("Purpose");
    expect(ja["workspace.create.nameLabel"]).toContain("用途");
    expect(en["workspace.create.purposeHelp"]).toContain("Private");
    expect(ja["workspace.create.purposeHelp"]).toContain("自分専用");
    expect(en["workspace.selectMessage"]).not.toContain("private");
    expect(en["workspace.selectMessage"]).toContain("where this work belongs");
    expect(ja["workspace.selectMessage"]).toContain("この作業を保存する");
  });

  test("keeps entity-route redirect and persisted selection behavior", () => {
    expect(switcherSource).toContain("setCurrentWorkspaceId(id);");
    expect(switcherSource).toContain("ENTITY_SCOPED_ROUTES");
    expect(switcherSource).toContain('"/workloads"');
    expect(switcherSource).toContain('"/runs"');
    expect(switcherSource).toContain("setCurrentWorkspaceId(next);");
    expect(switcherSource).toContain("untrack(currentWorkspaceId)");
  });

  test("labels membership as optional access/sharing in advanced settings", () => {
    expect(en["workspaceSettings.tab.members"]).toBe("Access & sharing");
    expect(ja["workspaceSettings.tab.members"]).toBe("アクセスと共有");
    expect(en["settings.manage.workspace"]).toContain("Access");
    expect(ja["settings.manage.workspace"]).toContain("アクセス");
    expect(switcherSource).toContain('href="/advanced/workspace"');
  });
});
