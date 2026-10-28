import { describe, expect, test } from "bun:test";
import { runGroupFailures } from "../../../../dashboard/src/lib/run-group-failures.ts";

describe("runGroupFailures", () => {
  test("returns only recognized Capsule failures and skips Capsules with Runs", () => {
    const graph = JSON.stringify({
      order: [["cap_failed", "cap_with_run", "cap_unknown"]],
      runs: { cap_with_run: "plan_12345678" },
      failures: {
        cap_failed: "dependency_retired",
        cap_with_run: "dependency_retired",
        cap_unknown: "some_future_reason",
      },
    });

    expect(runGroupFailures(graph, ["cap_with_run"])).toEqual([
      { capsuleId: "cap_failed", reason: "dependency_retired" },
    ]);
  });

  test("legacy, absent, malformed, and invalid failure data are harmless", () => {
    for (const value of [
      undefined,
      null,
      1,
      "not-json",
      JSON.stringify({ order: [["cap_legacy"]], runs: {} }),
      JSON.stringify({ failures: null }),
      JSON.stringify({ failures: [] }),
      JSON.stringify({ failures: { "": "dependency_retired", cap_bad: 5 } }),
    ]) {
      expect(runGroupFailures(value)).toEqual([]);
    }
  });
});
