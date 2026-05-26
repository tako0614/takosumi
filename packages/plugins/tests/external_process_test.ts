import assert from "node:assert/strict";
import {
  ExternalProcessController,
  type ExternalProcessRunner,
  type ExternalProcessSpec,
  type ExternalProcessStatus,
} from "../src/providers/external/mod.ts";

class StubRunner implements ExternalProcessRunner {
  states = new Map<string, ExternalProcessStatus>();
  queue: ExternalProcessStatus[] = [];
  startCalls = 0;
  stopCalls = 0;

  start(spec: ExternalProcessSpec): Promise<ExternalProcessStatus> {
    this.startCalls += 1;
    const next = this.queue.shift() ?? {
      name: spec.name,
      state: "running",
      pid: 42,
      startedAt: "2026-04-30T00:00:00.000Z",
    };
    this.states.set(spec.name, next);
    return Promise.resolve(next);
  }

  status(name: string): Promise<ExternalProcessStatus | undefined> {
    return Promise.resolve(this.states.get(name));
  }

  stop(input: { name: string }): Promise<ExternalProcessStatus> {
    this.stopCalls += 1;
    const stopped: ExternalProcessStatus = {
      name: input.name,
      state: "stopped",
      exitCode: 0,
    };
    this.states.set(input.name, stopped);
    return Promise.resolve(stopped);
  }

  list(): Promise<readonly ExternalProcessStatus[]> {
    return Promise.resolve([...this.states.values()]);
  }
}

const spec: ExternalProcessSpec = {
  name: "takos-runtime-1",
  command: ["takos", "runtime"],
};

Deno.test("external process ensure starts process when not running", async () => {
  const runner = new StubRunner();
  const controller = new ExternalProcessController({
    runner,
    sleep: () => Promise.resolve(),
  });
  const status = await controller.ensure(spec);
  assert.equal(status.state, "running");
  assert.equal(runner.startCalls, 1);
});

Deno.test("external process ensure is idempotent when process already running", async () => {
  const runner = new StubRunner();
  runner.states.set("takos-runtime-1", {
    name: "takos-runtime-1",
    state: "running",
  });
  const controller = new ExternalProcessController({
    runner,
    sleep: () => Promise.resolve(),
  });
  await controller.ensure(spec);
  assert.equal(runner.startCalls, 0);
});

Deno.test("external process restart stops then starts the process", async () => {
  const runner = new StubRunner();
  runner.states.set("takos-runtime-1", {
    name: "takos-runtime-1",
    state: "running",
  });
  const controller = new ExternalProcessController({
    runner,
    sleep: () => Promise.resolve(),
  });
  const status = await controller.restart(spec);
  assert.equal(status.state, "running");
  assert.equal(runner.stopCalls, 1);
  assert.equal(runner.startCalls, 1);
});

Deno.test("external process readiness times out and emits failed condition", async () => {
  const runner = new StubRunner();
  // start returns starting; status remains starting → readiness times out
  runner.queue.push({ name: spec.name, state: "starting" });
  const conditions: unknown[] = [];
  let now = Date.parse("2026-04-30T00:00:00.000Z");
  const controller = new ExternalProcessController({
    runner,
    clock: () => {
      const t = now;
      now += 10;
      return new Date(t);
    },
    sleep: () => Promise.resolve(),
    readinessIntervalMs: 1,
    readinessTimeoutMs: 5,
    conditionSink: (condition) => conditions.push(condition),
  });
  await controller.ensure(spec);
  assert.ok(
    conditions.some((c) =>
      (c as { type: string; status: string }).type === "ProcessReady" &&
      (c as { status: string }).status === "false"
    ),
  );
});

Deno.test("external process stop with force passes flag through to runner", async () => {
  const runner = new StubRunner();
  runner.states.set("takos-runtime-1", {
    name: "takos-runtime-1",
    state: "running",
  });
  const controller = new ExternalProcessController({
    runner,
    sleep: () => Promise.resolve(),
  });
  await controller.stop("takos-runtime-1", { force: true });
  assert.equal(runner.stopCalls, 1);
  const status = await controller.status("takos-runtime-1");
  assert.equal(status?.state, "stopped");
});
