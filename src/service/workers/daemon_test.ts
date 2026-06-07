import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createOutboxDispatcherTask,
  createRegistrySyncWorkerTask,
  createRevokeDebtCleanupWorkerTask,
  createRuntimeAgentStaleDetectionTask,
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

test("worker task factories adapt outbox, registry, runtime-agent, and cleanup workers", async () => {
  const calls: string[] = [];
  const outboxTask = createOutboxDispatcherTask({
    intervalMs: 1,
    limit: 2,
    dispatcher: {
      dispatchPending: (options) => {
        calls.push(`outbox:${options?.limit}`);
        return Promise.resolve();
      },
    },
  });
  const registryTask = createRegistrySyncWorkerTask({
    intervalMs: 1,
    refs: [{ kind: "backend-implementation", ref: "demo@1.0.0" }],
    syncProviderSupport: true,
    worker: {
      syncPackages: (refs) => {
        calls.push(`registry:${refs.length}`);
        return Promise.resolve();
      },
      syncProviderSupport: () => {
        calls.push("registry-support");
        return Promise.resolve();
      },
    },
  });
  const runtimeAgentTask = createRuntimeAgentStaleDetectionTask({
    intervalMs: 1,
    ttlMs: 60_000,
    registry: {
      detectStaleAgents: (input) => {
        calls.push(`runtime-agent:${input.ttlMs}:${input.now}`);
        return Promise.resolve({ stale: [], requeuedWork: [] });
      },
    },
  });
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
    tasks: [
      outboxTask,
      registryTask,
      runtimeAgentTask,
      revokeDebtTask,
    ],
    now: () => new Date("2026-04-30T00:00:00.000Z"),
  }).runOnce();

  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(
    calls.sort(),
    [
      "outbox:2",
      "registry-support",
      "registry:1",
      "revoke-debt:space:one:3",
      "revoke-debt:space:two:3",
      "runtime-agent:60000:2026-04-30T00:00:00.000Z",
    ].sort(),
  );
});
