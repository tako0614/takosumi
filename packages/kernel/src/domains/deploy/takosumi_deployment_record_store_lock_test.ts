import assert from "node:assert/strict";
import { InMemoryTakosumiDeploymentRecordStore } from "./takosumi_deployment_record_store.ts";

const TENANT = "takosumi-deploy";
const NAME = "my-app";

Deno.test("acquireLock + releaseLock serialises concurrent waiters", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  const order: string[] = [];

  // First holder acquires immediately.
  await store.acquireLock(TENANT, NAME);
  order.push("first-acquired");

  let secondAcquired = false;
  const secondPromise = (async () => {
    await store.acquireLock(TENANT, NAME);
    order.push("second-acquired");
    secondAcquired = true;
    await store.releaseLock(TENANT, NAME);
  })();

  // Yield a tick so the second acquirer reaches its `await`.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    secondAcquired,
    false,
    "second acquireLock must wait while first holder is alive",
  );

  await store.releaseLock(TENANT, NAME);
  await secondPromise;
  assert.deepEqual(order, ["first-acquired", "second-acquired"]);
});

Deno.test("acquireLock against unrelated keys is non-blocking", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  await store.acquireLock(TENANT, "app-a");
  // Should resolve immediately because (TENANT, app-b) has no holder.
  await store.acquireLock(TENANT, "app-b");
  await store.releaseLock(TENANT, "app-a");
  await store.releaseLock(TENANT, "app-b");
});

Deno.test("releaseLock without prior acquire is a no-op", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  await store.releaseLock(TENANT, NAME);
  // Subsequent acquire must still work normally.
  await store.acquireLock(TENANT, NAME);
  await store.releaseLock(TENANT, NAME);
});

Deno.test("multiple queued acquirers each receive the lock in arrival order", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  const order: number[] = [];

  await store.acquireLock(TENANT, NAME);

  const waiters = Array.from({ length: 5 }, (_, i) =>
    (async () => {
      await store.acquireLock(TENANT, NAME);
      order.push(i);
      await store.releaseLock(TENANT, NAME);
    })());

  // Yield enough microtasks so every waiter is queued.
  for (let i = 0; i < 10; i++) await Promise.resolve();

  await store.releaseLock(TENANT, NAME);
  await Promise.all(waiters);

  // Order is the arrival order; each waiter ran exactly once.
  assert.equal(order.length, 5);
  assert.deepEqual(order.slice().sort(), [0, 1, 2, 3, 4]);
});
