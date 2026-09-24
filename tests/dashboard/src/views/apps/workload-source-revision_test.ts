import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const viewSource = readFileSync(
  new URL(
    "../../../../../dashboard/src/views/apps/WorkloadDetailView.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("Workload revisions use the Capsule-local coordinator and applied provenance", () => {
  expect(viewSource).toContain("createReviewableGitRevisionPlan(");
  expect(viewSource).toContain("adoptedSourceRevision");
  expect(viewSource).toContain("revisionAttempts");
  expect(viewSource).toContain("revisionActionBusy");
  expect(viewSource).toContain("if (revisionActionBusy())");
  expect(viewSource).toContain(
    "reviewBusy={plan.busy() || revisionActionBusy()}",
  );
  expect(viewSource).toContain("idempotencyKey");
  expect(viewSource).toContain(
    'disabled={props.reviewBusy || !props.sourceRevisionReady}',
  );
  expect(viewSource).toContain(
    '<summary>{t("app.deploys.sourceVersionChange")}</summary>',
  );
  expect(viewSource).toContain('t("app.deploys.sourceVersionCurrent")');
  expect(viewSource).toContain('t("app.deploys.sourceVersionApply")');
  expect(viewSource).not.toContain("updateCapsuleSourceRevision(");
  expect(viewSource).not.toContain("sourceImpact");
  expect(viewSource).not.toContain("affectedSourceCapsules");
  expect(viewSource).not.toContain("source_membership_changed");
  expect(viewSource).not.toContain("isImmutableSourceRevision");
  expect(viewSource).not.toContain("authConnectionId");
  expect(viewSource).not.toContain("credential");
});

test("revision copy accepts backend-safe refs instead of requiring immutable commits", () => {
  for (const dictionary of [en, ja]) {
    expect(dictionary["app.deploys.sourceVersionHint"]).toMatch(
      /branch|ブランチ/iu,
    );
    expect(dictionary["app.deploys.sourceVersionHint"]).toMatch(
      /tag|タグ/iu,
    );
    expect(dictionary["app.deploys.sourceVersionHint"]).not.toMatch(/40/iu);
    expect(dictionary["app.deploys.sourceVersionChange"]).toBeTruthy();
    expect(dictionary["app.deploys.sourceVersionApply"]).toBeTruthy();
  }
});
