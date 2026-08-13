import { describe, expect, test } from "bun:test";

import {
  awaitsDeployApproval,
  isDeployApprovalCandidate,
  isReviewRun,
} from "../../../../dashboard/src/lib/run-approval.ts";
import type { Run } from "../../../../dashboard/src/lib/control-api.ts";

function planRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_plan",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    type: "plan",
    status: "succeeded",
    policyStatus: "pass",
    createdBy: "user_1",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as Run;
}

function applyRun(overrides: Partial<Run> = {}): Run {
  return planRun({
    id: "run_apply",
    planRunId: "run_plan",
    type: "apply",
    createdAt: "2026-07-01T00:05:00.000Z",
    ...overrides,
  });
}

describe("shared deploy-approval predicate (run list ↔ run view)", () => {
  test("a succeeded policy-pass plan with no later apply awaits approval", () => {
    const plan = planRun();
    expect(isReviewRun(plan)).toBe(true);
    expect(isDeployApprovalCandidate(plan)).toBe(true);
    expect(awaitsDeployApproval(plan, [plan])).toBe(true);
  });

  test("an exact linked apply consumes the approval — even when failed", () => {
    const plan = planRun();
    expect(awaitsDeployApproval(plan, [plan, applyRun()])).toBe(false);
    expect(
      awaitsDeployApproval(plan, [plan, applyRun({ status: "failed" })]),
    ).toBe(false);
    // destroy_apply counts as the corresponding apply of a destroy_plan.
    const destroyPlan = planRun({ type: "destroy_plan" });
    expect(
      awaitsDeployApproval(destroyPlan, [
        destroyPlan,
        applyRun({ type: "destroy_apply" }),
      ]),
    ).toBe(false);
  });

  test("only an exact planRunId consumes approval", () => {
    const plan = planRun();
    expect(
      awaitsDeployApproval(plan, [
        plan,
        applyRun({ capsuleId: "capsule_other" }),
        applyRun({ planRunId: "run_plan_other" }),
      ]),
    ).toBe(true);
    expect(
      awaitsDeployApproval(plan, [plan, applyRun({ planRunId: undefined })]),
    ).toBe(true);
    expect(
      awaitsDeployApproval(plan, [
        plan,
        applyRun({
          planRunId: "run_plan",
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      ]),
    ).toBe(false);
  });

  test("non-candidates never await approval", () => {
    expect(awaitsDeployApproval(planRun({ status: "failed" }), [])).toBe(false);
    expect(awaitsDeployApproval(planRun({ policyStatus: "blocked" }), [])).toBe(
      false,
    );
    expect(awaitsDeployApproval(applyRun(), [])).toBe(false);
    // No resolvable capsule: nothing to key the sibling scan on.
    expect(awaitsDeployApproval(planRun({ capsuleId: undefined }), [])).toBe(
      false,
    );
  });

  test("legacy or missing relation fails closed without a timestamp guess", () => {
    const plan = planRun({ createdAt: "not-a-date" });
    expect(
      awaitsDeployApproval(plan, [
        plan,
        applyRun({
          planRunId: undefined,
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      ]),
    ).toBe(true);
    expect(
      awaitsDeployApproval(plan, [
        plan,
        applyRun({
          planRunId: "legacy_unknown",
          createdAt: "2030-01-01T00:00:00.000Z",
        }),
      ]),
    ).toBe(true);
  });
});
