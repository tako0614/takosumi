/**
 * Structural invariants of the attempt-driven install page (TASK-0115). The
 * behavior of each state lives in install-attempt_test.ts and the
 * controller's requests in install-attempt-controller_test.ts; these checks
 * pin what must never come back into the page's sources.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../");
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");
const view = read("dashboard/src/views/new/InstallView.tsx");
const sheet = read("dashboard/src/views/new/InstallSheet.tsx");
const controller = read("dashboard/src/views/new/use-install-attempt.ts");
const state = read("dashboard/src/views/new/install-attempt.ts");
const pageSources = [view, sheet, controller, state];

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("attempt-driven install page", () => {
  test("routes every install entry to the one /new view", () => {
    const router = read("dashboard/src/index.tsx");
    expect(router).toContain('const InstallView = lazy(() => import("./views/new/InstallView.tsx"))');
    expect(router).toContain('<Route path="/new" component={NewRoute} />');
    expect(router).toContain("<InstallView />");
    expect(router).toContain('<Route path="/install" component={InstallEntryRoute} />');
    expect(router).toContain('<Route path="/store" component={() => <RedirectWithQuery to="/new" />} />');
    expect(router).not.toContain("NewAppView");
  });

  test("opening a page creates nothing: an attempt starts only from Install or Start over", () => {
    // The only POST that creates an attempt…
    expect(controller.match(/createGitInstallAttempt\(/gu)).toHaveLength(1);
    const post = between(controller, "const postAttempt = async", "const adoptNewAttempt =");
    expect(post).toContain("createGitInstallAttempt(workspaceId, request, key)");
    // …is reached from the Install action, from starting over and from
    // preparing again after a change, nowhere else.
    const callers = controller.match(/await postAttempt\(/gu) ?? [];
    expect(callers).toHaveLength(3);
    expect(between(controller, "const start = async", "const resume = () =>")).toContain("await postAttempt(");
    expect(between(controller, "const restart = async", "const reload = async")).toContain("await postAttempt(");
    expect(between(controller, "const replan = async", "// A complete sheet is confirmed")).toContain("await postAttempt(");
    // Preparing again runs for an out-of-date Plan (once per edit, never
    // while typing or with an invalid name), from Continue after it failed,
    // and from Start over with the answers kept.
    const replanEffect = between(controller, "// An out-of-date Plan is prepared again", "// Preparing again ends");
    expect(replanEffect).toContain("if (!outdated() || locked() || replanStalled()) return;");
    expect(replanEffect).toContain("editing() || nameInvalid() || version <= replannedVersion");
    expect(replanEffect).toContain("void replan();");
    const resume = between(controller, "const resume = () =>", "/** One PATCH");
    expect(resume.match(/void replan\(\)/gu)).toHaveLength(2);
    expect(between(controller, "const restart = async", "const reload = async")).toContain("if (sheet()) return await replan();");
    expect(controller.match(/void replan\(\)/gu)).toHaveLength(3);
    expect(view).toContain("void attempt.start(");
    expect(view.match(/attempt\.start\(/gu)).toHaveLength(1);
    // Starting an install never creates a Workspace as a side effect.
    expect(controller).not.toContain("createWorkspace");
    expect(controller).not.toContain("ensureWorkspace");
    expect(post).toContain("createGitInstallAttempt(workspaceId, request, key)");
  });

  test("nothing applies from the page: the review's explicit click is the only apply", () => {
    for (const source of pageSources) {
      expect(source).not.toContain("createApplyRun");
      expect(source).not.toContain("approveRun");
      expect(source).not.toMatch(/auto=|autoApply|auto-apply/u);
    }
    expect(sheet).toContain("<InstallExecution");
    const execution = read("dashboard/src/views/new/InstallExecution.tsx");
    const install = between(execution, "const install = async", "// Apply starts only from");
    expect(install).toContain("createApplyRun(runId()");
    // An out-of-date Plan is never applied, nor approved.
    expect(install).toContain("if (props.blockedReason ||");
    expect(between(execution, "const approve = async", "const install = async")).toContain("if (props.blockedReason) return;");
    // A failed Plan links to its run for the reason and logs.
    expect(sheet).toContain("href={`/runs/${encodeURIComponent(runId())}`}");
    expect(execution.match(/void install\(\)/gu)).toHaveLength(1);
    // Once an Apply started, the screen's answers are locked.
    expect(sheet).toContain("onApplyStarted={() => props.attempt.lockAnswers()}");
    expect(execution).toContain("if (hasSeenApply() || applying() || applyUnconfirmed()) props.onApplyStarted?.();");
    // Before the Plan, 「許可してインストール」 is shown (focusable, with its
    // reason) but does nothing.
    const preview = between(sheet, "function PlanPreview(", "function PlanReview(");
    expect(preview).toContain('aria-disabled="true"');
    expect(preview).toContain("aria-describedby={block() ? APPLY_REASON_ID : undefined}");
    expect(preview).toContain("onClick={(event) => event.preventDefault()}");
    expect(preview).not.toContain("confirm(");
  });

  test("inputs and secrets never reach the URL or browser storage", () => {
    for (const source of pageSources) {
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("sessionStorage");
      expect(source).not.toContain("indexedDB");
    }
    // The URL changes only by adding or removing the attempt id.
    expect(view.match(/navigate\(/gu)?.length).toBeGreaterThan(0);
    for (const call of view.match(/navigate\([^;]*/gu) ?? []) {
      expect(call).not.toMatch(/drafts|variables|value/u);
    }
    expect(between(state, "export function withInstallAttempt(", "/** The query without")).toContain("params.set(ATTEMPT_PARAM, attemptId)");
  });

  test("setting values leave memory only inside the confirming answer", () => {
    // `variables` is sent by exactly one request: the continue answer.
    const confirm = between(controller, "const confirm = async", "/** 「やめる」");
    expect(confirm).toContain("continue: true,");
    expect(confirm).toContain("variables: values.variables");
    const outsideConfirm = controller.replace(confirm, "");
    expect(outsideConfirm).not.toMatch(/variables:/u);
    // Secret fields are write-only and start empty.
    expect(sheet).toContain('type={variable().sensitive ? "password"');
    expect(sheet).toContain('autocomplete={variable().sensitive ? "new-password" : "off"}');
    // A secret JSON value is a standard password field too, never a textarea
    // masked by a non-standard style that some engines ignore.
    expect(sheet).toContain('<Match when={variable().type === "json" && !variable().sensitive}>');
    expect(pageSources.join("\n")).not.toContain("text-security");
    expect(read("dashboard/src/views/new/install-view.css")).not.toContain("text-security");
  });

  test("a reopened review prefers current Interface display names and retains an id fallback", () => {
    expect(sheet).toContain('link.displayName || link.choice.interfaceId');
  });

  test("a reopened review asks the app where it stands before offering the apply", () => {
    const review = between(sheet, "function PlanReview(", "export function InstallScreen(");
    expect(review).toContain("getCapsuleApp(capsuleId)");
    expect(review.indexOf("<Show\n        when={!app.loading}")).toBeLessThan(review.indexOf("<InstallExecution"));
    expect(review).toContain("if (app()?.applied) props.onDone(props.action.capsuleId);");
    expect(review).toContain("view?.progress.run ?? view?.latestRun");
    expect(review).toContain("showPolicyReasons");
  });

  test("installed apps are linked at /apps/:id", () => {
    for (const source of pageSources) expect(source).not.toContain("/workloads/");
    expect(view).toContain("href={appPageHref(done().capsuleId)}");
  });

  test("only two decisions: the screen asks for no next click between them", () => {
    // No separate review or module confirmation button remains.
    expect(sheet).not.toContain("installStore.reviewChanges");
    expect(sheet).not.toContain("installStore.moduleConfirm");
    // The confirmation is sent on its own (once per attempt and edit) or by
    // 「続ける」 on a paused install, never by another button.
    expect(controller.match(/void confirm\(\)/gu)).toHaveLength(2);
    const auto = between(controller, "// A complete sheet is confirmed", "// An out-of-date Plan is prepared again");
    expect(auto).toContain("if (!armed() ||");
    expect(auto).toContain("if (autoSentFor === key) return;");
    expect(between(controller, "const resume = () =>", "/** One PATCH")).toContain("void confirm()");
    expect(sheet.match(/\.confirm\(/gu)).toBeNull();
  });

  test("discarding never runs alongside another request", () => {
    const discard = between(controller, "const discard = async", "const restart = async");
    expect(discard).toContain("if (!current || mutating()) return false;");
    expect(discard.indexOf("await stopDriving()")).toBeLessThan(discard.indexOf("discardInstallAttempt("));
    // Stopping aborts the reconcile in flight instead of waiting it out.
    expect(between(controller, "const halt = () =>", "onCleanup(")).toContain("driveAbort?.abort();");
    expect(controller).toContain("reconcileGitInstallPlan(before.installPlan.id, { signal: controller.signal })");
  });

  test("the legacy client orchestration is gone", () => {
    for (const path of [
      "dashboard/src/views/new/InstallLifecycle.tsx",
      "dashboard/src/views/new/install-lifecycle.ts",
      "dashboard/src/views/new/install-helpers.ts",
      "dashboard/src/views/new/install-simplification.css",
      "dashboard/src/lib/install-plan-attempt.ts",
      "dashboard/src/lib/install-recovery.ts",
      "dashboard/src/lib/accepted-initial-install-plan.ts",
      "dashboard/src/lib/auto-apply-consent.ts",
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
    const api = read("dashboard/src/lib/control-api.ts");
    for (const removed of [
      "createReviewableGitInstallPlan",
      "checkCapsuleCompatibility",
      "prepareCapsuleSourceSnapshot",
      "listSourceSnapshotInstallModules",
      "export async function createSource(",
      "export async function deleteSource(",
    ]) {
      expect(api).not.toContain(removed);
    }
    for (const source of pageSources) {
      expect(source).not.toContain("patchSource");
      expect(source).not.toContain("abandonUnappliedCapsule");
      expect(source).not.toContain("autoSync");
    }
  });

  test("the Store page keeps search, the Git form and the unfinished installs", () => {
    expect(view).toContain('class="iv-hero iv-page-heading"');
    expect(view).toContain('class="iv-catalogue iv-catalogue-browse"');
    expect(view).toContain('aria-label={t("installStore.sourceUrl")}');
    expect(view).toContain("<OpenAttempts principalId={props.principalId} />");
    expect(view).toContain("listOpenGitInstallAttempts(scope.workspaceId)");
    // Selecting a listing reflects it into the URL so back and share work.
    expect(view).toContain("navigate(`/new?${buildNewQuery(listing)}`);");
  });

  test("the not-installed page has one Install and lets the person choose the version", () => {
    const candidate = between(view, '<Match when={stage() === "candidate" || stage() === "starting"}>', "</Match>");
    expect(candidate.match(/variant="primary"/gu)).toHaveLength(1);
    expect(candidate).toContain('t("installStore.install")');
    expect(candidate).toContain('t("installStore.startHint")');
    expect(candidate).toContain('label={t("installStore.sourceRef")}');
    expect(view).toContain('data-testid="install-provenance"');
    expect(view).toContain('if (installedApps.state !== "ready") return;');
    expect(candidate).toContain('disabled={!gitUrl() || installedApps.state !== "ready"');
    expect(view).toContain('readyOrUndefined(connections)');
  });
});
