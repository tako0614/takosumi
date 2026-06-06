import { expect, test } from "bun:test";

import {
  EnvironmentLeaseBusyError,
  InMemoryEnvironmentCoordination,
  environmentLeaseScope,
  withEnvironmentLease,
} from "./environment_lease.ts";

test("environmentLeaseScope keys by environment id", () => {
  expect(environmentLeaseScope("env_1")).toBe("environment:env_1");
});

test("two write runs for the SAME environment serialize: second is blocked until release", async () => {
  let token = 0;
  const coordination = new InMemoryEnvironmentCoordination({
    newToken: () => `tok_${(token += 1)}`,
  });

  let firstReleased = false;
  let releaseFirst!: () => void;
  const firstHolds = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  // First run acquires the lease and holds it until we let it finish.
  const firstRun = withEnvironmentLease(
    coordination,
    { environmentId: "env_1", holderId: "run_a" },
    async () => {
      await firstHolds;
      firstReleased = true;
      return "first";
    },
  );

  // Let the first run acquire before the second attempts.
  await Promise.resolve();

  // Second run for the SAME environment is rejected (lease busy) — it must be
  // redelivered, not run concurrently.
  await expect(
    withEnvironmentLease(
      coordination,
      { environmentId: "env_1", holderId: "run_b" },
      () => Promise.resolve("second"),
    ),
  ).rejects.toBeInstanceOf(EnvironmentLeaseBusyError);
  expect(firstReleased).toBe(false);

  // Release the first run; it completes and frees the lease.
  releaseFirst();
  expect(await firstRun).toBe("first");
  expect(firstReleased).toBe(true);

  // Now a fresh run for the same environment can acquire it.
  const retried = await withEnvironmentLease(
    coordination,
    { environmentId: "env_1", holderId: "run_b" },
    () => Promise.resolve("retried"),
  );
  expect(retried).toBe("retried");
});

test("write runs for DIFFERENT environments run in parallel", async () => {
  const coordination = new InMemoryEnvironmentCoordination();

  let aReleased = false;
  let releaseA!: () => void;
  const aHolds = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const runA = withEnvironmentLease(
    coordination,
    { environmentId: "env_a", holderId: "run_a" },
    async () => {
      await aHolds;
      aReleased = true;
      return "a";
    },
  );

  await Promise.resolve();

  // A different environment acquires its own lease while env_a is still held.
  const runB = await withEnvironmentLease(
    coordination,
    { environmentId: "env_b", holderId: "run_b" },
    () => Promise.resolve("b"),
  );
  expect(runB).toBe("b");
  expect(aReleased).toBe(false);

  releaseA();
  expect(await runA).toBe("a");
});

test("the lease is released even when the work throws", async () => {
  const coordination = new InMemoryEnvironmentCoordination();
  await expect(
    withEnvironmentLease(
      coordination,
      { environmentId: "env_1", holderId: "run_a" },
      () => Promise.reject(new Error("boom")),
    ),
  ).rejects.toThrow("boom");
  // The lease was released in the finally, so a subsequent run acquires it.
  const after = await withEnvironmentLease(
    coordination,
    { environmentId: "env_1", holderId: "run_b" },
    () => Promise.resolve("ok"),
  );
  expect(after).toBe("ok");
});

test("an expired lease can be re-acquired by a new holder", async () => {
  let nowMs = 1000;
  const coordination = new InMemoryEnvironmentCoordination({
    now: () => nowMs,
  });
  const lease = await coordination.acquireLease({
    scope: environmentLeaseScope("env_1"),
    holderId: "run_a",
    ttlMs: 100,
  });
  expect(lease.acquired).toBe(true);

  // Before expiry: busy.
  const busy = await coordination.acquireLease({
    scope: environmentLeaseScope("env_1"),
    holderId: "run_b",
    ttlMs: 100,
  });
  expect(busy.acquired).toBe(false);

  // After expiry: a new holder takes over.
  nowMs += 200;
  const taken = await coordination.acquireLease({
    scope: environmentLeaseScope("env_1"),
    holderId: "run_b",
    ttlMs: 100,
  });
  expect(taken.acquired).toBe(true);
  expect(taken.holderId).toBe("run_b");
});
