import { describe, expect, test } from "bun:test";
import { initialPlanRetryReport } from "../../../../dashboard/src/lib/initial-plan-retry.ts";

const run = {
  capsuleId: "capsule_one",
  workspaceId: "workspace_one",
  type: "plan" as const,
  baseStateGeneration: 0,
  sourceSnapshotId: "snapshot_reviewed",
  compatibilityReportId: "report_reviewed",
};
const capsule = {
  id: "capsule_one",
  workspaceId: "workspace_one",
  status: "pending" as const,
  currentStateGeneration: 0,
  compatibilityReportId: "report_reviewed",
};

describe("retry an initial Plan without changing its reviewed source", () => {
  test("a retained never-applied Capsule reuses its exact compatibility report", () => {
    expect(initialPlanRetryReport(run, capsule)).toBe("report_reviewed");
  });

  test("pending reads and mismatched Capsule or Workspace cannot authorize a retry", () => {
    expect(initialPlanRetryReport(run, undefined)).toBeUndefined();
    expect(initialPlanRetryReport(run, { ...capsule, id: "other" }))
      .toBeUndefined();
    expect(initialPlanRetryReport(run, { ...capsule, workspaceId: "other" }))
      .toBeUndefined();
  });

  test("missing or replaced review evidence cannot fall back to a source refresh", () => {
    expect(
      initialPlanRetryReport(
        { ...run, compatibilityReportId: undefined },
        capsule,
      ),
    ).toBeUndefined();
    expect(
      initialPlanRetryReport({ ...run, sourceSnapshotId: undefined }, capsule),
    ).toBeUndefined();
    expect(
      initialPlanRetryReport(run, {
        ...capsule,
        compatibilityReportId: undefined,
      }),
    ).toBeUndefined();
    expect(
      initialPlanRetryReport(run, {
        ...capsule,
        compatibilityReportId: "new_report",
      }),
    ).toBeUndefined();
  });

  test("applied, destroyed, disabled, and ambiguous Capsules are not initial retries", () => {
    expect(
      initialPlanRetryReport({ ...run, baseStateGeneration: 1 }, capsule),
    ).toBeUndefined();
    expect(
      initialPlanRetryReport(
        { ...run, baseStateGeneration: undefined },
        capsule,
      ),
    ).toBeUndefined();
    expect(
      initialPlanRetryReport(run, { ...capsule, currentStateGeneration: 1 }),
    ).toBeUndefined();
    expect(
      initialPlanRetryReport(run, {
        ...capsule,
        currentStateVersionId: "state_one",
      }),
    ).toBeUndefined();
    expect(initialPlanRetryReport(run, { ...capsule, status: "destroyed" }))
      .toBeUndefined();
    expect(initialPlanRetryReport(run, { ...capsule, status: "disabled" }))
      .toBeUndefined();
    expect(initialPlanRetryReport({ ...run, type: "destroy_plan" }, capsule))
      .toBeUndefined();
    expect(initialPlanRetryReport({ ...run, type: "apply" }, capsule))
      .toBeUndefined();
  });
});
