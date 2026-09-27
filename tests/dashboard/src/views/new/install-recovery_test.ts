import { expect, test } from "bun:test";
import {
  ControlApiError,
  ControlApiIndeterminateError,
  isMutationOutcomeUnknown,
} from "../../../../../dashboard/src/lib/control-api.ts";
import {
  isPendingInstallWorkspaceSelected,
  pendingInstallRecoveryAction,
  pendingInstallResumeCompletion,
  retainedPendingInstallAttempt,
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
  const retained = retainedPendingInstallAttempt(
    attempt,
    attempt,
    new ControlApiError(503, "unavailable", "response lost after commit"),
  );
  expect(retained).toBe(attempt);
  expect(retained?.idempotencyKey).toBe("install-key-1");
  expect(retained?.installPlanId).toBe("gip_known");
  expect(retained?.planRunId).toBe("plan_known");
  expect(
    retainedPendingInstallAttempt(
      attempt,
      { ...attempt, idempotencyKey: "replacement-key" },
      new ControlApiError(503, "unavailable", "late failure"),
    ),
  ).toBeUndefined();
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
