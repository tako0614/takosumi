/**
 * Drift sweep unit tests (Core Specification §28 `scheduled/drift.ts`; §19
 * drift_check; Phase 8). The sweep is best-effort + bounded and takes a narrow
 * operations stub, so these assert: a bounded fan-out (one workspace_drift_check
 * RunGroup per Workspace with active Capsules up to the limit), a failing Workspace
 * does not abort the sweep, and a non-positive limit is a no-op.
 *
 * The flag-off no-op (TAKOSUMI_DRIFT_CHECK_ENABLED unset) is enforced at the
 * wiring boundary in deploy/platform/worker.ts; the sweep itself is only called
 * when enabled. A non-positive `limit` exercises the sweep's own guard here, and
 * the platform driftCheckEnabled() gate is covered in the platform worker test.
 */

import { expect, test } from "bun:test";
import {
  driftSweep,
  type DriftSweepOperations,
} from "../../../../worker/src/scheduled/drift.ts";

function makeOps(
  overrides: {
    active?: readonly { id: string; workspaceId: string }[];
    failOn?: ReadonlySet<string>;
  } = {},
): {
  ops: DriftSweepOperations;
  listCalls: number[];
  driftCalls: { workspaceId: string; limit?: number }[];
} {
  const listCalls: number[] = [];
  const driftCalls: { workspaceId: string; limit?: number }[] = [];
  const ops: DriftSweepOperations = {
    listActiveCapsules: (limit) => {
      listCalls.push(limit);
      const active = overrides.active ?? [
        { id: "cap_a", workspaceId: "ws_a" },
        { id: "cap_b", workspaceId: "ws_a" },
      ];
      return Promise.resolve(active.slice(0, limit));
    },
    createWorkspaceDriftCheck: (workspaceId, options) => {
      driftCalls.push({ workspaceId, limit: options?.limit });
      if (overrides.failOn?.has(workspaceId)) {
        return Promise.reject(new Error("nope"));
      }
      return Promise.resolve({});
    },
  };
  return { ops, listCalls, driftCalls };
}

test("drift sweep creates one RunGroup per Workspace, bounded by Capsule limit", async () => {
  const { ops, listCalls, driftCalls } = makeOps({
    active: [
      { id: "cap_a", workspaceId: "ws_a" },
      { id: "cap_b", workspaceId: "ws_a" },
      { id: "cap_c", workspaceId: "ws_b" },
    ],
  });
  const result = await driftSweep(ops, { limit: 2 });
  // The limit is pushed down to the listing so the fan-out is bounded.
  expect(listCalls).toEqual([2]);
  expect(driftCalls).toEqual([{ workspaceId: "ws_a", limit: 2 }]);
  expect(result).toEqual({ scanned: 2, checked: 2 });
});

test("drift sweep uses the default limit when none is given", async () => {
  const { ops, listCalls } = makeOps({ active: [] });
  await driftSweep(ops);
  expect(listCalls).toEqual([20]);
});

test("drift sweep continues past a failing Workspace", async () => {
  const { ops, driftCalls } = makeOps({
    active: [
      { id: "cap_a", workspaceId: "ws_a" },
      { id: "cap_b", workspaceId: "ws_b" },
    ],
    failOn: new Set(["ws_a"]),
  });
  const result = await driftSweep(ops, { limit: 20 });
  // Both Workspaces are attempted; only the non-failing one is counted.
  expect(driftCalls).toEqual([
    { workspaceId: "ws_a", limit: 1 },
    { workspaceId: "ws_b", limit: 1 },
  ]);
  expect(result).toEqual({ scanned: 2, checked: 1 });
});

test("drift sweep is a no-op for a non-positive limit (never lists or checks)", async () => {
  const { ops, listCalls, driftCalls } = makeOps();
  const result = await driftSweep(ops, { limit: 0 });
  expect(listCalls).toEqual([]);
  expect(driftCalls).toEqual([]);
  expect(result).toEqual({ scanned: 0, checked: 0 });
});
