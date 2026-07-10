import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/runs/RunsListView.tsx"),
  "utf8",
);
const routerSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/index.tsx"),
  "utf8",
);

describe("RunsListView", () => {
  test("wires /runs as a real history page instead of a 404", () => {
    expect(routerSource).toContain(
      'const RunsListView = lazy(() => import("./views/runs/RunsListView.tsx"));',
    );
    expect(routerSource).toContain(
      '<Route path="/runs" component={RunsListView} />',
    );
    expect(routerSource).toContain(
      '<Route path="/runs/:id" component={RunView} />',
    );
  });

  test("builds the list from the real Run ledger and installation API", () => {
    expect(source).toContain("listRuns");
    expect(source).toContain("listCapsules");
    expect(source).toContain("rowsFromRuns");
    expect(source).toContain("RUN_LIST_PAGE_SIZE");
    expect(source).toContain(
      "href={`/runs/${encodeURIComponent(props.row.runId)}`}",
    );
    // Rows repeat the same visible "詳細"/"確認する"; the accessible name
    // carries the run title (+ service) so the buttons are distinguishable.
    expect(source).toContain('"runList.openAria"');
    expect(source).toContain('"runList.reviewAria"');
    expect(source).toContain("rowAriaTitle");
    expect(source).not.toContain("listActivity");
    expect(source).not.toContain("const SAMPLE");
    expect(source).not.toContain("Math.random");
  });

  test("keeps run history copy user-facing", () => {
    expect(en["runList.title"]).toBe("Activity");
    expect(ja["runList.title"]).toBe("アクティビティ");
    expect(en["runList.subtitle"]).not.toContain("ledger");
    expect(ja["runList.subtitle"]).not.toContain("台帳");
  });

  test("presents a succeeded review run still waiting on its deploy as 承認待ち", () => {
    // The row must NOT claim 成功 while RunView would still render the deploy
    // CTA for it — same condition, same wording as the notifications.
    expect(source).toContain("awaitsDeployApproval");
    expect(source).toContain('run.policyStatus !== "pass"');
    expect(source).toMatch(
      /displayStatus:\s*awaitsDeployApproval\(run, runs\)/,
    );
    expect(source).toContain('? "waiting_approval"');
    expect(source).toContain("status={props.row.displayStatus}");
    expect(source).toContain('props.row.displayStatus === "waiting_approval"');
    // destroy_apply counts as the corresponding apply of a destroy_plan.
    expect(source).toContain(
      'candidate.type !== "apply" && candidate.type !== "destroy_apply"',
    );
  });

  test("names the service on every row the payload allows", () => {
    // Backup runs record only the legacy installationId alias.
    expect(source).toContain("runCapsuleId");
    expect(source).toContain("installationId");
    // Preparation runs (追加前の確認) carry a sourceId — resolve the Source name.
    expect(source).toContain("listSources");
    expect(source).toContain("sourceNames.get(run.sourceId)");
  });

  test("makes the 200-row cap honest: load more, then an explicit end note", () => {
    expect(source).toContain("RUN_LIST_MAX_LIMIT");
    expect(source).toContain('t("common.loadMore")');
    expect(source).toContain('t("common.showingRecent", { n: list().length })');
    expect(en["common.loadMore"]).toBe("Load more");
    expect(ja["common.loadMore"]).toBe("さらに読み込む");
    expect(en["common.showingRecent"]).toContain("{n}");
    expect(ja["common.showingRecent"]).toContain("{n}");
  });
});
