/**
 * Per-app scheduled sweep unit tests (Core Specification §28
 * `scheduled/drift.ts`; §19 drift_check; TASK-0118 stage 9.1). The sweep takes
 * a narrow operations stub, so these assert that each live app is handled on
 * its own (stale auto-plan, drift check), that nothing groups apps by
 * Workspace, that one failing app never aborts the page, and that the page is
 * only reserved while a step is enabled.
 *
 * The flag parsers (TAKOSUMI_AUTO_PLAN_STALE_CAPSULES /
 * TAKOSUMI_DRIFT_CHECK_ENABLED) are covered in the platform worker test.
 */

import { expect, test } from "bun:test";
import type { Run } from "takosumi-contract/runs";
import {
  CAPSULE_SWEEP_PAGE_LIMIT,
  type CapsuleSweepCapsule,
  type CapsuleSweepOperations,
  DRIFT_CHECK_SYSTEM_ACTOR,
  STALE_AUTO_PLAN_SYSTEM_ACTOR,
  sweepCapsules,
} from "../../../../worker/src/scheduled/drift.ts";

interface Recorded {
  readonly listCalls: number[];
  readonly planRunReads: {
    capsuleId: string;
    workspaceId: string;
    types: readonly string[];
    limit: number;
  }[];
  readonly plans: {
    capsuleId: string;
    actor: string;
    actorOwnershipEpoch?: number;
    origin: unknown;
  }[];
  readonly driftChecks: { capsuleId: string; actor: string; actorOwnershipEpoch?: number }[];
  readonly activity: string[];
}

type Owner = { ownerAccountId: string; ownershipEpoch: number; managementState: string };

function makeOps(input: {
  readonly capsules: readonly CapsuleSweepCapsule[];
  readonly owners?: Readonly<Record<string, Owner>>;
  readonly runs?: Readonly<Record<string, readonly Pick<Run, "type" | "status">[]>>;
  readonly failOn?: ReadonlySet<string>;
}): { ops: CapsuleSweepOperations; recorded: Recorded } {
  const recorded: Recorded = {
    listCalls: [],
    planRunReads: [],
    plans: [],
    driftChecks: [],
    activity: [],
  };
  const ops: CapsuleSweepOperations = {
    listCapsulesForScheduledSweep: (limit) => {
      recorded.listCalls.push(limit);
      return Promise.resolve(input.capsules.slice(0, limit));
    },
    getOwnership: (capsuleId) => Promise.resolve(input.owners?.[capsuleId]),
    listCapsuleRuns: (capsule, { types, limit }) => {
      recorded.planRunReads.push({
        capsuleId: capsule.id,
        workspaceId: capsule.workspaceId,
        types,
        limit,
      });
      return Promise.resolve(
        (input.runs?.[capsule.id] ?? []).filter((run) =>
          (types as readonly string[]).includes(run.type)
        ),
      );
    },
    createCapsulePlan: (capsuleId, options) => {
      if (input.failOn?.has(capsuleId)) return Promise.reject(new Error("plan failed"));
      recorded.plans.push({
        capsuleId,
        actor: options.actor,
        ...(options.actorOwnershipEpoch !== undefined
          ? { actorOwnershipEpoch: options.actorOwnershipEpoch }
          : {}),
        origin: options.origin,
      });
      return Promise.resolve({});
    },
    createCapsuleDriftCheck: (capsuleId, options) => {
      if (input.failOn?.has(capsuleId)) return Promise.reject(new Error("drift failed"));
      recorded.driftChecks.push({
        capsuleId,
        actor: options.actor,
        ...(options.actorOwnershipEpoch !== undefined
          ? { actorOwnershipEpoch: options.actorOwnershipEpoch }
          : {}),
      });
      return Promise.resolve({});
    },
    recordStaleAutoPlan: (capsule) => {
      recorded.activity.push(capsule.id);
      return Promise.resolve();
    },
  };
  return { ops, recorded };
}

const both = { autoPlanStale: true, driftCheck: true } as const;

test("each app is handled on its own, never grouped by Workspace", async () => {
  const { ops, recorded } = makeOps({
    capsules: [
      { id: "cap_stale_a", workspaceId: "ws_a", status: "stale" },
      { id: "cap_active_a", workspaceId: "ws_a", status: "active" },
      { id: "cap_stale_b", workspaceId: "ws_b", status: "stale" },
      { id: "cap_active_c", workspaceId: "ws_c", status: "active" },
    ],
    owners: {
      cap_stale_a: { ownerAccountId: "acct_a", ownershipEpoch: 3, managementState: "active" },
      cap_active_a: { ownerAccountId: "acct_a", ownershipEpoch: 1, managementState: "active" },
      cap_stale_b: { ownerAccountId: "acct_b", ownershipEpoch: 0, managementState: "active" },
    },
  });
  const result = await sweepCapsules(ops, both);
  expect(recorded.listCalls).toEqual([CAPSULE_SWEEP_PAGE_LIMIT]);
  // The owner actor carries the ownership epoch it was read at, so a transfer
  // before creation is refused instead of recording the previous owner.
  expect(recorded.plans).toEqual([
    { capsuleId: "cap_stale_a", actor: "acct_a", actorOwnershipEpoch: 3, origin: { kind: "update" } },
    { capsuleId: "cap_stale_b", actor: "acct_b", actorOwnershipEpoch: 0, origin: { kind: "update" } },
  ]);
  // A legacy app without an owner row keeps a system actor (no epoch).
  expect(recorded.driftChecks).toEqual([
    { capsuleId: "cap_active_a", actor: "acct_a", actorOwnershipEpoch: 1 },
    { capsuleId: "cap_active_c", actor: DRIFT_CHECK_SYSTEM_ACTOR },
  ]);
  // Open Runs are read per app (with that app's own Workspace column only):
  // plans for a stale app, drift checks for an active one.
  expect(recorded.planRunReads.map(({ capsuleId, workspaceId, types }) => [capsuleId, workspaceId, types]))
    .toEqual([
      ["cap_stale_a", "ws_a", ["plan"]],
      ["cap_active_a", "ws_a", ["drift_check"]],
      ["cap_stale_b", "ws_b", ["plan"]],
      ["cap_active_c", "ws_c", ["drift_check"]],
    ]);
  expect(recorded.activity).toEqual(["cap_stale_a", "cap_stale_b"]);
  expect(result).toEqual({ scanned: 4, plansCreated: 2, driftChecksCreated: 2 });
});

test("a stale app with an open update plan gets no second plan", async () => {
  const { ops, recorded } = makeOps({
    capsules: [
      { id: "cap_queued", workspaceId: "ws_a", status: "stale" },
      { id: "cap_waiting", workspaceId: "ws_a", status: "stale" },
      { id: "cap_running", workspaceId: "ws_a", status: "stale" },
      { id: "cap_done", workspaceId: "ws_a", status: "stale" },
    ],
    runs: {
      cap_queued: [{ type: "plan", status: "queued" }],
      cap_waiting: [{ type: "plan", status: "waiting_approval" }],
      cap_running: [{ type: "plan", status: "running" }],
      // Finished plans and other Run types do not block a new plan.
      cap_done: [
        { type: "plan", status: "succeeded" },
        { type: "plan", status: "failed" },
        { type: "drift_check", status: "queued" },
      ],
    },
  });
  const result = await sweepCapsules(ops, { autoPlanStale: true, driftCheck: false });
  expect(recorded.plans).toEqual([
    { capsuleId: "cap_done", actor: STALE_AUTO_PLAN_SYSTEM_ACTOR, origin: { kind: "update" } },
  ]);
  expect(result).toEqual({ scanned: 4, plansCreated: 1, driftChecksCreated: 0 });
});

test("an active app with a queued or running drift check gets no second one", async () => {
  const { ops, recorded } = makeOps({
    capsules: [
      { id: "cap_queued", workspaceId: "ws_a", status: "active" },
      { id: "cap_running", workspaceId: "ws_a", status: "active" },
      { id: "cap_done", workspaceId: "ws_a", status: "active" },
    ],
    runs: {
      cap_queued: [{ type: "drift_check", status: "queued" }],
      cap_running: [{ type: "drift_check", status: "running" }],
      // Finished drift checks and other Run types do not block a new check.
      cap_done: [
        { type: "drift_check", status: "succeeded" },
        { type: "drift_check", status: "failed" },
        { type: "plan", status: "queued" },
      ],
    },
  });
  const result = await sweepCapsules(ops, { autoPlanStale: false, driftCheck: true });
  expect(recorded.driftChecks).toEqual([
    { capsuleId: "cap_done", actor: DRIFT_CHECK_SYSTEM_ACTOR },
  ]);
  expect(result).toEqual({ scanned: 3, plansCreated: 0, driftChecksCreated: 1 });
});

test("an app whose management is not active takes no system work", async () => {
  const { ops, recorded } = makeOps({
    capsules: [
      { id: "cap_stale", workspaceId: "ws_a", status: "stale" },
      { id: "cap_active", workspaceId: "ws_a", status: "active" },
    ],
    owners: {
      cap_stale: { ownerAccountId: "acct_a", ownershipEpoch: 1, managementState: "transferring" },
      cap_active: { ownerAccountId: "acct_a", ownershipEpoch: 1, managementState: "draining" },
    },
  });
  const result = await sweepCapsules(ops, both);
  expect(recorded.plans).toEqual([]);
  expect(recorded.driftChecks).toEqual([]);
  expect(recorded.planRunReads).toEqual([]);
  expect(result).toEqual({ scanned: 2, plansCreated: 0, driftChecksCreated: 0 });
});

test("each flag gates only its own step", async () => {
  const capsules = [
    { id: "cap_stale", workspaceId: "ws_a", status: "stale" },
    { id: "cap_active", workspaceId: "ws_a", status: "active" },
  ] as const;
  const driftOnly = makeOps({ capsules });
  await sweepCapsules(driftOnly.ops, { autoPlanStale: false, driftCheck: true });
  expect(driftOnly.recorded.plans).toEqual([]);
  // Drift checks only active apps: a stale app has a newer Source to plan.
  expect(driftOnly.recorded.driftChecks.map((call) => call.capsuleId)).toEqual(["cap_active"]);

  const planOnly = makeOps({ capsules });
  await sweepCapsules(planOnly.ops, { autoPlanStale: true, driftCheck: false });
  expect(planOnly.recorded.plans.map((call) => call.capsuleId)).toEqual(["cap_stale"]);
  expect(planOnly.recorded.driftChecks).toEqual([]);
});

test("one failing app does not abort the rest of the page", async () => {
  const { ops, recorded } = makeOps({
    capsules: [
      { id: "cap_bad_plan", workspaceId: "ws_a", status: "stale" },
      { id: "cap_bad_drift", workspaceId: "ws_a", status: "active" },
      { id: "cap_good_plan", workspaceId: "ws_a", status: "stale" },
      { id: "cap_good_drift", workspaceId: "ws_a", status: "active" },
    ],
    failOn: new Set(["cap_bad_plan", "cap_bad_drift"]),
  });
  const result = await sweepCapsules(ops, both);
  expect(recorded.plans.map((call) => call.capsuleId)).toEqual(["cap_good_plan"]);
  expect(recorded.driftChecks.map((call) => call.capsuleId)).toEqual(["cap_good_drift"]);
  expect(result).toEqual({ scanned: 4, plansCreated: 1, driftChecksCreated: 1 });
});

test("a failing Activity write still counts the created plan", async () => {
  const { ops, recorded } = makeOps({
    capsules: [{ id: "cap_stale", workspaceId: "ws_a", status: "stale" }],
  });
  const result = await sweepCapsules(
    { ...ops, recordStaleAutoPlan: () => Promise.reject(new Error("activity down")) },
    { autoPlanStale: true, driftCheck: false },
  );
  expect(recorded.plans.map((call) => call.capsuleId)).toEqual(["cap_stale"]);
  expect(result.plansCreated).toBe(1);
});

test("with both flags off or a non-positive limit no page is reserved", async () => {
  const off = makeOps({ capsules: [{ id: "cap_a", workspaceId: "ws_a", status: "active" }] });
  expect(await sweepCapsules(off.ops, { autoPlanStale: false, driftCheck: false }))
    .toEqual({ scanned: 0, plansCreated: 0, driftChecksCreated: 0 });
  expect(off.recorded.listCalls).toEqual([]);
  for (const limit of [0, -1, Number.NaN]) {
    const empty = makeOps({ capsules: [{ id: "cap_a", workspaceId: "ws_a", status: "active" }] });
    expect(await sweepCapsules(empty.ops, { ...both, limit }))
      .toEqual({ scanned: 0, plansCreated: 0, driftChecksCreated: 0 });
    expect(empty.recorded.listCalls).toEqual([]);
  }
});

test("the given page limit is pushed down to the reservation", async () => {
  const { ops, recorded } = makeOps({
    capsules: [
      { id: "cap_a", workspaceId: "ws_a", status: "active" },
      { id: "cap_b", workspaceId: "ws_b", status: "active" },
      { id: "cap_c", workspaceId: "ws_c", status: "active" },
    ],
  });
  const result = await sweepCapsules(ops, { ...both, limit: 2 });
  expect(recorded.listCalls).toEqual([2]);
  expect(result).toEqual({ scanned: 2, plansCreated: 0, driftChecksCreated: 2 });
});
