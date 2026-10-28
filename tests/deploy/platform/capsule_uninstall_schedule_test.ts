import { expect, test } from "bun:test";

import { finalizeScheduledCapsuleUninstalls } from "../../../deploy/platform/worker.ts";

test("the owning Worker cadence finalizes one bounded slice of due uninstalls", async () => {
  const observed: unknown[] = [];
  const expected = {
    scanned: 2,
    exportsRecorded: 1,
    destroyPlansCreated: 1,
    destroysStarted: 0,
    blocked: 0,
    waiting: 1,
    failures: 0,
  };
  const result = await finalizeScheduledCapsuleUninstalls({
    finalizeDueCapsuleUninstalls: (options) => {
      observed.push(options);
      return Promise.resolve(expected);
    },
  });
  expect(result).toEqual(expected);
  expect(observed).toEqual([{ limit: 10 }]);

  const workerSource = await Bun.file(
    new URL("../../../deploy/platform/worker.ts", import.meta.url),
  ).text();
  const scheduledHandler = workerSource.slice(
    workerSource.indexOf("async scheduled("),
    workerSource.indexOf("const SCHEDULED_INTERFACE_MATERIALIZATION_INTENT_LIMIT"),
  );
  // Failure-isolated like the other recovery owners: it runs on every cron
  // (not only the source-poll schedule) and cannot block later owners.
  expect(scheduledHandler).toContain(
    "schedulePlatformSideEffect(\n      runScheduledCapsuleUninstallFinalize(env)",
  );
  expect(scheduledHandler.indexOf("runScheduledCapsuleUninstallFinalize")).toBeLessThan(
    scheduledHandler.indexOf("await runSourceMaintenanceSchedule({"),
  );
  expect(workerSource).toContain('event: "capsule_uninstall_finalize_failed"');
});
