/**
 * Source-assertion regression tests for the General tab (GeneralTab): the
 * display-name draft must not be re-seeded over unsaved typing. workspace()
 * refetches on unarchive / background refresh, and an unconditional
 * setDisplayNameDraft(current.displayName) silently discarded the edit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
