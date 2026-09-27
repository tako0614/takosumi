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
  expect(viewSource).toContain("!props.sourceRevisionReady");
  expect(viewSource).toContain("!revisionCandidate()");
  expect(viewSource).toContain('when={!props.revisionReviewBlocked}');
  expect(viewSource).toContain("canReviewSourceRevision(");
  expect(viewSource).toContain("initialInstallConfigDecisionPending()");
  expect(viewSource).toContain("refetchInstallConfig()");
  expect(viewSource).toContain('acceptedInitialInstallPlan(');
  expect(viewSource).toContain("listRuns(workspaceId, INITIAL_PLAN_RUN_LOOKUP_LIMIT)");
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

test("accepted installs preserve the initial Plan instead of offering a revision", () => {
  for (const dictionary of [en, ja]) {
    expect(dictionary["app.setupIncomplete.initialReviewBody"]).toBeTruthy();
    expect(dictionary["app.setupIncomplete.openInitialReview"]).toBeTruthy();
    expect(dictionary["app.deploys.initialReviewTitle"]).toBeTruthy();
  }
  expect(en["app.setupIncomplete.body"]).not.toMatch(/delete|start over/iu);
  expect(ja["app.setupIncomplete.body"]).not.toMatch(/削除|やり直/iu);
  expect(viewSource).toContain("acceptedInitialPlan()");
  expect(viewSource).toContain("app.setupIncomplete.openInitialReview");
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
