import { expect, test } from "bun:test";
import {
  ControlApiError,
  ControlApiIndeterminateError,
  isMutationOutcomeUnknown,
} from "../../../../../dashboard/src/lib/control-api.ts";
import {
  installPlanAttemptFailureAction,
  isPendingInstallWorkspaceSelected,
  pendingInstallRecoveryAction,
  pendingInstallResumeCompletion,
  shouldKeepInstallAttemptAfterFailure,
} from "../../../../../dashboard/src/views/new/install-recovery.ts";

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
