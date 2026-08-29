import { expect, test } from "bun:test";

import {
  drainInterfaceMaterializationIntents,
  schedulePlatformSideEffect,
} from "../../../deploy/platform/worker.ts";

test("the owning Worker cadence drains one bounded Interface intent slice", async () => {
  const observedOptions: unknown[] = [];
  const expected = {
    claimed: 2,
    completed: 1,
    progressed: 0,
    workItemsCompleted: 2,
    retried: 1,
    deadLettered: 0,
    leaseLost: 0,
  };
  const result = await drainInterfaceMaterializationIntents({
    drainInterfaceMaterializationIntents: (input) => {
      observedOptions.push(input);
      return Promise.resolve(expected);
    },
  });

  expect(result).toEqual(expected);
  expect(observedOptions).toEqual([
    { limit: 25, maxWorkItems: 64, timeBudgetMs: 20_000 },
  ]);
  const workerSource = await Bun.file(
    new URL("../../../deploy/platform/worker.ts", import.meta.url),
  ).text();
  const scheduledHandler = workerSource.slice(
    workerSource.indexOf("async scheduled("),
    workerSource.indexOf("export interface ScheduledAccountsRefresh"),
  );
  expect(scheduledHandler).toContain(
    "schedulePlatformSideEffect(\n      runScheduledInterfaceMaterializationIntentDrain(env)",
  );
  expect(workerSource).toContain(
    'event: "interface_materialization_dead_letters"',
  );
  expect(workerSource).toContain(
    'event: "interface_materialization_recovery_failed"',
  );
});

test("a stalled Interface recovery side effect does not block later scheduled owners", async () => {
  const pending: Promise<void>[] = [];
  const stalled = new Promise<void>(() => undefined);
  let laterOwnerRan = false;

  await schedulePlatformSideEffect(stalled, {
    waitUntil(task) {
      pending.push(Promise.resolve(task).then(() => undefined));
    },
  });
  laterOwnerRan = true;

  expect(laterOwnerRan).toBe(true);
  expect(pending).toHaveLength(1);
});
