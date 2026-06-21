import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const newAppViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/new/NewAppView.tsx"),
  "utf8",
);
const appViewsCssSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/styles/app-views.css"),
  "utf8",
);

describe("/new flow guidance", () => {
  test("uses a compact app-launcher guide instead of a permanent technical stepper", () => {
    expect(newAppViewSource).toContain("const guideBody = () =>");
    expect(newAppViewSource).toContain('class="av-new-guide"');
    expect(newAppViewSource).toContain('t("new.guide.choose")');
    expect(newAppViewSource).toContain('t("new.guide.check")');
    expect(newAppViewSource).toContain('t("new.guide.connect")');
    expect(newAppViewSource).toContain('t("new.guide.ready")');
    expect(newAppViewSource).not.toContain('type NewFlowStage = "source"');
    expect(newAppViewSource).not.toContain("const flowStage = ()");
    expect(newAppViewSource).not.toContain('class="av-new-flow"');
    expect(newAppViewSource).not.toContain('t("new.flow.stepSource")');
  });

  test("keeps the cloud UX clear that deploy happens only after review", () => {
    expect(en["new.guide.ready"].toLowerCase()).toContain(
      "nothing is deployed",
    );
    expect(en["new.guide.title"].toLowerCase()).toContain("choose");
    expect(ja["new.guide.ready"]).toContain("承認するまでデプロイされません");
    expect(ja["new.guide.title"]).toContain("選びます");
    expect(en).not.toHaveProperty("new.flow.nextReview");
    expect(ja).not.toHaveProperty("new.flow.nextReview");
  });

  test("keeps the /new guide compact on mobile", () => {
    expect(appViewsCssSource).toContain(".av-new-guide");
    expect(appViewsCssSource).toContain(".av-new-guide-copy");
    expect(appViewsCssSource).toContain(".av-new-source");
    expect(appViewsCssSource).toContain("grid-template-columns: 1fr;");
    expect(appViewsCssSource).not.toContain(".av-new-flow-steps");
    expect(appViewsCssSource).not.toContain(".av-new-flow-step");
  });

  test("keeps the starter catalog app-like and the source form advanced", () => {
    expect(newAppViewSource).toContain('class="av-store"');
    expect(newAppViewSource).toContain('class="av-catalog-grid"');
    expect(newAppViewSource).toContain('class="av-catalog-card"');
    expect(newAppViewSource).toContain('t("new.store.title")');
    expect(newAppViewSource).toContain('t("new.advancedImport.open")');
    expect(newAppViewSource).toContain('t("new.advancedImport.title")');
    expect(newAppViewSource).toContain('t("new.catalog.readyStarter")');
    expect(newAppViewSource).not.toContain('<code class="av-catalog-src"');
    expect(newAppViewSource).not.toContain('aria-label="Add method"');
    expect(en["new.tab.catalog"]).toBe("Recommended");
    expect(en["new.tab.git"]).toBe("Link / URL");
    expect(en["new.store.title"]).toBe("Recommended services");
    expect(en["new.advancedImport.open"].toLowerCase()).toContain("link");
    expect(ja["new.tab.catalog"]).toBe("おすすめ");
    expect(ja["new.tab.git"]).toBe("リンク / URL");
    expect(ja["new.store.title"]).toBe("おすすめサービス");
    expect(ja["new.advancedImport.open"]).toContain("リンク");
  });

  test("keeps arbitrary non-secret OpenTofu inputs in the add flow", () => {
    expect(newAppViewSource).toContain("normalizedInputVariables");
    expect(newAppViewSource).toContain("installReturnVariables");
    expect(newAppViewSource).toContain('t("new.vars.inputsTitle")');
    expect(newAppViewSource).toContain("name={`varName:${index()}`}");
    expect(newAppViewSource).toContain("name={`varValue:${index()}`}");
    expect(newAppViewSource).toContain("inputVariableError");
    expect(en["new.vars.inputsBody"].toLowerCase()).toContain("non-secret");
    expect(ja["new.vars.inputsBody"]).toContain("非 secret");
  });
});
