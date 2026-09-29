import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../dashboard/src/i18n/ja.ts";
import { setLocale } from "../../../../dashboard/src/i18n/index.ts";
import { runFailureHint } from "../../../../dashboard/src/lib/run-errors.ts";

const runView = readFileSync(
  resolve(import.meta.dir, "../../../../dashboard/src/views/runs/RunView.tsx"),
  "utf8",
);

describe("Run failure hints", () => {
  test("runner mutation indeterminate explains that the operation may have run", () => {
    setLocale("ja");
    expect(runFailureHint("runner_mutation_indeterminate")).toBe(
      ja["runError.mutationIndeterminate"],
    );
    setLocale("en");
    expect(runFailureHint("runner_mutation_indeterminate")).toBe(
      en["runError.mutationIndeterminate"],
    );
  });

  test("unknown codes retain the generic hint and never leak the raw code", () => {
    setLocale("ja");
    expect(runFailureHint("some_unrecognized_error")).toBe(
      ja["run.summary.failedHint"],
    );
    expect(runFailureHint(undefined)).toBe(ja["run.summary.failedHint"]);
    setLocale("en");
    expect(runFailureHint("some_unrecognized_error")).toBe(
      en["run.summary.failedHint"],
    );
    expect(runFailureHint(undefined)).toBe(en["run.summary.failedHint"]);
  });

  test("Run details already expose the known Run ID and error code", () => {
    // Preserve the existing folded details path; the hint directs users there
    // instead of inventing an API, retry, or destructive action.
    expect(runView).toContain('<summary>{t("run.details.title")}</summary>');
    expect(runView).toContain('<summary>{t("run.details.debug")}</summary>');
    expect(runView).toContain(
      '{ label: t("run.details.runId"), value: <code>{r.id}</code> },',
    );
    expect(ja["runError.mutationIndeterminate"]).toContain(
      '「参照情報」>「識別情報」',
    );
    expect(en["runError.mutationIndeterminate"]).toContain(
      "Reference info > Identifiers",
    );
  });
});
