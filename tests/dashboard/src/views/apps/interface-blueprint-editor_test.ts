import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const source = readFileSync(
  new URL(
    "../../../../../dashboard/src/views/apps/AppDetailView.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("advanced Interface blueprint editor", () => {
  test("stays behind progressive disclosure and edits canonical InstallConfig data", () => {
    expect(source).toContain('<summary>{t("app.interfaces.title")}</summary>');
    expect(source).toContain("formatInterfaceBlueprintsJson(");
    expect(source).toContain("parseInterfaceBlueprintsJson(");
    expect(source).toContain("interfaceBlueprints: parsed.value");
    expect(source).toContain("updated.interfaceBlueprints");
    expect(source).not.toContain("interfacePreset");
    expect(source).not.toMatch(/mcp[_-]output/iu);
  });

  test("documents explicit, protocol-neutral input mappings without presets", () => {
    for (const dictionary of [en, ja]) {
      const hint = dictionary["app.interfaces.editorHint"];
      expect(hint).toContain("key");
      expect(hint).toContain("name");
      expect(hint).toContain("spec");
      expect(hint).toContain("literal");
      expect(hint).toContain("capsule_output");
      expect(hint).toContain("resource_output");
      expect(hint.toLowerCase()).not.toContain("mcp");
      expect(hint).not.toMatch(/cloudflare|aws|google/iu);
    }
  });

  test("includes local JSON errors while leaving schema validation to the API", () => {
    expect(source).toContain('t("app.interfaces.errorJson")');
    expect(source).toContain('t("app.interfaces.errorArray")');
    expect(source).toContain("saveInterfaceBlueprints.error()");
  });
});
