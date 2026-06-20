/**
 * extractRunId must recognize every run-creating envelope the dashboard
 * navigates from. Regression: the apply envelope is `{ applyRun: { id } }`
 * (createApplyRun) — when that key was missing from the unwrap list, the run
 * view's deploy() could not navigate to the apply run and left the user on the
 * plan page with a "deploy started" message and no live status.
 */
import { describe, expect, test } from "bun:test";
import { extractRunId } from "../../../../dashboard/src/lib/control-api.ts";

describe("extractRunId", () => {
  test("plan envelope { planRun: { id } }", () => {
    expect(extractRunId({ planRun: { id: "run_plan_1" } })).toBe("run_plan_1");
  });

  test("apply envelope { applyRun: { id } } (regression)", () => {
    expect(extractRunId({ applyRun: { id: "run_apply_1" } })).toBe(
      "run_apply_1",
    );
  });

  test("source-sync envelope { run: { id } }", () => {
    expect(extractRunId({ run: { id: "run_sync_1" } })).toBe("run_sync_1");
  });

  test("bare { id }", () => {
    expect(extractRunId({ id: "run_bare_1" })).toBe("run_bare_1");
  });

  test("non-envelope inputs return undefined", () => {
    expect(extractRunId(null)).toBeUndefined();
    expect(extractRunId(undefined)).toBeUndefined();
    expect(extractRunId("run_x")).toBeUndefined();
    expect(extractRunId({})).toBeUndefined();
    expect(extractRunId({ planRun: {} })).toBeUndefined();
  });
});
