import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/runs/RunView.tsx"),
  "utf8",
);
const controlApiSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/lib/control-api.ts"),
  "utf8",
);

describe("Run review ProviderConnection evidence", () => {
  test("keeps public provider resolution fields on the dashboard Run shape", () => {
    expect(controlApiSource).toContain(
      "ProviderResolution as ContractProviderResolution",
    );
    expect(controlApiSource).toContain(
      "readonly providerResolutions?: readonly ProviderResolution[]",
    );
    expect(controlApiSource).toContain(
      "readonly runEnvironmentEvidenceDigest?: string",
    );
    expect(controlApiSource).toContain("readonly redactionProfileId?: string");
  });

  test("keeps ProviderConnection evidence available but folded behind review details", () => {
    expect(runViewSource).toContain("ProviderResolutionTable");
    expect(runViewSource).toContain("providerResolutionRows(run.latest");
    expect(runViewSource).toContain("providerRowsNeedingAttention");
    expect(runViewSource).toContain("providerResolutionNeedsAttention");
    expect(runViewSource).toContain('t("run.connections.reviewTitle")');
    expect(runViewSource).toContain(
      "<Show when={providerRowsNeedingAttention().length > 0}>",
    );
    expect(runViewSource).toContain("rows={providerRowsNeedingAttention()}");
    expect(runViewSource).toContain("listProviderConnections");
    expect(runViewSource).toContain("providerConnectionsForRun");
    expect(en["run.details.title"]).toBe("Support details");
    expect(ja["run.details.title"]).toBe("サポート詳細");
    expect(en["run.connections.reviewTitle"]).toBe("Connection review needed");
    expect(ja["run.connections.reviewTitle"]).toBe("接続の確認が必要です");
    expect(en).not.toHaveProperty("run.connections.ownership");
    expect(ja).not.toHaveProperty("run.connections.ownership");
    expect(runViewSource).not.toContain('t("run.connections.ownership")');
    expect(runViewSource).not.toContain("conn.ownership.takosProvided");
  });

  test("shows public plan resources as the reviewable resource list", () => {
    expect(controlApiSource).toContain(
      "readonly planResources?: readonly RunPlanResource[]",
    );
    expect(runViewSource).toContain("PlanResourceReview");
    expect(runViewSource).toContain("PLAN_RESOURCE_REVIEW_LIMIT");
    expect(runViewSource).toContain("run.latest?.planResources ?? []");
    expect(runViewSource).toContain("planResourceActionLabel");
    expect(runViewSource).toContain('t("run.resources.title")');
    expect(runViewSource).toContain(
      "<PlanResourceReview resources={planResources()} />",
    );
    expect(en["run.resources.title"]).toBe("Technical change details");
    expect(ja["run.resources.title"]).toBe("技術的な変更詳細");
    expect(en["run.resources.kicker"]).toBe("Support details");
    expect(ja["run.resources.kicker"]).toBe("サポート詳細");
    expect(runViewSource).not.toContain("change.before");
    expect(runViewSource).not.toContain("change.after");
  });

  test("does not render an empty diagnostics card on normal run reviews", () => {
    expect(runViewSource).toContain("const diagnosticRows = createMemo");
    expect(runViewSource).toContain("const showDiagnosticsPanel = createMemo");
    expect(runViewSource).toContain("<Show when={showDiagnosticsPanel()}>");
    expect(runViewSource).not.toContain(
      '<p class="muted">{t("run.diagnostics.empty")}</p>',
    );
  });

  test("keeps the copy explicit that credentials are not displayed", () => {
    expect(en["run.connections.reviewBody"].toLowerCase()).toContain(
      "credential values are not shown",
    );
    expect(en["run.connections.reviewBody"]).not.toContain(
      "will use these external service connections",
    );
    expect(ja["run.connections.reviewBody"]).toContain(
      "認証情報の値は表示しません",
    );
  });

  test("keeps paid billing recovery Cloud-only on blocked run reviews", () => {
    expect(runViewSource).toContain("isTakosumiCloudRuntime");
    expect(runViewSource).toContain('href="/billing"');
    expect(runViewSource).toContain('"run.cost.billingCta"');
    expect(runViewSource).toContain('"run.cost.operatorHelp"');
    expect(en["run.cost.billingCta"]).toContain("billing");
    expect(en["run.cost.operatorHelp"]).toContain("admin");
    expect(ja["run.cost.billingCta"]).toContain("お支払い");
    expect(ja["run.cost.operatorHelp"]).toContain("管理者");
  });
});
