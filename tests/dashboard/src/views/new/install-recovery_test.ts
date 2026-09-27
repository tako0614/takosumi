import { expect, test } from "bun:test";
import {
  ControlApiError,
  ControlApiIndeterminateError,
  isMutationOutcomeUnknown,
} from "../../../../../dashboard/src/lib/control-api.ts";
import {
  pendingInstallRecoveryAction,
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
  let finishRead!: (value: "review_run") => void;
  const read = new Promise<"review_run">((resolve) => { finishRead = resolve; });
  const completion = read.then((nextAction) =>
    pendingInstallRecoveryAction(
      "ws_old",
      selectedWorkspace,
      selectedWorkspace,
      nextAction,
    ),
  );

  selectedWorkspace = "ws_new";
  finishRead("review_run");

  await expect(completion).resolves.toBe("workspace-mismatch");
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
