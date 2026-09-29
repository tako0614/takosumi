import { expect, test } from "bun:test";
import type { Capsule, InstallConfig, Run } from "../../../../dashboard/src/lib/control-api.ts";
import { acceptedInitialInstallPlan } from "../../../../dashboard/src/lib/accepted-initial-install-plan.ts";

const capsule = {
  id: "capsule_one", workspaceId: "ws_one", installConfigId: "config_one",
  status: "pending", currentStateGeneration: 0, compatibilityReportId: "report_one",
} as Capsule;
const config = { id: "config_one", installExperience: { repositoryInstallUx: { status: "accepted" } } } as InstallConfig;
const run = {
  id: "plan_0123456789abcdef", capsuleId: "capsule_one", workspaceId: "ws_one", type: "plan",
  baseStateGeneration: 0, sourceSnapshotId: "snapshot_one",
  compatibilityReportId: "report_one", createdAt: "2026-09-01T00:00:00Z",
  createdBy: "git-install-plan:gip_0123456789abcdef",
} as Run;

test("accepted initial install reopens original exact Plan, not a retry", () => {
  expect(acceptedInitialInstallPlan([{ ...run, id: "plan_fedcba9876543210", createdBy: "git-install-plan:gip_fedcba9876543210", createdAt: "2026-09-02T00:00:00Z" }, run], capsule, config))
    .toEqual({ id: "plan_0123456789abcdef" });
});

test("cross-workspace, applied, non-accepted and ambiguous Plans fail closed", () => {
  expect(acceptedInitialInstallPlan([run], { ...capsule, workspaceId: "ws_other" }, config)).toBeUndefined();
  expect(acceptedInitialInstallPlan([{ ...run, createdBy: "git-revision-plan:grp_0123456789abcdef" }], capsule, config)).toBeUndefined();
  expect(acceptedInitialInstallPlan([{ ...run, id: "plan_other" }], capsule, config)).toBeUndefined();
  expect(acceptedInitialInstallPlan([{ ...run, sourceSnapshotId: "" }], capsule, config)).toBeUndefined();
  expect(acceptedInitialInstallPlan([{ ...run, compatibilityReportId: "other" }], capsule, config)).toBeUndefined();
  expect(acceptedInitialInstallPlan([run], { ...capsule, currentStateVersionId: "state_one" }, config)).toBeUndefined();
  expect(acceptedInitialInstallPlan([run], capsule, { ...config, installExperience: {} })).toBeUndefined();
  expect(acceptedInitialInstallPlan([run, {
    ...run, id: "plan_fedcba9876543210",
    createdBy: "git-install-plan:gip_fedcba9876543210",
  }], capsule, config)).toBeUndefined();
  expect(acceptedInitialInstallPlan(Array.from({ length: 500 }, () => run), capsule, config)).toBeUndefined();
});
