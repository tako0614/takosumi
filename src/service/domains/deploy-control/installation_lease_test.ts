import { expect, test } from "bun:test";

import {
  InstallationLeaseBusyError,
  InMemoryInstallationCoordination,
  installationLeaseScope,
  withInstallationLease,
} from "./installation_lease.ts";

test("installationLeaseScope keys by installation id + environment", () => {
  expect(installationLeaseScope("inst_1", "production")).toBe(
    "installation:inst_1:production",
  );
});

test("two write runs for the SAME environment serialize: second is blocked until release", async () => {
  let token = 0;
  const coordination = new InMemoryInstallationCoordination({
    newToken: () => `tok_${(token += 1)}`,
  });

  let firstReleased = false;
  let releaseFirst!: () => void;
  const firstHolds = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  // First run acquires the lease and holds it until we let it finish.
  const firstRun = withInstallationLease(
    coordination,
    { installationId: "env_1", environment: "production", holderId: "run_a" },
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
    withInstallationLease(
      coordination,
      { installationId: "env_1", environment: "production", holderId: "run_b" },
      () => Promise.resolve("second"),
    ),
  ).rejects.toBeInstanceOf(InstallationLeaseBusyError);
  expect(firstReleased).toBe(false);

  // Release the first run; it completes and frees the lease.
  releaseFirst();
  expect(await firstRun).toBe("first");
  expect(firstReleased).toBe(true);

  // Now a fresh run for the same environment can acquire it.
  const retried = await withInstallationLease(
    coordination,
    { installationId: "env_1", environment: "production", holderId: "run_b" },
    () => Promise.resolve("retried"),
  );
  expect(retried).toBe("retried");
});

test("write runs for DIFFERENT environments run in parallel", async () => {
  const coordination = new InMemoryInstallationCoordination();

  let aReleased = false;
  let releaseA!: () => void;
  const aHolds = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const runA = withInstallationLease(
    coordination,
    { installationId: "env_a", environment: "production", holderId: "run_a" },
    async () => {
      await aHolds;
      aReleased = true;
      return "a";
    },
  );

  await Promise.resolve();

  // A different environment acquires its own lease while env_a is still held.
  const runB = await withInstallationLease(
    coordination,
    { installationId: "env_b", environment: "production", holderId: "run_b" },
    () => Promise.resolve("b"),
  );
  expect(runB).toBe("b");
  expect(aReleased).toBe(false);

  releaseA();
  expect(await runA).toBe("a");
});

test("the lease is released even when the work throws", async () => {
  const coordination = new InMemoryInstallationCoordination();
  await expect(
    withInstallationLease(
      coordination,
      { installationId: "env_1", environment: "production", holderId: "run_a" },
      () => Promise.reject(new Error("boom")),
    ),
  ).rejects.toThrow("boom");
  // The lease was released in the finally, so a subsequent run acquires it.
  const after = await withInstallationLease(
    coordination,
    { installationId: "env_1", environment: "production", holderId: "run_b" },
    () => Promise.resolve("ok"),
  );
  expect(after).toBe("ok");
});

test("an expired lease can be re-acquired by a new holder", async () => {
  let nowMs = 1000;
  const coordination = new InMemoryInstallationCoordination({
    now: () => nowMs,
  });
  const lease = await coordination.acquireLease({
    scope: installationLeaseScope("env_1", "production"),
    holderId: "run_a",
    ttlMs: 100,
  });
  expect(lease.acquired).toBe(true);

  // Before expiry: busy.
  const busy = await coordination.acquireLease({
    scope: installationLeaseScope("env_1", "production"),
    holderId: "run_b",
    ttlMs: 100,
  });
  expect(busy.acquired).toBe(false);

  // After expiry: a new holder takes over.
  nowMs += 200;
  const taken = await coordination.acquireLease({
    scope: installationLeaseScope("env_1", "production"),
    holderId: "run_b",
    ttlMs: 100,
  });
  expect(taken.acquired).toBe(true);
  expect(taken.holderId).toBe("run_b");
});
