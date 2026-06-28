import assert from "node:assert/strict";
import { test } from "bun:test";
import { InstallationLeaseBusyError } from "../../../../core/domains/deploy-control/installation_lease.ts";
import { OpenTofuRunOwnerObject } from "../../../../worker/src/durable/OpenTofuRunOwnerObject.ts";
import type { CloudflareWorkerEnv } from "../../../../worker/src/bindings.ts";

test("OpenTofu run owner stores identity only and schedules an alarm", async () => {
  const storage = new FakeDoStorage();
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    { now: () => Date.parse("2026-06-22T08:00:00.000Z") },
  );

  const response = await owner.fetch(
    new Request("https://run-owner/start", {
      method: "POST",
      body: JSON.stringify({
        kind: "takosumi.opentofu-run-owner.start@v1",
        action: "plan",
        runId: "run_1",
        spaceId: "space_1",
        queueAttempt: 2,
        messageId: "msg_1",
        request: { token: "secret-that-must-not-persist" },
      }),
    }),
  );

  assert.equal(response.status, 202);
  assert.equal(storage.alarmAt, Date.parse("2026-06-22T08:00:00.000Z"));
  const record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.runId, "run_1");
  assert.equal(record?.spaceId, "space_1");
  assert.equal(record?.action, "plan");
  assert.equal(record?.queueAttempt, 2);
  assert.equal(record?.messageId, "msg_1");
  assert.equal(
    JSON.stringify(record).includes("secret-that-must-not-persist"),
    false,
  );
});

test("OpenTofu run owner alarm dispatches once and records success", async () => {
  const storage = new FakeDoStorage();
  const calls: unknown[] = [];
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => Date.parse("2026-06-22T08:00:00.000Z"),
      dispatch: (dispatch) => {
        calls.push(dispatch);
        return Promise.resolve();
      },
    },
  );

  await start(owner, "apply");
  await owner.alarm();

  assert.deepEqual(calls, [
    { action: "apply", runId: "run_1", spaceId: "space_1" },
  ]);
  const record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "succeeded");
  assert.equal(record?.attempts, 1);
  assert.equal(storage.alarmAt, undefined);
});

test("OpenTofu run owner maps destroy queue work to apply dispatch", async () => {
  const storage = new FakeDoStorage();
  const calls: unknown[] = [];
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => Date.parse("2026-06-22T08:00:00.000Z"),
      dispatch: (dispatch) => {
        calls.push(dispatch);
        return Promise.resolve();
      },
    },
  );

  await start(owner, "destroy");
  await owner.alarm();

  assert.deepEqual(calls, [
    { action: "apply", runId: "run_1", spaceId: "space_1" },
  ]);
});

test("OpenTofu run owner reschedules lease-busy work without burning attempts", async () => {
  const storage = new FakeDoStorage();
  const now = Date.parse("2026-06-22T08:00:00.000Z");
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => now,
      dispatch: () =>
        Promise.reject(
          new InstallationLeaseBusyError("installation:inst_1:production"),
        ),
    },
  );

  await start(owner, "apply");
  await owner.alarm();

  const record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "scheduled");
  assert.equal(record?.attempts, 0);
  assert.equal(record?.lastError, "installation lease busy");
  assert.equal(storage.alarmAt, now + 10_000);
});

test("OpenTofu run owner marks retries exhausted after owner retry budget", async () => {
  const storage = new FakeDoStorage();
  let now = Date.parse("2026-06-22T08:00:00.000Z");
  let marks = 0;
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => now,
      dispatch: () => Promise.reject(new Error("secret-token-in-error")),
      markRetriesExhausted: () => {
        marks += 1;
        return Promise.resolve();
      },
    },
  );

  await start(owner, "plan");
  for (let index = 0; index < 3; index += 1) {
    await owner.alarm();
    if (storage.alarmAt !== undefined) now = storage.alarmAt;
  }

  const record = await storage.get<Record<string, unknown>>("run");
  assert.equal(marks, 1);
  assert.equal(record?.status, "failed");
  assert.equal(record?.attempts, 3);
  assert.equal(record?.lastError, "opentofu run dispatch failed");
  assert.equal(JSON.stringify(record).includes("secret-token-in-error"), false);
  assert.equal(storage.alarmAt, undefined);
});

test("OpenTofu run owner marks source_sync retries exhausted after owner retry budget", async () => {
  const storage = new FakeDoStorage();
  let now = Date.parse("2026-06-22T08:00:00.000Z");
  const marked: unknown[] = [];
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => now,
      dispatch: () => Promise.reject(new Error("source sync crashed")),
      markRetriesExhausted: (dispatch) => {
        marked.push(dispatch);
        return Promise.resolve();
      },
    },
  );

  await start(owner, "source_sync");
  for (let index = 0; index < 3; index += 1) {
    await owner.alarm();
    if (storage.alarmAt !== undefined) now = storage.alarmAt;
  }

  assert.deepEqual(marked, [
    { action: "source_sync", runId: "run_1", spaceId: "space_1" },
  ]);
  const record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "failed");
  assert.equal(record?.attempts, 3);
  assert.equal(storage.alarmAt, undefined);
});

test("OpenTofu run owner does not echo invalid request details", async () => {
  const owner = new OpenTofuRunOwnerObject(
    { storage: new FakeDoStorage() },
    {} as CloudflareWorkerEnv,
  );

  const response = await owner.fetch(
    new Request("https://run-owner/start", {
      method: "POST",
      body: JSON.stringify({
        kind: "takosumi.opentofu-run-owner.start@v1",
        action: "backup",
        runId: "run_1",
        spaceId: "space_1",
        token: "secret-token-that-must-not-echo",
      }),
    }),
  );

  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text.includes("secret-token-that-must-not-echo"), false);
  assert.equal(text.includes("invalid run owner request"), true);
});

async function start(
  owner: OpenTofuRunOwnerObject,
  action: "plan" | "apply" | "destroy" | "source_sync",
): Promise<void> {
  const response = await owner.fetch(
    new Request("https://run-owner/start", {
      method: "POST",
      body: JSON.stringify({
        kind: "takosumi.opentofu-run-owner.start@v1",
        action,
        runId: "run_1",
        spaceId: "space_1",
      }),
    }),
  );
  assert.equal(response.status, 202);
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

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}
