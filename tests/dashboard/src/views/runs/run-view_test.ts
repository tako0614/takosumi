import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/runs/RunView.tsx",
  ),
  "utf8",
);

describe("RunView", () => {
  test("labels a succeeded review run awaiting its deploy 実行待ち, not 成功", () => {
    // The header badge must agree with the deploy CTA it renders right below: a
    // deployable succeeded plan reads 実行待ち (ready to run — the remaining
    // step is execution), reserving 承認待ち for runs whose backend status
    // genuinely still needs approval. Either way it must never claim 成功.
    expect(source).toMatch(
      /const displayStatus = \(r: Run\): Run\["status"\] \| "ready_to_deploy" =>\s*\n?\s*isDeployableRun\(r\) \? "ready_to_deploy" : r\.status;/,
    );
    expect(source).toContain("status={displayStatus(r())}");
    // The raw status must no longer drive the header badge directly.
    expect(source).not.toContain("status={r().status}");
  });

  test("deploy CTA follows the SHARED approval predicate over the sibling ledger", () => {
    // An already-applied plan opened from history must not present 承認待ち +
    // an active デプロイを実行 CTA: the run list's semantics (any apply /
    // destroy_apply at/after the plan consumes the approval) are shared via
    // lib/run-approval.ts, and RunView feeds it the Workspace Run ledger.
    expect(source).toContain('from "../../lib/run-approval.ts"');
    expect(source).toContain("isDeployApprovalCandidate");
    expect(source).toContain("awaitsDeployApproval(r, siblings)");
    expect(source).toContain("listRuns(workspaceId, SIBLING_RUNS_LIMIT)");
    // While the ledger read is loading, no CTA (conservative); a FAILED read
    // falls back to run-local facts instead of hiding the button forever.
    expect(source).toContain("if (siblings === undefined) return false;");
    expect(source).toContain("if (siblingRuns.error) return true;");
    // A consumed approval settles the summary instead of claiming "ready".
    expect(source).toContain("deployApprovalConsumed(r)");
    expect(source).toContain('t("run.summary.alreadyApplied")');
    expect(ja["run.summary.alreadyApplied"].length).toBeGreaterThan(0);
    expect(en["run.summary.alreadyApplied"].length).toBeGreaterThan(0);
  });

  test("summary-less runs are honest: no fake zeros, fail-closed destructive gate", () => {
    // 2a: a settled run with neither run.summary nor log-derived items says
    // "no record", never 作成0/変更0/削除0; apply-family terminal runs get the
    // past-tense heading.
    expect(source).toContain("changeCountsKnownForRun");
    expect(source).toContain('t("run.changes.noRecord")');
    expect(source).toContain('"run.changes.titleDone"');
    expect(ja["run.changes.titleDone"]).toBe("変更された内容");
    expect(en["run.changes.titleDone"]).toBe("What changed");
    expect(ja["run.changes.noRecord"].length).toBeGreaterThan(0);
    expect(en["run.changes.noRecord"].length).toBeGreaterThan(0);
    // 2b: unknown counts must gate as destructive (explicit confirmation)...
    expect(source).toMatch(
      /changeCounts\(\)\.delete > 0 \|\|\s*\n?\s*!changeCountsKnown\(\)\)/,
    );
    // ...and the ?auto=install auto-continue must WAIT for the logs refetch
    // to settle before evaluating the gate on a summary-less run.
    expect(source).toContain(
      "if (!runHasChangeSummary(r) && logs.loading) return;",
    );
  });

  test("refetches never unmount the console into a skeleton", () => {
    // The 3s fallback poll / visibility refetch / approve refetch all flip
    // run.loading — the skeleton is for the INITIAL load only (mirrors
    // RunGroupView), and `.latest` keeps rendering during refetches.
    expect(source).toContain(
      "<Match when={run.loading && !run.error && !run.latest}>",
    );
    expect(source).not.toContain("<Match when={run.loading}>");
  });

  test("プランを再実行 re-plans the FRESH snapshot via planCapsuleUpdate", () => {
    // Plain planCapsule would re-plan the same pinned (broken) contents after
    // a repo-side fix; planCapsuleUpdate syncs → pins the new snapshot →
    // compat-checks → plans.
    expect(source).toContain("planCapsuleUpdate(instId)");
    expect(source).not.toMatch(/await planCapsule\(/);
  });

  test("destroy retry preserves the destroy operation", () => {
    expect(source).toContain('run.latest?.type === "destroy_plan"');
    expect(source).toContain("await destroyPlanCapsule(instId)");
  });

  test("terminal applies clear the install-config list cache with the rest", () => {
    expect(source).toContain("clearInstallConfigListCache(workspaceId)");
  });

  test("cancelling a run requires an explicit named confirmation", () => {
    expect(source).toContain("useConfirmDialog");
    expect(source).toContain('t("run.cancelConfirm.title")');
    expect(source).toContain(
      't("run.cancelConfirm.message", { name, operation })',
    );
    expect(source).toContain(
      't("run.cancelConfirm.messageGeneric", { operation })',
    );
    expect(source).toContain("onClick={() => void confirmCancel()}");
    // The one-click path must be gone.
    expect(source).not.toContain("onClick={() => void cancel.run()}");
    expect(ja["run.cancelConfirm.message"]).toContain("{name}");
    expect(ja["run.cancelConfirm.message"]).toContain("{operation}");
    expect(en["run.cancelConfirm.message"]).toContain("{name}");
    expect(en["run.cancelConfirm.message"]).toContain("{operation}");
  });

  test("distinguishes a missing run from a transient load failure", () => {
    expect(source).toContain("function isRunNotFound(");
    expect(source).toContain(
      'error.status === 404 || error.code === "not_found"',
    );
    // Not-found → friendly copy + back to /runs; anything else → retry.
    expect(source).toContain('t("run.notFoundMessage")');
    expect(source).toContain('t("run.loadFailedTitle")');
    expect(source).toContain("onClick={() => void refetchRun()}");
    expect(source).toContain('t("common.retry")');
    expect(ja["run.loadFailedTitle"]).toBe("実行を読み込めませんでした");
    expect(en["run.loadFailedTitle"]).toBe("Couldn't load this run");
  });
});
