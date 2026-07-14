/**
 * Source-assertion regression tests for the General tab (GeneralTab): the
 * display-name draft must not be re-seeded over unsaved typing. workspace()
 * refetches on unarchive / background refresh, and an unconditional
 * setDisplayNameDraft(current.displayName) silently discarded the edit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../../dashboard/src/views/workspace/tabs/GeneralTab.tsx",
  ),
  "utf8",
);

describe("GeneralTab display-name draft seeding", () => {
  test("re-seeds only while the draft is clean, without tracking keystrokes", () => {
    expect(source).toContain("let seededDisplayName: string | null = null;");
    expect(source).toContain("const draft = untrack(displayNameDraft);");
    expect(source).toMatch(
      /draft === seededDisplayName \|\|\s*draft === current\.displayName/,
    );
    expect(source).toContain("if (!clean) return;");
    expect(source).toContain("seededDisplayName = current.displayName;");
    // The unconditional overwrite must not come back: every seed is guarded.
    const effect = source.slice(
      source.indexOf("let seededDisplayName"),
      source.indexOf("const save = async"),
    );
    expect(effect).toContain("setDisplayNameDraft(current.displayName);");
    expect(effect.indexOf("if (!clean) return;")).toBeLessThan(
      effect.indexOf("setDisplayNameDraft(current.displayName);"),
    );
  });
});

describe("GeneralTab archive lifecycle", () => {
  test("archiving keeps the user on the tab instead of clearing the selection", () => {
    // setCurrentWorkspaceId("") unmounted the tab before any success state
    // rendered and stranded the user on a bare "select a workspace" screen
    // with no unarchive affordance.
    expect(source).not.toContain('setCurrentWorkspaceId("")');
    expect(source).not.toContain("workspace-state.ts");
    // The success state survives the switcher-driven remount (module scope)
    // and names the archived workspace, next to the 復元 list.
    expect(source).toMatch(
      /^const \[archiveNotice, setArchiveNotice\] = createSignal/m,
    );
    expect(source).toContain(
      "setArchiveNotice(current.displayName || `@${current.handle}`);",
    );
    expect(source).toContain(
      't("workspaceSettings.general.archivedNamed", { name: name() })',
    );
    expect(source).toContain('t("workspaceSettings.general.archivedHint")');
    // The archive confirm stays.
    expect(source).toContain('t("workspaceSettings.general.archiveConfirm")');
    expect(en["workspaceSettings.general.archivedNamed"]).toContain("{name}");
    expect(ja["workspaceSettings.general.archivedNamed"]).toContain("{name}");
    expect(ja["workspaceSettings.general.archivedHint"]).toContain("復元");
  });

  test("unarchive is busy per row and guards double submits", () => {
    expect(source).toContain("const [unarchivingId, setUnarchivingId]");
    expect(source).toContain("if (unarchivingId()) return;");
    expect(source).toContain("setUnarchivingId(id);");
    expect(source).toMatch(/finally \{\s*setUnarchivingId\(null\);\s*\}/);
    expect(source).toContain("busy={unarchivingId() === w.id}");
    expect(source).toContain("disabled={unarchivingId() !== null}");
  });
});
