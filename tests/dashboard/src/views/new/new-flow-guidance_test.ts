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
  test("shows a durable source-check-connect-review flow above the add form", () => {
    expect(newAppViewSource).toContain('type NewFlowStage = "source"');
    expect(newAppViewSource).toContain("const flowStage = ()");
    expect(newAppViewSource).toContain('class="av-new-flow"');
    expect(newAppViewSource).toContain('t("new.flow.stepSource")');
    expect(newAppViewSource).toContain('t("new.flow.stepCheck")');
    expect(newAppViewSource).toContain('t("new.flow.stepConnect")');
    expect(newAppViewSource).toContain('t("new.flow.stepReview")');
  });

  test("keeps the cloud UX clear that deploy happens only after review", () => {
    expect(en["new.flow.nextReview"].toLowerCase()).toContain(
      "nothing is deployed",
    );
    expect(en["new.flow.title"].toLowerCase()).toContain("before");
    expect(ja["new.flow.nextReview"]).toContain(
      "承認するまでデプロイされません",
    );
    expect(ja["new.flow.title"]).toContain("デプロイ前");
  });

  test("keeps the /new flow compact on mobile", () => {
    expect(appViewsCssSource).toContain(".av-new-flow");
    expect(appViewsCssSource).toContain(".av-new-flow-steps");
    expect(appViewsCssSource).toContain(
      "grid-template-columns: repeat(4, minmax(0, 1fr));",
    );
    expect(appViewsCssSource).toContain(".av-new-flow-step small");
    expect(appViewsCssSource).toContain("display: none;");
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
