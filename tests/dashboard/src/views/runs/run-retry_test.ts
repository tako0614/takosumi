/**
 * "Try again" plans a failed run again as the same change it was made for,
 * on the run page and the app page alike — never whatever the Source's
 * default ref holds for an installed app.
 */
import { describe, expect, test } from "bun:test";
import {
  retryChangeForRun,
  retryPlanForRun,
  type RetryPlanApi,
} from "../../../../../dashboard/src/lib/run-retry.ts";
import type { Capsule, Run } from "../../../../../dashboard/src/lib/control-api.ts";

function recorder(runs: Readonly<Record<string, Run>> = {}) {
  const calls: string[] = [];
  const api: RetryPlanApi = {
    getRun: async (id) => {
      calls.push(`read ${id}`);
      const found = runs[id];
      if (!found) throw new Error(`no run ${id}`);
      return found;
    },
    destroyPlanCapsule: async (id) => { calls.push(`destroy ${id}`); return { run: { id: "run_destroy" } }; },
    planCapsule: async (id, options) => { calls.push(`plan ${id} ${options.compatibilityReportId}`); return { run: { id: "run_plan" } }; },
    planRevision: async (id, ref) => { calls.push(`revision ${id} ${ref}`); return "run_revision"; },
    planRollback: async (stateVersionId) => { calls.push(`rollback ${stateVersionId}`); return { run: { id: "run_rollback" } }; },
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
const plan = (origin: Run["origin"]): Run =>
  run({ id: "run_plan_failed", type: "plan", status: "succeeded", ...(origin ? { origin } : {}) });

describe("retryPlanForRun", () => {
  test("a failed removal is retried as a removal", async () => {
    for (const type of ["destroy_plan", "destroy_apply"] as const) {
      const { api, calls } = recorder();
      expect(await retryPlanForRun(run({ type }), capsule(), api)).toBe("run_destroy");
      expect(calls).toEqual(["destroy cap_a"]);
    }
  });

  test("a failed version change plans the same ref again, never the default ref", async () => {
    const { api, calls } = recorder({ run_plan_failed: plan({ kind: "revision", ref: "v2" }) });
    expect(await retryPlanForRun(run({ planRunId: "run_plan_failed" }), capsule(), api)).toBe("run_revision");
    expect(calls).toEqual(["read run_plan_failed", "revision cap_a v2"]);
  });

  test("a failed rollback goes back to the same version again", async () => {
    const { api, calls } = recorder({ run_plan_failed: plan({ kind: "rollback", stateVersionId: "sv_1" }) });
    expect(await retryPlanForRun(run({ planRunId: "run_plan_failed" }), capsule(), api)).toBe("run_rollback");
    expect(calls).toEqual(["read run_plan_failed", "rollback sv_1"]);
  });

  test("a policy-blocked plan repeats its own change", async () => {
    const { api, calls } = recorder();
    await retryPlanForRun(run({ type: "plan", status: "succeeded", origin: { kind: "revision", ref: "release/v3" } }), capsule(), api);
    expect(calls).toEqual(["revision cap_a release/v3"]);
  });

  test("a failed settings change, or a plan with no recorded origin, re-plans the installed version as configured", async () => {
    const { api, calls } = recorder({
      run_settings: { ...plan({ kind: "configuration" }), id: "run_settings" },
      run_legacy: { ...plan(undefined), id: "run_legacy" },
    });
    await retryPlanForRun(run({ planRunId: "run_settings" }), capsule(), api);
    await retryPlanForRun(run({ planRunId: "run_legacy" }), capsule(), api);
    await retryPlanForRun(run({}), capsule(), api);
    expect(calls).toEqual(["read run_settings", "rollback sv_2", "read run_legacy", "rollback sv_2", "rollback sv_2"]);
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

  test("refuses a run from another app or workspace, a stale first-install plan, and an app with no installed version", async () => {
    const { api, calls } = recorder();
    await expect(retryPlanForRun(run({ capsuleId: "cap_b" }), capsule(), api)).rejects.toMatchObject({ code: "retry_plan_identity_mismatch" });
    await expect(retryPlanForRun(run({ workspaceId: "ws_b" }), capsule(), api)).rejects.toMatchObject({ code: "retry_plan_identity_mismatch" });
    await expect(
      retryPlanForRun(run({ type: "plan", baseStateGeneration: 0 }), capsule(), api),
    ).rejects.toMatchObject({ code: "retry_plan_review_mismatch" });
    expect(() =>
      retryChangeForRun({ run: run({}), capsule: capsule({ currentStateVersionId: undefined }) }),
    ).toThrow();
    expect(calls).toEqual([]);
  });
});
