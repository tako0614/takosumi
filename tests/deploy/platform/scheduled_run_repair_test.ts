import { expect, test } from "bun:test";

import {
  drainScheduledWorkItems,
  repairStaleOpenTofuRuns,
} from "../../../deploy/platform/worker.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import type { Run } from "takosumi-contract/runs";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");

function queuedApply(id: string, workspaceId: string): Run {
  return {
    id,
    workspaceId,
    type: "apply",
    status: "queued",
    createdAt: new Date(NOW - 600_000).toISOString(),
  } as Run;
}

/**
 * Pages a seeded run list the way the store does: the cursor is the index of
 * the last SCANNED row, `nextCursor` absent once the scan wraps.
 */
function pagingController(runs: readonly Run[]) {
  const cursors = new Map<string, string>();
  return {
    controller: {
      getSweepCursor: (name: string) => Promise.resolve(cursors.get(name)),
      putSweepCursor: (name: string, cursor: string | undefined) => {
        if (cursor === undefined) cursors.delete(name);
        else cursors.set(name, cursor);
        return Promise.resolve();
      },
      listRecoverableOpenTofuRuns: (options: {
        readonly limit?: number;
        readonly cursor?: string;
      }) => {
        const start = options.cursor === undefined ? 0 : Number(options.cursor);
        const limit = options.limit ?? 500;
        const page = runs.slice(start, start + limit);
        const nextCursor =
          start + limit < runs.length ? String(start + limit) : undefined;
        return Promise.resolve({
          runs: page,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        });
      },
    },
    cursors,
  };
}

test("run repair drains a backlog larger than one tick across rotating pages", async () => {
  // 5 runs across 5 DIFFERENT workspaces — under the old oldest-100-workspace
  // window a run's rescue depended on its workspace's age; now every run is
  // reached by rotation regardless of how many workspaces exist.
  const runs = Array.from({ length: 5 }, (_, index) =>
    queuedApply(`apply_${index}`, `ws_${index}`),
  );
  const { controller, cursors } = pagingController(runs);
  const operations = {
    workspaces: { getWorkspace: (id: string) => Promise.resolve({ id }) },
    controller: controller.constructor === Object ? controller : controller,
  };
  const scheduled: string[] = [];
  const scheduler = {
    schedule: (dispatch: { readonly runId: string }) => {
      scheduled.push(dispatch.runId);
      return Promise.resolve();
    },
  };

  const tick1 = await repairStaleOpenTofuRuns(
    { workspaces: operations.workspaces, controller },
    scheduler,
    { now: NOW, runLimit: 2 },
  );
  expect(tick1).toMatchObject({ runsScanned: 2, rescheduled: 2, wrapped: false });
  expect(cursors.get("run_repair")).toBe("2");

  const tick2 = await repairStaleOpenTofuRuns(
    { workspaces: operations.workspaces, controller },
    scheduler,
    { now: NOW, runLimit: 2 },
  );
  expect(tick2).toMatchObject({ runsScanned: 2, rescheduled: 2, wrapped: false });

  const tick3 = await repairStaleOpenTofuRuns(
    { workspaces: operations.workspaces, controller },
    scheduler,
    { now: NOW, runLimit: 2 },
  );
  expect(tick3).toMatchObject({ runsScanned: 1, rescheduled: 1, wrapped: true });
  // The wrapped scan cleared the cursor: the next tick restarts from the top.
  expect(cursors.has("run_repair")).toBe(false);
  expect(scheduled).toEqual([
    "apply_0",
    "apply_1",
    "apply_2",
    "apply_3",
    "apply_4",
  ]);
});

test("one failing dispatch is counted and does not abort the rest of the tick", async () => {
  const runs = [
    queuedApply("apply_ok_1", "ws_a"),
    queuedApply("apply_broken", "ws_a"),
    queuedApply("apply_ok_2", "ws_a"),
  ];
  const { controller } = pagingController(runs);
  const scheduled: string[] = [];
  const result = await repairStaleOpenTofuRuns(
    {
      workspaces: { getWorkspace: (id: string) => Promise.resolve({ id }) },
      controller,
    },
    {
      schedule: (dispatch) => {
        if (dispatch.runId === "apply_broken") {
          return Promise.reject(new Error("run owner unavailable"));
        }
        scheduled.push(dispatch.runId);
        return Promise.resolve();
      },
    },
    { now: NOW },
  );
  expect(scheduled).toEqual(["apply_ok_1", "apply_ok_2"]);
  expect(result).toMatchObject({
    runsScanned: 3,
    rescheduled: 2,
    failures: 1,
    wrapped: true,
  });
});

test("a missing or archived workspace skips its runs without failing the tick", async () => {
  const runs = [
    queuedApply("apply_live", "ws_live"),
    queuedApply("apply_gone", "ws_deleted"),
  ];
  const { controller } = pagingController(runs);
  const scheduled: string[] = [];
  const result = await repairStaleOpenTofuRuns(
    {
      workspaces: {
        getWorkspace: (id: string) =>
          id === "ws_deleted"
            ? Promise.reject(new Error("workspace not found"))
            : Promise.resolve({ id }),
      },
      controller,
    },
    {
      schedule: (dispatch) => {
        scheduled.push(dispatch.runId);
        return Promise.resolve();
      },
    },
    { now: NOW },
  );
  expect(scheduled).toEqual(["apply_live"]);
  expect(result).toMatchObject({ rescheduled: 1, skipped: 1, failures: 0 });
});

test("work item drain completes handled intents and retries failed ones", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const nowIso = new Date(NOW).toISOString();
  await store.enqueueWorkItem({
    id: "wi_ok",
    kind: "capsule.deferred_destroy",
    dueAt: nowIso,
    now: nowIso,
  });
  await store.enqueueWorkItem({
    id: "wi_flaky",
    kind: "capsule.deferred_destroy",
    dueAt: nowIso,
    now: nowIso,
  });
  const handled: string[] = [];
  const result = await drainScheduledWorkItems(
    { controller: store },
    {
      "capsule.deferred_destroy": (item) => {
        if (item.id === "wi_flaky") {
          return Promise.reject(new Error("destroy plan creation failed"));
        }
        handled.push(item.id);
        return Promise.resolve();
      },
    },
    { now: NOW },
  );
  expect(handled).toEqual(["wi_ok"]);
  expect(result).toEqual({ claimed: 2, completed: 1, failed: 1 });

  // The failed intent is rescheduled with a delay, not lost and not dead.
  const backlogSoon = await store.countWorkItemBacklog(
    new Date(NOW + 60_000).toISOString(),
  );
  expect(backlogSoon).toEqual({});
  const backlogLater = await store.countWorkItemBacklog(
    new Date(NOW + 30 * 60_000).toISOString(),
  );
  expect(backlogLater).toEqual({ "capsule.deferred_destroy": 1 });
});

test("a drain with no registered handlers claims nothing", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const nowIso = new Date(NOW).toISOString();
  await store.enqueueWorkItem({
    id: "wi_idle",
    kind: "capsule.deferred_destroy",
    dueAt: nowIso,
    now: nowIso,
  });
  expect(await drainScheduledWorkItems({ controller: store }, {}, { now: NOW }))
    .toEqual({ claimed: 0, completed: 0, failed: 0 });
  expect(await store.countWorkItemBacklog(nowIso)).toEqual({
    "capsule.deferred_destroy": 1,
  });
});
