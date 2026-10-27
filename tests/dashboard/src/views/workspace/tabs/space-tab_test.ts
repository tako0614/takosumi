/**
 * アカウント > スペース (SpaceTab): the name is edited without the generated
 * handle, new spaces are created by purpose, and archiving says what it does
 * (and does not do) before it happens.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

const read = (path: string) =>
  readFileSync(
    resolve(import.meta.dir, "../../../../../../dashboard/src", path),
    "utf8",
  );
const source = read("views/workspace/tabs/SpaceTab.tsx");
const createForm = read("views/account/components/SpaceCreateForm.tsx");

describe("SpaceTab name", () => {
  test("never shows the generated handle before (or instead of) the name", () => {
    expect(source).not.toContain("current().handle");
    expect(source).not.toContain("@${");
    expect(source).not.toContain("workspaceSettings.general.handle");
    expect(source).toContain("spaceName(current)");
    expect(source).not.toContain("<details");
  });

  test("re-seeds the name draft only while it is clean, without tracking keystrokes", () => {
    expect(source).toContain("let seededName: string | null = null;");
    expect(source).toContain("const draft = untrack(nameDraft);");
    expect(source).toContain("if (!clean) return;");
    const effect = source.slice(
      source.indexOf("let seededName"),
      source.indexOf("const save = async"),
    );
    expect(effect.indexOf("if (!clean) return;")).toBeLessThan(
      effect.indexOf("setNameDraft(shown);"),
    );
  });
});

describe("SpaceTab create by purpose", () => {
  test("offers 環境を分ける and チームで使う instead of the mechanism", () => {
    expect(source).toContain('setPurpose("environment")');
    expect(source).toContain('setPurpose("team")');
    expect(ja["space.create.environment"]).toBe("環境を分ける");
    expect(ja["space.create.team"]).toBe("チームで使う");
    // A team space continues straight to inviting members.
    expect(source).toContain('navigate("/account/members")');
    // Creating works before the first space exists.
    expect(source).toContain("<NewSpaceCard />");
    expect(source.indexOf("<NewSpaceCard />")).toBeGreaterThan(
      source.indexOf("<Show when={currentWorkspaceId() || null} keyed>"),
    );
  });

  test("the shared create form asks only for a name and generates the handle", () => {
    expect(createForm).toContain("handle: newSpaceHandle()");
    expect(createForm).toContain("type: workspaceTypeForPurpose(props.purpose)");
    expect(createForm).toContain(
      'window.dispatchEvent(new Event("takosumi:workspaces-changed"))',
    );
    expect(createForm).not.toContain("handle()");
  });
});

describe("SpaceTab archive lifecycle", () => {
  test("archiving keeps the user here and states that apps keep running", () => {
    expect(source).not.toContain('setCurrentWorkspaceId("")');
    expect(source).toMatch(
      /^const \[archiveNotice, setArchiveNotice\] = createSignal/m,
    );
    expect(source).toContain('t("space.archive.confirmMessage")');
    expect(source).toContain('t("space.archive.lastSpace")');
    expect(source).toContain("disabled={archiving() || activeSpaceCount() <= 1}");
    expect(ja["space.archive.confirmMessage"]).toContain("動き続け");
    expect(en["space.archive.confirmMessage"]).toContain("keep running");
    expect(ja["space.archive.done"]).toContain("{name}");
  });

  test("restore is busy per row, guards double submits, and pages", () => {
    expect(source).toContain("const [restoringId, setRestoringId]");
    expect(source).toContain("if (restoringId()) return;");
    expect(source).toMatch(/finally \{\s*setRestoringId\(null\);\s*\}/);
    expect(source).toContain("busy={restoringId() === workspace.id}");
    expect(source).toContain("cursor: current.nextCursor");
    expect(source).toContain('t("common.loadMore")');
  });
});
