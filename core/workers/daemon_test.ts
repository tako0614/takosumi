import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createRevokeDebtCleanupWorkerTask,
  WorkerDaemon,
} from "./daemon.ts";

test("WorkerDaemon runOnce ticks each configured task once", async () => {
  const calls: string[] = [];
  const daemon = new WorkerDaemon({
    tasks: [
      { name: "apply", intervalMs: 100, tick: () => calls.push("apply") },
      { name: "outbox", intervalMs: 100, tick: () => calls.push("outbox") },
      {
        name: "registry-sync",
        intervalMs: 100,
        tick: () => calls.push("registry-sync"),
      },
    ],
  });

  const results = await daemon.runOnce();

  assert.deepEqual(
    calls.sort(),
    ["apply", "outbox", "registry-sync"].sort(),
  );
  assert.equal(results.length, 3);
  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(results.map((result) => result.iteration), [0, 0, 0]);
});

test("WorkerDaemon applies backoff after failed ticks and stops on cancellation", async () => {
  const controller = new AbortController();
  const slept: number[] = [];
  const errors: unknown[] = [];
  let calls = 0;
  const daemon = new WorkerDaemon({
    signal: controller.signal,
    sleep: (ms) => {
      slept.push(ms);
      controller.abort("test complete");
      return Promise.resolve();
    },
    onError: (error) => errors.push(error),
    tasks: [
      {
        name: "flaky",
        intervalMs: 10,
        backoffBaseMs: 25,
        maxBackoffMs: 100,
        tick: () => {
          calls += 1;
          throw new Error("boom");
        },
      },
    ],
  });

  const handle = daemon.start();
  const results = await handle.completed;

  assert.equal(calls, 1);
  assert.deepEqual(slept, [25]);
  assert.equal(errors.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].consecutiveFailures, 1);
  assert.equal(results[0].nextDelayMs, 25);
});

test("createRevokeDebtCleanupWorkerTask adapts the cleanup worker", async () => {
  const calls: string[] = [];
  const revokeDebtTask = createRevokeDebtCleanupWorkerTask({
    intervalMs: 1,
    limit: 3,
    ownerSpaces: () => ["space:one", "space:two"],
    worker: {
      processOwnerSpace: (input) => {
        calls.push(`revoke-debt:${input.ownerSpaceId}:${input.limit}`);
        return Promise.resolve({
          ownerSpaceId: input.ownerSpaceId,
          scanned: 0,
          aged: 0,
          attempted: 0,
          cleared: 0,
          retrying: 0,
          operatorActionRequired: 0,
          skipped: 0,
          attempts: [],
        });
      },
    },
  });

  const results = await new WorkerDaemon({
    tasks: [revokeDebtTask],
    now: () => new Date("2026-04-30T00:00:00.000Z"),
  }).runOnce();

  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(
    calls.sort(),
    [
      "revoke-debt:space:one:3",
      "revoke-debt:space:two:3",
    ].sort(),
  );
});
