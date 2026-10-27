/**
 * "Try again" plans a failed run again with the operation and source it was
 * reviewed for, on the run page and the app page's problem card alike.
 */
import { describe, expect, test } from "bun:test";
import { retryPlanForRun, type RetryPlanApi } from "../../../../../dashboard/src/lib/run-retry.ts";
import type { Capsule, Run } from "../../../../../dashboard/src/lib/control-api.ts";

function recorder() {
  const calls: string[] = [];
  const api: RetryPlanApi = {
    destroyPlanCapsule: async (id) => { calls.push(`destroy ${id}`); return { run: { id: "run_destroy" } }; },
    planCapsule: async (id, options) => { calls.push(`plan ${id} ${options.compatibilityReportId}`); return { run: { id: "run_plan" } }; },
    planCapsuleUpdate: async (id) => { calls.push(`update ${id}`); return { run: { id: "run_update" } }; },
  };
  return { api, calls };
}

const capsule = (patch: Partial<Capsule> = {}): Capsule => ({
  id: "cap_a", workspaceId: "ws_a", name: "a", slug: "a", installConfigId: "cfg_a",
  environment: "production", currentStateGeneration: 2, currentStateVersionId: "sv_2",
  status: "error", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  ...patch,
});
const run = (patch: Partial<Run>): Run => ({
  id: "run_failed", workspaceId: "ws_a", capsuleId: "cap_a", type: "apply", status: "failed",
  createdBy: "sub", createdAt: "2026-10-02T00:00:00Z", baseStateGeneration: 2, ...patch,
});

describe("retryPlanForRun", () => {
  test("a failed removal is retried as a removal", async () => {
    for (const type of ["destroy_plan", "destroy_apply"] as const) {
      const { api, calls } = recorder();
      await retryPlanForRun(run({ type }), capsule(), api);
      expect(calls).toEqual(["destroy cap_a"]);
    }
  });

  test("an installed app's failed change re-reads the latest source", async () => {
    const { api, calls } = recorder();
    await retryPlanForRun(run({ type: "apply" }), capsule(), api);
    await retryPlanForRun(run({ type: "plan" }), capsule(), api);
    expect(calls).toEqual(["update cap_a", "update cap_a"]);
  });

  test("a first install keeps its exact reviewed report", async () => {
    const { api, calls } = recorder();
    await retryPlanForRun(
      run({ type: "apply", baseStateGeneration: 0, compatibilityReportId: "rep_initial" }),
      capsule({ currentStateGeneration: 0, currentStateVersionId: undefined, status: "pending" }),
      api,
    );
    expect(calls).toEqual(["plan cap_a rep_initial"]);
  });

  test("refuses a run from another app or workspace, and a stale first-install plan", async () => {
    const { api, calls } = recorder();
    await expect(retryPlanForRun(run({ capsuleId: "cap_b" }), capsule(), api)).rejects.toMatchObject({ code: "retry_plan_identity_mismatch" });
    await expect(retryPlanForRun(run({ workspaceId: "ws_b" }), capsule(), api)).rejects.toMatchObject({ code: "retry_plan_identity_mismatch" });
    await expect(
      retryPlanForRun(run({ type: "plan", baseStateGeneration: 0 }), capsule(), api),
    ).rejects.toMatchObject({ code: "retry_plan_review_mismatch" });
    expect(calls).toEqual([]);
  });
});
