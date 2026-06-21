import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const sourcePath = resolve(
  import.meta.dir,
  "../../../../../dashboard/src/views/runs/RunGroupView.tsx",
);

const source = readFileSync(sourcePath, "utf8");

describe("RunGroupView", () => {
  test("keeps grouped updates service-first instead of execution-id-first", () => {
    expect(source).toContain('class="wa-run-group-list"');
    expect(source).toContain("RunGroupMemberRow");
    expect(source).toContain('t("runGroup.openService")');
    expect(source).toContain('<summary>{t("run.details.title")}</summary>');
    expect(source).not.toContain('header: "Run"');
    expect(source).not.toContain("<DataTable");
    expect(source).not.toContain("<KVList items={items()} />");
    expect(en["runGroup.title"]).toBe("Batch update");
    expect(en["runGroup.approveAll"]).not.toContain("executions");
    expect(en["runGroup.members"]).not.toContain("executions");
    expect(ja["runGroup.approveAll"]).not.toContain("実行");
    expect(ja["runGroup.members"]).not.toContain("実行");
  });
});
