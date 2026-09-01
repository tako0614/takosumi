import { describe, expect, test } from "bun:test";
import {
  planWorkloadDetailSupplementalReads,
  type WorkloadDetailTab,
} from "../../../../dashboard/src/lib/workload-detail-read-plan.ts";

const applied = {
  capsuleId: "capsule_1",
  workspaceId: "workspace_1",
  currentStateVersionId: "state_1",
} as const;

describe("workload detail supplemental read budget", () => {
  test("loads runtime evidence and usage only on the overview", () => {
    expect(
      planWorkloadDetailSupplementalReads({ tab: "overview", ...applied }),
    ).toEqual({
      stateVersionId: "state_1",
      activityWorkspaceId: "workspace_1",
      usageCapsuleId: "capsule_1",
    });
  });

  test("keeps deploy evidence but defers overview-only usage", () => {
    expect(
      planWorkloadDetailSupplementalReads({ tab: "deploys", ...applied }),
    ).toEqual({
      stateVersionId: "state_1",
      activityWorkspaceId: "workspace_1",
      usageCapsuleId: null,
    });
  });

  test("does not issue hidden supplemental reads on settings or danger", () => {
    for (const tab of ["settings", "danger"] satisfies WorkloadDetailTab[]) {
      expect(planWorkloadDetailSupplementalReads({ tab, ...applied })).toEqual({
        stateVersionId: null,
        activityWorkspaceId: null,
        usageCapsuleId: null,
      });
    }
  });

  test("preserves setup activity only where deploy history consumes it", () => {
    const setup = {
      capsuleId: "capsule_1",
      workspaceId: "workspace_1",
      currentStateVersionId: null,
    } as const;
    expect(
      planWorkloadDetailSupplementalReads({ tab: "overview", ...setup }),
    ).toEqual({
      stateVersionId: null,
      activityWorkspaceId: null,
      usageCapsuleId: "capsule_1",
    });
    expect(
      planWorkloadDetailSupplementalReads({ tab: "deploys", ...setup }),
    ).toEqual({
      stateVersionId: null,
      activityWorkspaceId: "workspace_1",
      usageCapsuleId: null,
    });
  });
});
