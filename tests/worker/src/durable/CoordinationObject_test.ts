import assert from "node:assert/strict";
import { test } from "bun:test";
import { CoordinationObject } from "../../../../worker/src/durable/CoordinationObject.ts";
import type { CloudflareWorkerEnv } from "../../../../worker/src/bindings.ts";
import { durableObjectCapsuleCoordination } from "../../../../worker/src/worker_service.ts";

test("CoordinationObject schedules the next real Durable Object alarm", async () => {
  const storage = new FakeDoStorage();
  const coordination = new CoordinationObject(
    { storage },
    {} as CloudflareWorkerEnv,
  );

  await coordination.scheduleAlarm({
    id: "later",
    scope: "installation:inst_1",
    fireAt: "2026-06-07T10:00:00.000Z",
  });
  await coordination.scheduleAlarm({
    id: "earlier",
    scope: "installation:inst_1",
    fireAt: "2026-06-07T09:00:00.000Z",
  });

  assert.equal(storage.alarmAt, Date.parse("2026-06-07T09:00:00.000Z"));
});

test("CoordinationObject alarm fires due alarms, deletes expired leases, and reschedules", async () => {
  const storage = new FakeDoStorage();
  const coordination = new CoordinationObject(
    { storage },
    {} as CloudflareWorkerEnv,
  );

  await coordination.acquireLease({
    scope: "installation:expired",
    holderId: "run_1",
    ttlMs: 1,
  });
  await storage.put("lease:installation:expired", {
    scope: "installation:expired",
    holderId: "run_1",
    token: "lease-token",
    acquired: true,
    expiresAt: "2026-06-07T08:59:00.000Z",
  });
  await coordination.scheduleAlarm({
    id: "due",
    scope: "installation:inst_1",
    fireAt: "2026-06-07T09:00:00.000Z",
  });
  await coordination.scheduleAlarm({
    id: "next",
    scope: "installation:inst_1",
    fireAt: "2026-06-07T09:05:00.000Z",
  });

  const result = await coordination.runDueAlarms(
    Date.parse("2026-06-07T09:01:00.000Z"),
  );

  assert.deepEqual(result, {
    fired: ["due"],
    nextAlarmAt: "2026-06-07T09:05:00.000Z",
  });
  assert.equal(await storage.get("alarm:due"), undefined);
  assert.notEqual(await storage.get("alarm:next"), undefined);
  assert.equal(await storage.get("lease:installation:expired"), undefined);
  assert.equal(storage.alarmAt, Date.parse("2026-06-07T09:05:00.000Z"));
});

test("CoordinationObject cancels the real alarm when no logical alarms remain", async () => {
  const storage = new FakeDoStorage();
  const coordination = new CoordinationObject(
    { storage },
    {} as CloudflareWorkerEnv,
  );

  await coordination.scheduleAlarm({
    id: "only",
    scope: "installation:inst_1",
    fireAt: "2026-06-07T09:00:00.000Z",
  });
  assert.equal(await coordination.cancelAlarm("only"), true);

  assert.equal(storage.alarmAt, undefined);
});

test("CoordinationObject does not echo invalid request details", async () => {
  const coordination = new CoordinationObject(
    { storage: new FakeDoStorage() },
    {} as CloudflareWorkerEnv,
  );

  const response = await coordination.fetch(
    new Request("https://coordination/acquire-lease", {
      method: "POST",
      body: JSON.stringify({
        scope: "installation:inst_1",
        holderId: "run_1",
        ttlMs: "secret-token-that-must-not-echo",
      }),
    }),
  );

  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text.includes("secret-token-that-must-not-echo"), false);
  assert.equal(text.includes("ttlMs"), false);
  assert.equal(text.includes("invalid coordination request"), true);
});

test("CoordinationObject distinguishes a non-held renewal from storage unavailability", async () => {
  const coordination = new CoordinationObject(
    { storage: new FakeDoStorage() },
    {} as CloudflareWorkerEnv,
  );
  const notHeld = await coordination.fetch(
    new Request("https://coordination/renew-lease", {
      method: "POST",
      body: JSON.stringify({
        scope: "capsule:cap_1:production",
        holderId: "apply_1",
        token: "stale-token",
        ttlMs: 900_000,
      }),
    }),
  );

  assert.equal(notHeld.status, 200);
  assert.deepEqual(await notHeld.json(), {
    result: {
      scope: "capsule:cap_1:production",
      holderId: "apply_1",
      token: "stale-token",
      acquired: false,
      expiresAt: "1970-01-01T00:00:00.000Z",
    },
  });

  const unavailable = new CoordinationObject(
    { storage: new UnavailableDoStorage() },
    {} as CloudflareWorkerEnv,
  );
  const unavailableResponse = await unavailable.fetch(
    new Request("https://coordination/renew-lease", {
      method: "POST",
      body: JSON.stringify({
        scope: "capsule:cap_1:production",
        holderId: "apply_1",
        token: "held-token",
        ttlMs: 900_000,
      }),
    }),
  );

  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), {
    error: "coordination unavailable",
  });
});

test("Worker coordination adapter returns not-held but throws retryable unavailability", async () => {
  const notHeld = durableObjectCapsuleCoordination(
    coordinationEnv(() =>
      Promise.resolve(
        Response.json({
          result: {
            scope: "capsule:cap_1:production",
            holderId: "apply_1",
            token: "stale-token",
            acquired: false,
            expiresAt: "1970-01-01T00:00:00.000Z",
          },
        }),
      ),
    ),
  );
  assert.ok(notHeld);
  assert.equal(
    (
      await notHeld.renewLease({
        scope: "capsule:cap_1:production",
        holderId: "apply_1",
        token: "stale-token",
        ttlMs: 900_000,
      })
    ).acquired,
    false,
  );

  const unavailable = durableObjectCapsuleCoordination(
    coordinationEnv(() =>
      Promise.resolve(
        Response.json(
          { error: "coordination unavailable" },
          { status: 503 },
        ),
      ),
    ),
  );
  assert.ok(unavailable);
  await assert.rejects(
    () =>
      unavailable.renewLease({
        scope: "capsule:cap_1:production",
        holderId: "apply_1",
        token: "held-token",
        ttlMs: 900_000,
      }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal(
        (error as { readonly retryable?: unknown }).retryable,
        true,
      );
      assert.equal(
        (error as { readonly reason?: unknown }).reason,
        "coordination_transport_unavailable",
      );
      return true;
    },
  );
});

function coordinationEnv(
  fetcher: (request: Request) => Promise<Response>,
): CloudflareWorkerEnv {
  return {
    COORDINATION: {
      idFromName: () => ({}),
      get: () => ({ fetch: fetcher }),
    },
  } as unknown as CloudflareWorkerEnv;
}

class FakeDoStorage {
  readonly #values = new Map<string, unknown>();
  alarmAt: number | undefined;

  get<T = unknown>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.#values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#values.delete(key));
  }

  list<T = unknown>(options?: { readonly prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    const entries = Array.from(this.#values.entries()).filter(([key]) =>
      key.startsWith(prefix)
    ) as [string, T][];
    return Promise.resolve(new Map(entries));
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}

class UnavailableDoStorage extends FakeDoStorage {
  override get<T = unknown>(_key: string): Promise<T | undefined> {
    return Promise.reject(new Error("Durable Object storage reset"));
  }
}
