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
      readRunStatus: () => Promise.resolve("succeeded"),
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
      readRunStatus: () => Promise.resolve("succeeded"),
    },
  );

  await start(owner, "destroy");
  await owner.alarm();

  assert.deepEqual(calls, [
    { action: "apply", runId: "run_1", spaceId: "space_1" },
  ]);
});

test("OpenTofu run owner immediately reschedules controller-managed retries", async () => {
  const storage = new FakeDoStorage();
  let now = Date.parse("2026-06-22T08:00:00.000Z");
  let calls = 0;
  let owner!: OpenTofuRunOwnerObject;
  owner = new OpenTofuRunOwnerObject({ storage }, {} as CloudflareWorkerEnv, {
    now: () => now,
    dispatch: async () => {
      calls += 1;
      if (calls === 1) {
        const response = await owner.fetch(
          new Request("https://run-owner/start", {
            method: "POST",
            body: JSON.stringify({
              kind: "takosumi.opentofu-run-owner.start@v1",
              action: "apply",
              runId: "run_1",
              spaceId: "space_1",
              cause: "controller_retry",
              messageId: "retry_msg_1",
            }),
          }),
        );
        assert.equal(response.status, 202);
        throw new Error(
          "retryable_runner_infrastructure_error: apply run run_1 requeued after runner reset",
        );
      }
    },
    readRunStatus: () => Promise.resolve("succeeded"),
  });

  await start(owner, "apply");
  await owner.alarm();

  assert.equal(calls, 2);
  const record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "succeeded");
  assert.equal(record?.attempts, 1);
  assert.equal(record?.lastScheduleCause, undefined);
  assert.equal(storage.alarmAt, undefined);
});

test("OpenTofu run owner reschedules when controller requeues without throwing", async () => {
  const storage = new FakeDoStorage();
  let now = Date.parse("2026-06-22T08:00:00.000Z");
  let calls = 0;
  const statusByCall = ["queued", "succeeded"] as const;
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => now,
      dispatch: () => {
        calls += 1;
        return Promise.resolve();
      },
      readRunStatus: () => Promise.resolve(statusByCall[calls - 1]),
    },
  );

  await start(owner, "destroy");
  await owner.alarm();

  assert.equal(calls, 1);
  let record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "scheduled");
  assert.equal(record?.lastScheduleCause, "controller_retry");
  assert.equal(record?.lastError, "run remained queued after dispatch");
  assert.equal(storage.alarmAt, now + 1_000);

  now = storage.alarmAt!;
  await owner.alarm();

  assert.equal(calls, 2);
  record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "succeeded");
  assert.equal(record?.lastScheduleCause, undefined);
  assert.equal(storage.alarmAt, undefined);
});

test("OpenTofu run owner reschedules when status read fails after dispatch", async () => {
  const storage = new FakeDoStorage();
  let now = Date.parse("2026-06-22T08:00:00.000Z");
  let calls = 0;
  let statusReads = 0;
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => now,
      dispatch: () => {
        calls += 1;
        return Promise.resolve();
      },
      readRunStatus: () => {
        statusReads += 1;
        if (statusReads === 1) return Promise.reject(new Error("d1 timeout"));
        return Promise.resolve("succeeded");
      },
    },
  );

  await start(owner, "apply");
  await owner.alarm();

  assert.equal(calls, 1);
  let record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "scheduled");
  assert.equal(record?.lastScheduleCause, "controller_retry");
  assert.equal(record?.lastError, "run status unavailable after dispatch");
  assert.equal(storage.alarmAt, now + 1_000);

  now = storage.alarmAt!;
  await owner.alarm();

  assert.equal(calls, 2);
  record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "succeeded");
  assert.equal(storage.alarmAt, undefined);
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

test("OpenTofu run owner recovers stuck running records quickly", async () => {
  const storage = new FakeDoStorage();
  const started = Date.parse("2026-06-22T08:00:00.000Z");
  await storage.put("run", {
    kind: "takosumi.opentofu-run-owner@v1",
    action: "apply",
    requestedAction: "destroy",
    runId: "run_1",
    spaceId: "space_1",
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date(started).toISOString(),
    updatedAt: new Date(started).toISOString(),
    startedAt: new Date(started).toISOString(),
  });
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    { now: () => started + 1_000 },
  );

  await start(owner, "destroy");

  assert.equal(storage.alarmAt, started + 90_000);
});

test("OpenTofu run owner accepts controller retry over a terminal owner record", async () => {
  const storage = new FakeDoStorage();
  const old = Date.parse("2026-06-22T08:00:00.000Z");
  const now = old + 120_000;
  await storage.put("run", {
    kind: "takosumi.opentofu-run-owner@v1",
    action: "source_sync",
    requestedAction: "source_sync",
    runId: "run_1",
    spaceId: "space_1",
    status: "succeeded",
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date(old).toISOString(),
    updatedAt: new Date(old).toISOString(),
    startedAt: new Date(old).toISOString(),
    finishedAt: new Date(old + 1_000).toISOString(),
  });
  const calls: unknown[] = [];
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => now,
      dispatch: (dispatch) => {
        calls.push(dispatch);
        return Promise.resolve();
      },
      readRunStatus: () => Promise.resolve("succeeded"),
    },
  );

  const response = await owner.fetch(
    new Request("https://run-owner/start", {
      method: "POST",
      body: JSON.stringify({
        kind: "takosumi.opentofu-run-owner.start@v1",
        action: "source_sync",
        runId: "run_1",
        spaceId: "space_1",
        cause: "controller_retry",
        messageId: "retry_msg_1",
      }),
    }),
  );

  assert.equal(response.status, 202);
  let record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "scheduled");
  assert.equal(record?.lastScheduleCause, "controller_retry");
  assert.equal(record?.finishedAt, undefined);
  assert.equal(storage.alarmAt, now);

  await owner.alarm();

  assert.deepEqual(calls, [
    { action: "source_sync", runId: "run_1", spaceId: "space_1" },
  ]);
  record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "succeeded");
  assert.equal(record?.lastScheduleCause, undefined);
  assert.equal(storage.alarmAt, undefined);
});

test("OpenTofu run owner reschedules a terminal owner record when the ledger is still queued", async () => {
  const storage = new FakeDoStorage();
  const old = Date.parse("2026-06-22T08:00:00.000Z");
  const now = old + 120_000;
  await storage.put("run", {
    kind: "takosumi.opentofu-run-owner@v1",
    action: "apply",
    requestedAction: "apply",
    runId: "run_1",
    spaceId: "space_1",
    status: "succeeded",
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date(old).toISOString(),
    updatedAt: new Date(old).toISOString(),
    startedAt: new Date(old).toISOString(),
    finishedAt: new Date(old + 1_000).toISOString(),
  });
  const calls: unknown[] = [];
  let statusReads = 0;
  const owner = new OpenTofuRunOwnerObject(
    { storage },
    {} as CloudflareWorkerEnv,
    {
      now: () => now,
      dispatch: (dispatch) => {
        calls.push(dispatch);
        return Promise.resolve();
      },
      readRunStatus: () => {
        statusReads += 1;
        return Promise.resolve(statusReads === 1 ? "queued" : "succeeded");
      },
    },
  );

  await start(owner, "apply");

  let record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "scheduled");
  assert.equal(
    record?.lastError,
    "ledger remained queued after terminal owner record",
  );
  assert.equal(record?.finishedAt, undefined);
  assert.equal(storage.alarmAt, now);

  await owner.alarm();

  assert.deepEqual(calls, [
    { action: "apply", runId: "run_1", spaceId: "space_1" },
  ]);
  record = await storage.get<Record<string, unknown>>("run");
  assert.equal(record?.status, "succeeded");
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
