import { expect, test } from "bun:test";

import { startCapsuleUninstallFinalizer } from "../../../../deploy/node-postgres/src/capsule-uninstall-finalizer.ts";

const EMPTY = {
  scanned: 0,
  exportsRecorded: 0,
  destroyPlansCreated: 0,
  destroysStarted: 0,
  blocked: 0,
  waiting: 0,
  failures: 0,
};

test("the self-host cadence never overlaps ticks and stops cleanly", async () => {
  const calls: unknown[] = [];
  const logs: unknown[] = [];
  let release: (() => void) | undefined;
  const loop = startCapsuleUninstallFinalizer({
    operations: {
      finalizeDueCapsuleUninstalls: (options) => {
        calls.push(options);
        return new Promise((resolve) => {
          release = () => resolve({ ...EMPTY, scanned: 1, destroysStarted: 1 });
        });
      },
    },
    log: (level, message, fields) => logs.push({ level, message, fields }),
    intervalMs: 60 * 60 * 1000,
    initialDelayMs: 60 * 60 * 1000,
  });
  try {
    const first = loop.tick();
    const concurrent = loop.tick();
    expect(concurrent).toBe(first);
    expect(calls).toEqual([{ limit: 10 }]);
    release?.();
    await first;
    expect(logs).toEqual([
      {
        level: "info",
        message: "capsule uninstall finalize",
        fields: {
          event: "capsule_uninstall_finalize",
          ...EMPTY,
          scanned: 1,
          destroysStarted: 1,
        },
      },
    ]);
  } finally {
    loop.stop();
  }
  await loop.tick();
  expect(calls).toHaveLength(1);
});

test("a failed self-host tick is logged and the next tick runs", async () => {
  let attempts = 0;
  const logs: { level: string; fields: Record<string, unknown> }[] = [];
  const loop = startCapsuleUninstallFinalizer({
    operations: {
      finalizeDueCapsuleUninstalls: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new TypeError("database unavailable"))
          : Promise.resolve(EMPTY);
      },
    },
    log: (level, _message, fields) => logs.push({ level, fields }),
    intervalMs: 60 * 60 * 1000,
    initialDelayMs: 60 * 60 * 1000,
  });
  try {
    await loop.tick();
    await loop.tick();
  } finally {
    loop.stop();
  }
  expect(attempts).toBe(2);
  // Quiet ticks with nothing due are not logged; failures are, without detail.
  expect(logs).toEqual([
    {
      level: "error",
      fields: {
        event: "capsule_uninstall_finalize_failed",
        errorName: "TypeError",
      },
    },
  ]);
});
