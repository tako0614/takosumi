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
    expect(source).toContain("listInstallations");
    expect(source).toContain("rowsFromRuns");
    expect(source).toContain("RUN_LIST_LIMIT");
    expect(source).toContain(
      "href={`/runs/${encodeURIComponent(props.row.runId)}`}",
    );
    expect(source).not.toContain("listActivity");
    expect(source).not.toContain("const SAMPLE");
    expect(source).not.toContain("Math.random");
  });

  test("keeps run history copy user-facing", () => {
    expect(en["runList.title"]).toBe("Updates");
    expect(ja["runList.title"]).toBe("更新履歴");
    expect(en["runList.subtitle"]).not.toContain("ledger");
    expect(ja["runList.subtitle"]).not.toContain("台帳");
  });
});
