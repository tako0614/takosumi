import { describe, expect, test } from "bun:test";

import { canCancelRun } from "../../../../dashboard/src/lib/run-cancel.ts";
import type { Run } from "../../../../dashboard/src/lib/control-api.ts";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    type: "apply",
    status: "queued",
    createdBy: "user_1",
    createdAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  } as Run;
}

describe("shared cancel-eligibility predicate (run view ↔ run API)", () => {
  test("a running apply is NOT cancellable", () => {
    // The live defect: apply_ebe44829d77e4e04 sat in `running` for ~29 minutes
    // while the dashboard offered Cancel, and every click came back 409
    // (`apply run ... is running; only queued runs can be cancelled, and only
    // before they start`).
    expect(
      canCancelRun(
        run({
          type: "apply",
          status: "running",
          startedAt: "2026-09-29T00:04:00.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      canCancelRun(
        run({
          type: "destroy_apply",
          status: "running",
          startedAt: "2026-09-29T00:04:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  test("a queued apply that has never started is cancellable", () => {
    expect(canCancelRun(run({ status: "queued" }))).toBe(true);
    expect(canCancelRun(run({ type: "destroy_apply", status: "queued" }))).toBe(
      true,
    );
  });

  test("a queued apply that already ran is NOT cancellable", () => {
    // A runner-infrastructure failure deliberately requeues the SAME ApplyRun
    // after it started; the backend keeps that row fail-closed (retained
    // provider/lifecycle evidence), so `queued` alone is not enough.
    expect(
      canCancelRun(
        run({ status: "queued", startedAt: "2026-09-29T00:04:00.000Z" }),
      ),
    ).toBe(false);
    expect(
      canCancelRun(
        run({
          type: "destroy_apply",
          status: "queued",
          startedAt: "2026-09-29T00:04:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  test("terminal applies are NOT cancellable", () => {
    for (const status of [
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ] as const) {
      expect(
        canCancelRun(
          run({ status, startedAt: "2026-09-29T00:04:00.000Z" }),
        ),
      ).toBe(false);
    }
  });

  test("a plan parked in waiting_approval stays cancellable", () => {
    // The plan branch accepts `waiting_approval` regardless of `startedAt`: a
    // parked review keeps its historical cancellation semantics.
    expect(
      canCancelRun(
        run({
          type: "plan",
          status: "waiting_approval",
          startedAt: "2026-09-29T00:04:00.000Z",
          requiresApproval: true,
        }),
      ),
    ).toBe(true);
    expect(
      canCancelRun(
        run({
          type: "destroy_plan",
          status: "waiting_approval",
          startedAt: "2026-09-29T00:04:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  test("a running plan is NOT cancellable", () => {
    expect(
      canCancelRun(
        run({
          type: "plan",
          status: "running",
          startedAt: "2026-09-29T00:04:00.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      canCancelRun(
        run({
          type: "drift_check",
          status: "running",
          startedAt: "2026-09-29T00:04:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  test("a queued plan is cancellable only before it starts", () => {
    expect(canCancelRun(run({ type: "plan", status: "queued" }))).toBe(true);
    expect(
      canCancelRun(run({ type: "drift_check", status: "queued" })),
    ).toBe(true);
    expect(
      canCancelRun(
        run({
          type: "plan",
          status: "queued",
          startedAt: "2026-09-29T00:04:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  test("a settled review is not cancellable — it is a deploy candidate", () => {
    expect(
      canCancelRun(
        run({
          type: "plan",
          status: "succeeded",
          policyStatus: "pass",
          startedAt: "2026-09-29T00:04:00.000Z",
          finishedAt: "2026-09-29T00:05:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  test("run kinds the cancel route rejects are never offered a cancel", () => {
    // `#cancelRun` falls through to "run <id> is not a cancellable plan or
    // apply run" for these ledgers, so a queued row must not show the control.
    for (const type of [
      "source_sync",
      "compatibility_check",
      "backup",
      "restore",
      "artifact",
    ] as const) {
      expect(canCancelRun(run({ type, status: "queued" }))).toBe(false);
      expect(canCancelRun(run({ type, status: "running" }))).toBe(false);
    }
  });
});
