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

test("an unfinished install continues in place from its saved settings, never through a revision Plan", () => {
  const page = read("dashboard/src/views/app/AppManagePage.tsx");
  // Version and settings changes exist only for an applied app.
  expect(page).toContain("const managed = () => applied() && !destroyed();");
  expect(page).toContain("const revisionReady = () => {");
  expect(page).toContain("return managed() && typeof ref === \"string\"");
  // Continuing plans the app as configured and opens the in-page install
  // review; the old `/new?capsule=` locator now redirects to the app page.
  const continueInstall = page.slice(page.indexOf("const continueInstall = () =>"), page.indexOf("const [screenRetryBusy"));
  expect(continueInstall).toContain('"install",');
  expect(continueInstall).toContain("extractRunId(await planCapsule(capsuleId()))");
  expect(page).not.toContain("/new?capsule=");
  expect(read("dashboard/src/lib/app-page.ts")).toContain('return "app.problem.continueInstall";');
});
