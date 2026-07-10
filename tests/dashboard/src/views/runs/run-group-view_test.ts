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
    // Manual refresh affordance in the header — busy ONLY for a user click,
    // never on the 5s poll refetch (that flickered and evicted focus).
    expect(source).toContain('t("common.refresh")');
    expect(source).toContain("onClick={() => void manualRefresh()}");
    expect(source).toContain("busy={manualRefreshing()}");
    expect(source).not.toContain("busy={group.loading}");
    // Poll re-render must not flash the skeleton over live rows.
    expect(source).toContain(
      "<Match when={!snapshot() && group.loading && !group.error}>",
    );
  });

  test("survives a transient poll failure: keep last payload, keep polling", () => {
    // One failed 5s refetch used to swap the member list for an EmptyState
    // and permanently stop the poll (an errored resource read returns false
    // from anyMemberActive). Keep rendering the last good snapshot with a
    // quiet inline notice; the EmptyState is reserved for a failed INITIAL
    // load (which now offers a retry).
    expect(source).toContain("const [snapshot, setSnapshot] = createSignal");
    expect(source).toContain("<Match when={group.error && !snapshot()}>");
    expect(source).toContain("<Match when={snapshot()}>");
    expect(source).toContain('t("runGroup.refreshFailed")');
    expect(source).toContain('t("common.retry")');
    // The poll gate reads the snapshot, not the (throwing) errored resource.
    expect(source).toMatch(
      /anyMemberActive = createMemo\(\(\) => \{\s*\n\s*const current = snapshot\(\);/,
    );
    expect(ja["runGroup.refreshFailed"].length).toBeGreaterThan(0);
    expect(en["runGroup.refreshFailed"].length).toBeGreaterThan(0);
  });

  test("member rows are distinguishable: visible service name + named links", () => {
    // Five identical サービスを開く/変更内容を開く rows are unusable out of
    // context — resolve capsule names (best-effort, cached) and carry them in
    // the visible text + aria-labels.
    expect(source).toContain("listCapsulesCached");
    expect(source).toContain("capsuleNames()");
    expect(source).toContain(
      't("runGroup.openServiceAria", { name: name()! })',
    );
    expect(source).toContain('t("runGroup.openRunAria", { name: name()! })');
    expect(source).toContain('{name() ?? t("runGroup.openService")}');
    expect(ja["runGroup.openServiceAria"]).toContain("{name}");
    expect(en["runGroup.openServiceAria"]).toContain("{name}");
    expect(ja["runGroup.openRunAria"]).toContain("{name}");
    expect(en["runGroup.openRunAria"]).toContain("{name}");
  });

  test('announces member progress politely ("3/5 完了") for assistive tech', () => {
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('role="status"');
    expect(source).toContain('t("runGroup.progressStatus"');
    expect(ja["runGroup.progressStatus"]).toContain("{done}");
    expect(ja["runGroup.progressStatus"]).toContain("{total}");
    expect(en["runGroup.progressStatus"]).toContain("{done}");
    expect(en["runGroup.progressStatus"]).toContain("{total}");
  });
});
