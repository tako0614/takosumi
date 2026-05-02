import assert from "node:assert/strict";
import { MemoryCoordinationAdapter } from "./mod.ts";

Deno.test("memory coordination leases and alarms are scoped and expiring", async () => {
  let now = new Date("2026-04-30T00:00:00.000Z");
  const coordination = new MemoryCoordinationAdapter({
    clock: () => now,
    idGenerator: () => "id",
  });

  const lease = await coordination.acquireLease({
    scope: "space/group",
    holderId: "worker-a",
    ttlMs: 1_000,
  });
  assert.equal(lease.acquired, true);

  const contended = await coordination.acquireLease({
    scope: "space/group",
    holderId: "worker-b",
    ttlMs: 1_000,
  });
  assert.equal(contended.acquired, false);
  assert.equal(contended.holderId, "worker-a");

  now = new Date("2026-04-30T00:00:02.000Z");
  assert.equal(await coordination.getLease("space/group"), undefined);

  const reacquired = await coordination.acquireLease({
    scope: "space/group",
    holderId: "worker-b",
    ttlMs: 1_000,
  });
  assert.equal(reacquired.acquired, true);
  assert.equal(await coordination.releaseLease(reacquired), true);

  await coordination.scheduleAlarm({
    id: "alarm-1",
    scope: "space/group",
    fireAt: "2026-04-30T00:05:00.000Z",
  });
  assert.equal((await coordination.listAlarms("space/group")).length, 1);
  assert.equal(await coordination.cancelAlarm("alarm-1"), true);
  assert.equal((await coordination.listAlarms()).length, 0);
});
