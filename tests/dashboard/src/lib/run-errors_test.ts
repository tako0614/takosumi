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
  test("runner mutation indeterminate warns not to retry or delete and gives the operator path", () => {
    setLocale("ja");
    expect(runFailureHint("runner_mutation_indeterminate")).toBe(
      ja["runError.mutationIndeterminate"],
    );
    expect(ja["runError.mutationIndeterminate"]).toBe(
      "実行結果を確認できず、処理がすでにリソースを変更した可能性があります。状態が確認できるまで再実行や削除はせず、このRunの「参照情報」>「識別情報」にあるRun IDを添えて運営者に確認してください。",
    );
    setLocale("en");
    expect(runFailureHint("runner_mutation_indeterminate")).toBe(
      en["runError.mutationIndeterminate"],
    );
    expect(en["runError.mutationIndeterminate"]).toBe(
      "The result is unknown; the operation may already have changed resources. Do not retry or delete anything until the state is confirmed; ask your operator or administrator and include this Run's ID from Reference info > Identifiers.",
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

  test("indeterminate copy does not recommend logs as confirmation or a retry", () => {
    expect(ja["runError.mutationIndeterminate"]).not.toContain("ログ");
    expect(ja["runError.mutationIndeterminate"]).not.toContain("もう一度");
    expect(en["runError.mutationIndeterminate"]).not.toContain("logs");
    expect(en["runError.mutationIndeterminate"]).not.toContain("try again");
  });
});
