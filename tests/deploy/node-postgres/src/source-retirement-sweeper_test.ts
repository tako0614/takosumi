import { expect, test } from "bun:test";
import { startSourceRetirementSweeper } from "../../../../deploy/node-postgres/src/source-retirement-sweeper.ts";

type SweepOperations = Parameters<typeof startSourceRetirementSweeper>[0]["operations"];

test("disabled Node Source retirement sweep neither schedules nor runs", async () => {
  let calls = 0;
  const sweeper = startSourceRetirementSweeper({
    operations: { sweepRetiredSources: async () => {
      calls++;
      return { scanned: 0, attempted: 0, retired: 0, deferred: 0, failures: 0 };
    } } as SweepOperations,
    log: () => {}, enabled: false, initialDelayMs: 1, intervalMs: 1,
  });
  await sweeper.tick();
  sweeper.stop();
  expect(calls).toBe(0);
});

test("enabled Node Source retirement sweep runs a bounded manual tick", async () => {
  const limits: number[] = [];
  const sweeper = startSourceRetirementSweeper({
    operations: { sweepRetiredSources: async (options) => {
      limits.push(options?.limit ?? -1);
      return { scanned: 1, attempted: 1, retired: 1, deferred: 0, failures: 0 };
    } } as SweepOperations,
    log: () => {}, initialDelayMs: 60_000, intervalMs: 60_000,
  });
  try {
    await sweeper.tick();
    expect(limits).toEqual([25]);
  } finally {
    sweeper.stop();
  }
});
