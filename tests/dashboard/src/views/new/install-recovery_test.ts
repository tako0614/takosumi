import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ControlApiError,
  ControlApiIndeterminateError,
  isMutationOutcomeUnknown,
} from "../../../../../dashboard/src/lib/control-api.ts";
import {
  installPlanAttemptFailureAction,
  installPlanRecoveryId,
  hasInstallPlanRecoveryLocator,
  installPlanRecoveryMatchesIdentity,
  installPlanRecoverySearch,
  isPendingInstallWorkspaceSelected,
  pendingInstallRecoveryAction,
  pendingInstallResumeCompletion,
  pendingInstallRunIdForSelectedWorkspace,
  shouldKeepInstallAttemptAfterFailure,
} from "../../../../../dashboard/src/views/new/install-recovery.ts";

const root = resolve(import.meta.dir, "../../../../../");
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");

test("recovery query retains only one validated opaque install plan id", () => {
  const search = installPlanRecoverySearch("gip_0123456789abcdef");
  expect(search).toBe("?installPlan=gip_0123456789abcdef");
  expect(installPlanRecoveryId(search)).toBe("gip_0123456789abcdef");
  expect(
    installPlanRecoveryId(
      "?installPlan=bad&installPlan=gip_0123456789abcdef",
    ),
  ).toBeUndefined();
  expect(installPlanRecoveryId("?installPlan=gip_0123456789ABCDEF")).toBeUndefined();
  expect(hasInstallPlanRecoveryLocator("?installPlan=invalid")).toBe(true);
  expect(hasInstallPlanRecoveryLocator("?git=https%3A%2F%2Fexample.test")).toBe(false);
  expect(() => installPlanRecoverySearch("not-a-plan-id")).toThrow();
});

test("recovery plan readback must match the selected Workspace and Principal", () => {
  const response = {
    installPlan: {
      id: "gip_0123456789abcdef",
      workspaceId: "ws_selected",
      createdBy: "principal_current",
    },
  } as Parameters<typeof installPlanRecoveryMatchesIdentity>[0];
  expect(
    installPlanRecoveryMatchesIdentity(
      response,
      "ws_selected",
      "principal_current",
    ),
  ).toBe(true);
  expect(
    installPlanRecoveryMatchesIdentity(
      response,
      "ws_other",
      "principal_current",
    ),
  ).toBe(false);
  expect(
    installPlanRecoveryMatchesIdentity(
      response,
      "ws_selected",
      "principal_other",
    ),
  ).toBe(false);
});

test("an acknowledged attempt reloads by GET and advances only on explicit Continue", () => {
  const view = read("dashboard/src/views/new/InstallView.tsx");
  const recordStart = view.indexOf("const recordInstallPlanProgress =");
  const recordEnd = view.indexOf("const showReviewableInstallPlan", recordStart);
  const recordProgress = view.slice(recordStart, recordEnd);
  const loadStart = view.indexOf("const loadInstallPlanRecovery =");
  const loadEnd = view.indexOf("const publishInstallPlanRecoveryLocator", loadStart);
  const loadRecovery = view.slice(loadStart, loadEnd);
  const continueStart = view.indexOf("const continueInstallPlanRecovery =");
  const continueEnd = view.indexOf("const recoveryResponse", continueStart);
  const continueRecovery = view.slice(continueStart, continueEnd);
  const recoveryStart = view.indexOf("const installPlanRecoveryView =");
  const recoveryEnd = view.indexOf("const continueAfterConnections", recoveryStart);
  const recoveryView = view.slice(recoveryStart, recoveryEnd);

  expect(recordProgress.indexOf("installPlanRecoveryMatchesIdentity(")).toBeLessThan(
    recordProgress.indexOf("publishInstallPlanRecoveryLocator(response.installPlan.id)"),
  );
  expect(recordProgress).toContain("setPendingInstallAttempt((current) =>");
  expect(recordProgress).not.toContain("attempt.request,");
  expect(recordProgress).not.toContain("attempt.idempotencyKey,");
  expect(loadRecovery).toContain("getGitInstallPlan(planId, { signal })");
  expect(loadRecovery).toContain("installPlanRecoveryMatchesIdentity(");
  expect(loadRecovery).not.toContain("reconcileGitInstallPlan(");
  expect(view).toContain("createEffect(() => {\n    const search = location.search;");
  expect(continueRecovery).toContain("state.response.nextAction !== \"reconcile\"");
  expect(continueRecovery).toContain("await reconcileGitInstallPlan(planId)");
  expect(continueRecovery).not.toContain("createReviewableGitInstallPlan(");
  expect(recoveryView).toContain('data-testid="install-plan-recovery"');
  expect(recoveryView).toContain('data-testid="install-plan-recovery-phase"');
  expect(recoveryView).toContain("plan.diagnostic?.message");
  expect(recoveryView).toContain('response.nextAction === "review_run"');
  expect(recoveryView).toContain("/runs/${encodeURIComponent(plan.planRunId!)}");
  expect(recoveryView).toContain('response.nextAction === "reconcile"');

  const knownIdResumeStart = view.indexOf(
    "if (attempt.installPlanId) {",
    view.indexOf("const resumePendingInstallPlan = async"),
  );
  const newAttemptPost = view.indexOf(
    "const resumedResponse = await createReviewableGitInstallPlan",
    knownIdResumeStart,
  );
  expect(knownIdResumeStart).toBeGreaterThan(0);
  expect(view.slice(knownIdResumeStart, newAttemptPost)).toContain(
    "await reconcileGitInstallPlan(attempt.installPlanId)",
  );
  expect(view.slice(knownIdResumeStart, newAttemptPost)).not.toContain(
    "createReviewableGitInstallPlan(",
  );
});

test("install mutation uncertainty includes indeterminate, 5xx, and transport failures", () => {
  expect(
    isMutationOutcomeUnknown(
      new ControlApiIndeterminateError(
        "source_patch",
        "the acknowledgement was lost",
      ),
    ),
  ).toBe(true);
  expect(isMutationOutcomeUnknown(new ControlApiError(503, "unavailable", "retry later"))).toBe(true);
  expect(isMutationOutcomeUnknown(new TypeError("fetch failed"))).toBe(true);
  expect(isMutationOutcomeUnknown(new ControlApiError(409, "conflict", "rejected"))).toBe(false);
  expect(
    shouldKeepInstallAttemptAfterFailure(
      new ControlApiIndeterminateError(
        "source_patch",
        "the acknowledgement was lost",
      ),
    ),
  ).toBe(true);
  expect(shouldKeepInstallAttemptAfterFailure(new ControlApiError(503, "unavailable", "retry later"))).toBe(true);
  expect(shouldKeepInstallAttemptAfterFailure(new ControlApiError(409, "conflict", "rejected"))).toBe(false);
});

test("a delayed old-workspace Plan response stays pending instead of promoting into the new workspace", async () => {
  let selectedWorkspace = "ws_old";
  let phase: "preparing" | "review" | "pending-timeout" = "preparing";
  let finishResume!: (value: "review_run") => void;
  const resume = new Promise<"review_run">((resolve) => { finishResume = resolve; });
  const completion = resume.then((nextAction) => {
    const result = pendingInstallResumeCompletion(
      "ws_old",
      selectedWorkspace,
      selectedWorkspace,
      nextAction,
    );
    phase = result.phase;
    return result.action;
  });

  selectedWorkspace = "ws_new";
  finishResume("review_run");

  await expect(completion).resolves.toBe("workspace-mismatch");
  expect(phase).toBe("pending-timeout");
});

test("resume is not allowed to POST until the captured Workspace is explicitly selected", () => {
  expect(isPendingInstallWorkspaceSelected("ws_old", "ws_new", "ws_new")).toBe(false);
  expect(isPendingInstallWorkspaceSelected("ws_old", "ws_old", "ws_old")).toBe(true);
});

test("an existing Plan link is only exposed while viewing its attempt Workspace", () => {
  expect(
    pendingInstallRunIdForSelectedWorkspace("plan_a", "ws_a", "ws_b", "ws_b"),
  ).toBeUndefined();
  expect(
    pendingInstallRunIdForSelectedWorkspace("plan_a", "ws_a", "ws_a", "ws_a"),
  ).toBe("plan_a");
  expect(
    pendingInstallRunIdForSelectedWorkspace(undefined, "ws_a", "ws_a", "ws_a"),
  ).toBeUndefined();
});

test("a 5xx keeps the exact acknowledged attempt identity and idempotency key", () => {
  const attempt = {
    workspaceId: "ws_1",
    idempotencyKey: "install-key-1",
    installPlanId: "gip_known",
    capsuleId: "cap_known",
    planRunId: "plan_known",
  };
  const action = installPlanAttemptFailureAction(
    attempt,
    attempt,
    new ControlApiError(503, "unavailable", "response lost after commit"),
  );
  expect(action).toBe("retain");
  expect(attempt.idempotencyKey).toBe("install-key-1");
  expect(attempt.installPlanId).toBe("gip_known");
  expect(attempt.planRunId).toBe("plan_known");
  expect(
    installPlanAttemptFailureAction(
      attempt,
      { ...attempt, idempotencyKey: "replacement-key" },
      new ControlApiError(503, "unavailable", "late failure"),
    ),
  ).toBe("stale");
});

test("a reconcile 409 preserves a known coordinator while a definite create 409 can clear", () => {
  const acknowledged = {
    idempotencyKey: "same-key",
    installPlanId: "gip_known",
  };
  expect(
    installPlanAttemptFailureAction(
      acknowledged,
      acknowledged,
      new ControlApiError(409, "reconcile_in_progress", "already running"),
    ),
  ).toBe("retain");
  expect(
    installPlanAttemptFailureAction(
      { idempotencyKey: "same-key" },
      { idempotencyKey: "same-key" },
      new ControlApiError(409, "install_conflict", "create rejected"),
    ),
  ).toBe("clear");
});

test("a reviewable Plan only promotes when both Workspace scopes still match", () => {
  expect(
    pendingInstallRecoveryAction("ws_1", "ws_1", "ws_1", "review_run"),
  ).toBe("show-review");
  expect(
    pendingInstallRecoveryAction("ws_1", "ws_1", "ws_2", "review_run"),
  ).toBe("workspace-mismatch");
  expect(
    pendingInstallRecoveryAction("ws_1", "ws_2", "ws_1", "review_run"),
  ).toBe("workspace-mismatch");
});
