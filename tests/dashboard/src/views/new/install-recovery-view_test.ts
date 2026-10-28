import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("reopening an attempt from its URL is a read-only GET", () => {
  const controller = read("dashboard/src/views/new/use-install-attempt.ts");
  const load = controller.slice(
    controller.indexOf("// The URL names the attempt; reading it never advances or answers it."),
    controller.indexOf("/** A pause between reconcile commands"),
  );
  expect(load).toContain("getGitInstallPlan(attemptId)");
  expect(load).toContain("expected !== epoch");
  expect(load).not.toContain("reconcileGitInstallPlan(");
  expect(load).not.toContain("answerGitInstallAttempt(");
  expect(load).not.toContain("discardGitInstallAttempt(");
  expect(load).not.toContain("createGitInstallAttempt(");
  expect(load).not.toContain("drive()");
  // Advancing an attempt is the person's explicit Continue or a request made
  // in this page view, never a side effect of reading it.
  const resume = controller.slice(
    controller.indexOf("const resume = () =>"),
    controller.indexOf("/** One PATCH;"),
  );
  expect(resume).toContain("drive();");
  expect(read("dashboard/src/views/new/InstallView.tsx")).toContain("onClick={() => props.attempt.resume()}");
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
