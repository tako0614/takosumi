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
    expect(source).toContain('t("runGroup.openRun")');
    expect(source).toContain('<summary>{t("run.details.title")}</summary>');
    expect(source).not.toContain('class="wa-run-group-details"');
    expect(source).not.toContain('t("run.details.runId")');
    expect(source).not.toContain('header: "Run"');
    expect(source).not.toContain("<DataTable");
    expect(source).not.toContain("<KVList items={items()} />");
    expect(en["runGroup.title"]).toBe("Workspace update");
    expect(en["runGroup.openRun"]).toBe("Review change");
    expect(ja["runGroup.openRun"]).toBe("変更内容を開く");
    expect(en["runGroup.groupId"]).toBe("Update ID");
    expect(ja["runGroup.groupId"]).toBe("更新 ID");
    expect(en["runGroup.approveAll"]).not.toContain("executions");
    expect(en["runGroup.members"]).not.toContain("executions");
    expect(ja["runGroup.approveAll"]).not.toContain("実行");
    expect(ja["runGroup.members"]).not.toContain("実行");
  });

  test("keeps a running grouped update live: poll while non-terminal + manual refresh", () => {
    // A grouped update executes over minutes; a single static createResource
    // read would never show members progressing. Mirror RunView's fallback
    // poll: ~5s while any member run is non-terminal, visibility-aware.
    expect(source).toContain("RUN_GROUP_POLL_MS");
    expect(source).toContain("isTerminalRunStatus");
    expect(source).toContain("anyMemberActive");
    expect(source).toContain("visibilitychange");
    expect(source).toContain(
      "setTimeout(() => void refetch(), RUN_GROUP_POLL_MS)",
    );
    // Manual refresh affordance in the header.
    expect(source).toContain('t("common.refresh")');
    expect(source).toContain("onClick={() => void refetch()}");
    // Poll re-render must not flash the skeleton over live rows.
    expect(source).toContain(
      "<Match when={group.loading && !group.error && !group.latest}>",
    );
  });
});
