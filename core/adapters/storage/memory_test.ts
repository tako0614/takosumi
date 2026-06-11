import { test } from "bun:test";
import { MemoryStorageDriver } from "./memory.ts";
import type { MembershipSpace } from "../../domains/membership/types.ts";

const space: MembershipSpace = {
  id: "space_rollback",
  name: "Rollback space",
  metadata: {},
  createdByAccountId: "acct_1",
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
};

test("MemoryStorageDriver transaction rolls back writes on throw", async () => {
  const driver = new MemoryStorageDriver();

  await assertRejectsWithMessage(
    () =>
      driver.transaction(async (tx) => {
        const result = await tx.space.spaces.create(space);
        if (!result.ok) throw new Error("unexpected create failure");
        throw new Error("abort");
      }),
    "abort",
  );

  assertEquals(driver.snapshot().spaces, []);
});

test("MemoryStorageDriver transaction commits writes on success", async () => {
  const driver = new MemoryStorageDriver();

  await driver.transaction(async (tx) => {
    const result = await tx.space.spaces.create(space);
    if (!result.ok) throw new Error("unexpected create failure");
  });

  assertEquals(driver.snapshot().spaces, [space]);
});

test("MemoryStorageDriver serializes concurrent transactions", async () => {
  const driver = new MemoryStorageDriver();
  const firstInside = deferred<void>();
  const releaseFirst = deferred<void>();
  let secondStarted = false;

  const first = driver.transaction(async (tx) => {
    firstInside.resolve();
    await releaseFirst.promise;
    const result = await tx.space.spaces.create(space);
    if (!result.ok) throw new Error("unexpected create failure");
  });
  await firstInside.promise;

  const secondSpace: MembershipSpace = {
    ...space,
    id: "space_concurrent",
    name: "Concurrent space",
  };
  const second = driver.transaction(async (tx) => {
    secondStarted = true;
    const result = await tx.space.spaces.create(secondSpace);
    if (!result.ok) throw new Error("unexpected create failure");
  });

  await Promise.resolve();
  assertEquals(secondStarted, false);

  releaseFirst.resolve();
  await Promise.all([first, second]);

  assertEquals(driver.snapshot().spaces.map((entry) => entry.id), [
    "space_rollback",
    "space_concurrent",
  ]);
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `assertEquals failed: ${JSON.stringify(actual)} !== ${
        JSON.stringify(expected)
      }`,
    );
  }
}

async function assertRejectsWithMessage(
  fn: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw new Error(`unexpected rejection: ${String(error)}`);
  }
  throw new Error("expected promise to reject");
}
