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
  test("labels a succeeded review run awaiting its deploy 承認待ち, not 成功", () => {
    // The header badge must agree with the deploy CTA it renders right below —
    // reuse the exact isDeployableRun condition, present waiting_approval.
    expect(source).toMatch(
      /const displayStatus = \(r: Run\): Run\["status"\] =>\s*\n?\s*isDeployableRun\(r\) \? "waiting_approval" : r\.status;/,
    );
    expect(source).toContain("status={displayStatus(r())}");
    // The raw status must no longer drive the header badge directly.
    expect(source).not.toContain("status={r().status}");
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
