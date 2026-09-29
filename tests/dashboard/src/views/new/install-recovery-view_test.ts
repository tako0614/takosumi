import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("reload resumes an acknowledged coordinator by read-only GET", () => {
  const view = read("dashboard/src/views/new/InstallView.tsx");
  const load = view.slice(view.indexOf("const loadRecovery ="), view.indexOf("const continueRecovery ="));
  expect(load).toContain("getGitInstallPlan(id, { signal })");
  expect(load).toContain("const epoch = recoveryFence.begin();");
  expect(load).toContain("recoveryFence.isCurrent(epoch)");
  expect(load).toContain("installRecoveryMatches(response, id, workspace, props.installingPrincipalId)");
  expect(load).toContain("const search = location.search;");
  expect(load).toContain("const workspace = currentWorkspaceId();");
  expect(load).toContain("onCleanup(() => controller.abort());");
  expect(load).not.toContain("reconcileGitInstallPlan(");
  expect(load).not.toContain("createApplyRun(");

  const resume = view.slice(view.indexOf("const continueRecovery ="), view.indexOf("const clearRecovery ="));
  expect(resume).toContain('state.response.nextAction !== "reconcile"');
  expect(resume).toContain("await reconcileGitInstallPlan(id)");
  expect(resume).not.toContain("createApplyRun(");
  expect(view).toContain('data-testid="install-plan-recovery"');
  expect(view).toContain('presentation === "failed" ? t("installStore.recoveryFailed")');
  expect(view).toContain('presentation === "failed_run" ? t("installStore.recoveryFailedRun")');
  expect(view).toContain('presentation === "review" ? t("installStore.recoveryReview")');
  const recoveryView = view.slice(view.indexOf('data-testid="install-plan-recovery"'), view.indexOf('<Show when={!hasInstallRecoveryLocator'));
  expect(recoveryView).not.toContain('<h2>{t("installStore.preparing")}</h2>');
  expect(recoveryView).toContain('<Show when={presentation === "failed_run"}>');
  expect(recoveryView).toContain('href={`/runs/${encodeURIComponent(response.installPlan.planRunId!)}`}');
});

test("accepted initial review does not offer a revision Plan as recovery", () => {
  const view = read("dashboard/src/views/apps/WorkloadDetailView.tsx");
  expect(view).toContain("acceptedInitialInstallPlan(");
  expect(view).toContain("config.id !== inst.installConfigId || initialReviewRequired()");
  expect(view).toContain("if (!sourceRevisionReady()) {");
  expect(view).toContain("<Show when={!props.initialReviewRequired}>");
  expect(view).toContain('href={`/runs/${encodeURIComponent(run().id)}`}');
});
