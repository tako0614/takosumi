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
    expect(runViewSource).toContain('t("run.connections.reviewTitle")');
    expect(runViewSource).toContain(
      '<summary>{t("run.connections.reviewTitle")}</summary>',
    );
    expect(runViewSource).toContain("listProviderConnections");
    expect(runViewSource).toContain("providerConnectionsForRun");
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
    expect(runViewSource).not.toContain("change.before");
    expect(runViewSource).not.toContain("change.after");
  });

  test("keeps the copy explicit that credentials are not displayed", () => {
    expect(en["run.connections.reviewBody"].toLowerCase()).toContain(
      "credential values are not shown",
    );
    expect(ja["run.connections.reviewBody"]).toContain(
      "認証情報の値は表示しません",
    );
  });

  test("gives blocked billing runs a recovery path from the review screen", () => {
    expect(runViewSource).toContain('href="/billing"');
    expect(runViewSource).toContain('"run.cost.billingCta"');
    expect(en["run.cost.billingCta"]).toContain("billing");
    expect(ja["run.cost.billingCta"]).toContain("お支払い");
  });
});
