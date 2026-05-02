import assert from "node:assert/strict";
import { MemoryQueueAdapter } from "./mod.ts";

Deno.test("memory queue leases by priority then enqueue order and ack hides work", async () => {
  const queue = new MemoryQueueAdapter({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: sequence("a", "b", "lease-1"),
  });
  await queue.enqueue({ queue: "jobs", payload: { name: "low" } });
  const high = await queue.enqueue({
    queue: "jobs",
    payload: { name: "high" },
    priority: 10,
  });

  const lease = await queue.lease<{ name: string }>({ queue: "jobs" });

  assert.equal(lease?.message.id, high.id);
  assert.equal(lease?.message.attempts, 1);
  assert.equal(lease?.expiresAt, "2026-04-27T00:00:30.000Z");

  await queue.ack({
    queue: "jobs",
    messageId: high.id,
    leaseToken: lease!.token,
  });
  assert.equal((await queue.get("jobs", high.id))?.status, "acked");

  const next = await queue.lease<{ name: string }>({ queue: "jobs" });
  assert.equal(next?.message.payload.name, "low");
});

Deno.test("memory queue nack retries with delay and then leases again", async () => {
  const queue = new MemoryQueueAdapter({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: sequence("m1", "l1", "l2"),
  });
  const message = await queue.enqueue({ queue: "jobs", payload: "work" });
  const first = await queue.lease({ queue: "jobs" });

  const retried = await queue.nack({
    queue: "jobs",
    messageId: message.id,
    leaseToken: first!.token,
    delayMs: 1_000,
    reason: "try again",
    now: "2026-04-27T00:00:00.000Z",
  });

  assert.equal(retried.status, "queued");
  assert.equal(retried.attempts, 1);
  assert.equal(retried.availableAt, "2026-04-27T00:00:01.000Z");
  assert.equal(
    await queue.lease({
      queue: "jobs",
      now: "2026-04-27T00:00:00.500Z",
    }),
    undefined,
  );

  const second = await queue.lease({
    queue: "jobs",
    now: "2026-04-27T00:00:01.000Z",
  });
  assert.equal(second?.message.id, message.id);
  assert.equal(second?.message.attempts, 2);
});

Deno.test("memory queue sends message to dead letters after max attempts", async () => {
  const queue = new MemoryQueueAdapter({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: sequence("m1", "l1"),
  });
  const message = await queue.enqueue({
    queue: "jobs",
    payload: "work",
    maxAttempts: 1,
  });
  const lease = await queue.lease({ queue: "jobs" });

  const dead = await queue.nack({
    queue: "jobs",
    messageId: message.id,
    leaseToken: lease!.token,
    reason: "boom",
    now: "2026-04-27T00:00:05.000Z",
  });

  assert.equal(dead.status, "dead");
  assert.equal(dead.deadLetteredAt, "2026-04-27T00:00:05.000Z");
  assert.deepEqual(await queue.listDeadLetters("jobs"), [dead]);
});

Deno.test("memory queue requeues expired leases after visibility timeout", async () => {
  const queue = new MemoryQueueAdapter({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: sequence("m1", "l1", "l2"),
  });
  const message = await queue.enqueue({ queue: "jobs", payload: "work" });
  const first = await queue.lease({
    queue: "jobs",
    visibilityTimeoutMs: 1_000,
    now: "2026-04-27T00:00:00.000Z",
  });
  assert.equal(first?.message.id, message.id);

  assert.equal(
    await queue.lease({
      queue: "jobs",
      now: "2026-04-27T00:00:00.500Z",
    }),
    undefined,
  );

  const second = await queue.lease({
    queue: "jobs",
    now: "2026-04-27T00:00:01.000Z",
  });
  assert.equal(second?.message.id, message.id);
  assert.equal(second?.message.attempts, 2);
});

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}
