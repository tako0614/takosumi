import { describe, expect, test } from "bun:test";
import type { Capsule, InstallConfig, Run } from "../../../../dashboard/src/lib/control-api.ts";
import { acceptedInitialInstallPlan } from "../../../../dashboard/src/lib/accepted-initial-install-plan.ts";

const capsule = {
  id: "capsule_one",
  workspaceId: "workspace_one",
  installConfigId: "config_one",
  status: "error",
  currentStateGeneration: 0,
  compatibilityReportId: "report_initial",
} as Capsule;
const config = {
  id: "config_one",
  installExperience: { repositoryInstallUx: { status: "accepted" } },
} as InstallConfig;
const initialRun = {
  id: "plan_original",
  capsuleId: "capsule_one",
  workspaceId: "workspace_one",
  type: "plan",
  status: "succeeded",
  baseStateGeneration: 0,
  sourceSnapshotId: "snapshot_initial",
  compatibilityReportId: "report_initial",
  createdAt: "2026-09-01T00:00:00.000Z",
} as Run;

describe("accepted repository initial install review routing", () => {
  test("links to the earliest exact initial Plan without returning snapshot data", () => {
    const retry = {
      ...initialRun,
      id: "plan_retry",
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const selected = acceptedInitialInstallPlan(
      [retry, initialRun],
      capsule,
      config,
    );

    expect(selected?.id).toBe("plan_original");
    expect(selected).not.toHaveProperty("sourceSnapshotId");
  });

  test("plain Git installs keep the revision path and do not get an initial-plan route", () => {
    expect(
      acceptedInitialInstallPlan(
        [initialRun],
        capsule,
        { installExperience: {} } as InstallConfig,
      ),
    ).toBeUndefined();
  });

  test("workspace, Capsule, report, state, and tied-run ambiguity fail closed", () => {
    expect(
      acceptedInitialInstallPlan(
        [initialRun],
        { ...capsule, workspaceId: "other" },
        config,
      ),
    ).toBeUndefined();
    expect(
      acceptedInitialInstallPlan(
        [{ ...initialRun, compatibilityReportId: "other" }],
        capsule,
        config,
      ),
    ).toBeUndefined();
    expect(
      acceptedInitialInstallPlan(
        [initialRun],
        { ...capsule, currentStateVersionId: "state_applied" },
        config,
      ),
    ).toBeUndefined();
    expect(
      acceptedInitialInstallPlan(
        [initialRun, { ...initialRun, id: "plan_tied" }],
        capsule,
        config,
      ),
    ).toBeUndefined();
  });

  test("a full run-list page is ambiguous because the API has no cursor", () => {
    const runs = Array.from({ length: 500 }, (_, index) => ({
      ...initialRun,
      id: `plan_${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    }));
    expect(acceptedInitialInstallPlan(runs, capsule, config)).toBeUndefined();
  });
});
