import assert from "node:assert/strict";
import {
  decideRuntimeLogRetention,
  InMemoryRuntimeLogsService,
  type RuntimeLogAppendInput,
} from "./mod.ts";

Deno.test("runtime logs redact messages and payloads on append", async () => {
  const service = new InMemoryRuntimeLogsService();

  const event = await service.append(log({
    message: "Authorization: Bearer secret.token password=hunter2",
    payload: {
      ok: "visible",
      nested: { apiKey: "abc123" },
      line: "token=xyz safe=true",
    },
  }));

  assert.equal(
    event.message,
    "Authorization: Bearer [REDACTED] password=[REDACTED]",
  );
  assert.deepEqual(event.payload, {
    ok: "visible",
    nested: { apiKey: "[REDACTED]" },
    line: "token=[REDACTED] safe=true",
  });

  const [stored] = await service.query();
  assert.deepEqual(stored, event);
});

Deno.test("runtime logs query by worker, stream, level, time, text, and limit", async () => {
  const service = new InMemoryRuntimeLogsService();

  await service.append(
    log({ id: "1", observedAt: "2026-04-27T00:00:00.000Z", message: "boot" }),
  );
  await service.append(
    log({
      id: "2",
      observedAt: "2026-04-27T00:01:00.000Z",
      level: "warn",
      message: "retry database",
    }),
  );
  await service.append(
    log({
      id: "3",
      observedAt: "2026-04-27T00:02:00.000Z",
      workerId: "worker_b",
      stream: "stderr",
      level: "error",
      message: "database failed",
    }),
  );
  await service.append(
    log({
      id: "4",
      observedAt: "2026-04-27T00:03:00.000Z",
      level: "error",
      message: "database recovered",
    }),
  );

  const events = await service.query({
    workerId: "worker_a",
    stream: "stdout",
    level: ["warn", "error"],
    since: "2026-04-27T00:00:30.000Z",
    until: "2026-04-27T00:03:00.000Z",
    search: "database",
    limit: 1,
  });

  assert.deepEqual(events.map((event) => event.id), ["2"]);
});

Deno.test("runtime logs retention decision identifies expired window", () => {
  const decision = decideRuntimeLogRetention({
    now: "2026-04-27T01:00:00.000Z",
    policy: { windowMs: 60 * 60 * 1000 },
    oldestObservedAt: "2026-04-26T23:59:59.999Z",
  });

  assert.equal(decision.retainAfter, "2026-04-27T00:00:00.000Z");
  assert.equal(decision.shouldPrune, true);
});

Deno.test("runtime logs prune removes events outside retention window", async () => {
  const service = new InMemoryRuntimeLogsService({ windowMs: 60 * 60 * 1000 });

  await service.append(
    log({ id: "old", observedAt: "2026-04-26T23:59:59.999Z" }),
  );
  await service.append(
    log({ id: "boundary", observedAt: "2026-04-27T00:00:00.000Z" }),
  );
  await service.append(
    log({ id: "new", observedAt: "2026-04-27T00:30:00.000Z" }),
  );

  const decision = await service.pruneExpired("2026-04-27T01:00:00.000Z");
  const retained = await service.query();

  assert.equal(decision.shouldPrune, true);
  assert.deepEqual(retained.map((event) => event.id), ["boundary", "new"]);
});

function log(
  overrides: Partial<RuntimeLogAppendInput> = {},
): RuntimeLogAppendInput {
  return {
    spaceId: "space_a",
    groupId: "group_a",
    workerId: "worker_a",
    stream: "stdout",
    level: "info",
    message: "hello",
    observedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}
