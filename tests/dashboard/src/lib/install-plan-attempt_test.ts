import { expect, test } from "bun:test";
import type { CreateGitInstallPlanRequest } from "../../../../contract/index.ts";
import {
  getOrCreateInstallPlanAttempt,
  installPlanAttemptRequest,
} from "../../../../dashboard/src/lib/install-plan-attempt.ts";

function request(): CreateGitInstallPlanRequest {
  return {
    source: {
      name: "example",
      url: "https://example.test/app.git",
      ref: "main",
      path: ".",
    },
    capsule: { name: "example", environment: "production" },
    options: { modulePath: ".", providerBindings: [] },
    preflight: {
      sourceId: "src_1",
      sourceSnapshotId: "snap_1",
      compatibilityCheckRunId: "ccr_1",
      compatibilityReportId: "caprep_1",
      installConfigId: "cfg_1",
    },
    variables: { region: "initial" },
  };
}

test("retains exact body and key without retaining mutable caller objects", () => {
  const input = request();
  const attempt = getOrCreateInstallPlanAttempt(undefined, "ws_1", input);
  const wireBody = JSON.stringify(input);
  Object.assign(input.variables!, { region: "changed" });
  const decoded = installPlanAttemptRequest(attempt);
  Object.assign(decoded.preflight!, { compatibilityCheckRunId: "ccr_2" });
  expect(JSON.stringify(installPlanAttemptRequest(attempt))).toBe(wireBody);
  expect(getOrCreateInstallPlanAttempt(attempt, "ws_1", request())).toBe(attempt);
});

test("new evidence, input or workspace never reuses the previous key", () => {
  const attempt = getOrCreateInstallPlanAttempt(undefined, "ws_1", request());
  for (const changed of [
    {
      ...request(),
      preflight: {
        ...request().preflight!,
        compatibilityCheckRunId: "ccr_2",
        compatibilityReportId: "caprep_2",
      },
    },
    { ...request(), variables: { region: "changed" } },
  ]) {
    const next = getOrCreateInstallPlanAttempt(attempt, "ws_1", changed);
    expect(next.idempotencyKey).not.toBe(attempt.idempotencyKey);
    expect(installPlanAttemptRequest(next)).toEqual(changed);
  }
  expect(getOrCreateInstallPlanAttempt(attempt, "ws_2", request()).idempotencyKey)
    .not.toBe(attempt.idempotencyKey);
});
