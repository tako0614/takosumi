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

test("CoordinationObject retains a joinable generation until every exact-operation reference releases", async () => {
  const coordination = new CoordinationObject(
    { storage: new FakeDoStorage() },
    {} as CloudflareWorkerEnv,
  );
  const input = {
    scope: "capsule:cap_joinable:production",
    holderId: "capsule-rebind_exact-operation",
    ttlMs: 60_000,
    joinExistingHolder: true,
  } as const;

  const leader = await coordination.acquireLease(input);
  const follower = await coordination.acquireLease(input);
  assert.equal(leader.acquired, true);
  assert.equal(follower.acquired, true);
  assert.equal(follower.token, leader.token);
  assert.notEqual(follower.referenceId, leader.referenceId);

  assert.equal(
    await coordination.releaseLease({
      scope: input.scope,
      holderId: input.holderId,
      token: leader.token,
      referenceId: leader.referenceId!,
    }),
    true,
  );
  assert.equal(
    (
      await coordination.acquireLease({
        scope: input.scope,
        holderId: "interface-materializer",
        ttlMs: 60_000,
        joinExistingHolder: true,
      })
    ).acquired,
    false,
  );
  assert.equal(
    await coordination.releaseLease({
      scope: input.scope,
      holderId: input.holderId,
      token: leader.token,
      referenceId: leader.referenceId!,
    }),
    false,
  );
  assert.equal(
    await coordination.releaseLease({
      scope: input.scope,
      holderId: input.holderId,
      token: follower.token,
      referenceId: follower.referenceId!,
    }),
    true,
  );
  assert.equal(
    (
      await coordination.acquireLease({
        scope: input.scope,
        holderId: "interface-materializer",
        ttlMs: 60_000,
      })
    ).acquired,
    true,
  );
});

test("CoordinationObject never upgrades an existing exclusive same-holder lease into a joinable lease", async () => {
  const coordination = new CoordinationObject(
    { storage: new FakeDoStorage() },
    {} as CloudflareWorkerEnv,
  );
  const scope = "capsule:cap_exclusive:production";
  assert.equal(
    (
      await coordination.acquireLease({
        scope,
        holderId: "apply_same_holder",
        ttlMs: 60_000,
      })
    ).acquired,
    true,
  );
  assert.equal(
    (
      await coordination.acquireLease({
        scope,
        holderId: "apply_same_holder",
        ttlMs: 60_000,
        joinExistingHolder: true,
      })
  ).acquired,
    false,
  );
});

test("CoordinationObject keeps ordinary leases renewable and releasable without a reference", async () => {
  const storage = new FakeDoStorage();
  const coordination = new CoordinationObject(
    { storage },
    {} as CloudflareWorkerEnv,
  );
  const input = {
    scope: "capsule:cap_ordinary:production",
    holderId: "ordinary-holder",
    ttlMs: 60_000,
  } as const;

  const lease = await coordination.acquireLease(input);
  assert.equal(lease.acquired, true);
  assert.equal(lease.referenceId, undefined);
  const stored = await storage.get<Record<string, unknown>>(
    `lease:${input.scope}`,
  );
  assert.equal(stored?.joinable, false);
  assert.equal("activeReferenceIds" in (stored ?? {}), false);

  const renewed = await coordination.renewLease({
    scope: input.scope,
    holderId: input.holderId,
    token: lease.token,
    ttlMs: input.ttlMs,
  });
  assert.equal(renewed.acquired, true);
  assert.equal(renewed.referenceId, undefined);
  assert.equal(
    await coordination.releaseLease({
      scope: input.scope,
      holderId: input.holderId,
      token: lease.token,
    }),
    true,
  );
  assert.equal(await storage.get(`lease:${input.scope}`), undefined);
});

test("CoordinationObject normalizes a persisted legacy lease as exclusive", async () => {
  const storage = new FakeDoStorage();
  const coordination = new CoordinationObject(
    { storage },
    {} as CloudflareWorkerEnv,
  );
  const scope = "capsule:cap_legacy_persisted:production";
  const holderId = "legacy-holder";
  const token = "legacy-generation";
  await storage.put(`lease:${scope}`, {
    scope,
    holderId,
    token,
    acquired: true,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const busy = await coordination.acquireLease({
    scope,
    holderId,
    ttlMs: 60_000,
    joinExistingHolder: true,
  });
  assert.equal(busy.acquired, false);
  assert.equal(busy.referenceId, undefined);

  const renewed = await coordination.renewLease({
    scope,
    holderId,
    token,
    ttlMs: 60_000,
  });
  assert.equal(renewed.acquired, true);
  assert.equal(renewed.referenceId, undefined);
  const normalized = await storage.get<Record<string, unknown>>(
    `lease:${scope}`,
  );
  assert.equal(normalized?.joinable, false);
  assert.deepEqual(normalized?.activeReferenceIds, []);

  assert.equal(
    await coordination.releaseLease({ scope, holderId, token }),
    true,
  );
  assert.equal(await storage.get(`lease:${scope}`), undefined);
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

test("Worker coordination adapter preserves join and member-release identity", async () => {
  const requests: Array<{
    readonly path: string;
    readonly body: Record<string, unknown>;
  }> = [];
  const coordination = durableObjectCapsuleCoordination(
    coordinationEnv(async (request) => {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ path, body });
      if (path.endsWith("/acquire-lease")) {
        return Response.json({
          result: {
            scope: body.scope,
            holderId: body.holderId,
            token: "generation-token",
            referenceId: "reference-1",
            acquired: true,
            expiresAt: "2026-08-30T17:00:00.000Z",
          },
        });
      }
      return Response.json({ result: true });
    }),
  );
  assert.ok(coordination);
  const lease = await coordination.acquireLease({
    scope: "capsule:cap_joinable:production",
    holderId: "capsule-rebind_exact-operation",
    ttlMs: 60_000,
    joinExistingHolder: true,
  });
  assert.equal(
    await coordination.releaseLease({
      scope: lease.scope,
      holderId: lease.holderId,
      token: lease.token,
      referenceId: lease.referenceId!,
    }),
    true,
  );
  assert.deepEqual(requests, [
    {
      path: "/acquire-lease",
      body: {
        scope: "capsule:cap_joinable:production",
        holderId: "capsule-rebind_exact-operation",
        ttlMs: 60_000,
        joinExistingHolder: true,
      },
    },
    {
      path: "/release-lease",
      body: {
        scope: "capsule:cap_joinable:production",
        holderId: "capsule-rebind_exact-operation",
        token: "generation-token",
        referenceId: "reference-1",
      },
    },
  ]);
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
