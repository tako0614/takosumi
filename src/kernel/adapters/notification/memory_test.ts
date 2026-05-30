import assert from "node:assert/strict";
import { MemoryNotificationSink } from "./mod.ts";

Deno.test("memory notification sink stores published notifications", async () => {
  const sink = new MemoryNotificationSink({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: () => "n1",
  });

  const record = await sink.publish({
    type: "deploy.applied",
    subject: "Deploy applied",
    severity: "info",
    metadata: { deploymentId: "dep_1" },
  });

  assert.deepEqual(record, {
    id: "notification_n1",
    type: "deploy.applied",
    subject: "Deploy applied",
    body: undefined,
    severity: "info",
    metadata: { deploymentId: "dep_1" },
    createdAt: "2026-04-27T00:00:00.000Z",
  });
  assert.deepEqual(await sink.list(), [record]);

  await sink.clear();
  assert.deepEqual(await sink.list(), []);
});
