import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInMemoryAppContext } from "../app_context.ts";
import { createRoleReadinessProbes } from "./readiness.ts";

test("worker readiness reports booting before the daemon completes an initial tick", async () => {
  const controller = new AbortController();
  const probes = createRoleReadinessProbes({
    role: "takosumi-worker",
    context: createInMemoryAppContext(),
    runtimeConfig: { processRole: "takosumi-worker" },
    runtimeEnv: {},
    workerDaemonState: {
      startedAt: "2026-05-04T00:00:00.000Z",
      lastTickByTask: new Map(),
    },
    workerDaemon: {
      signal: controller.signal,
      completed: Promise.resolve([]),
      stop: (reason?: unknown) => controller.abort(reason),
    },
  });

  const ready = await probes.ready();

  assert.equal(ready.ok, false);
  assert.equal(ready.state, "booting");
  assert.match(
    String(ready.reason),
    /workerDaemon: worker daemon has not completed an initial tick/,
  );
});

test("readiness fails strict implementation binding mode when no plugins are wired", async () => {
  const probes = createRoleReadinessProbes({
    role: "takosumi-api",
    context: createInMemoryAppContext(),
    runtimeConfig: { processRole: "takosumi-api", environment: "production" },
    runtimeEnv: { TAKOSUMI_INTERNAL_API_SECRET: "secret" },
    implementationBindingCount: 0,
    strictImplementationBindings: true,
    workerDaemonState: {
      startedAt: "2026-05-04T00:00:00.000Z",
      lastTickByTask: new Map(),
    },
  });

  const ready = await probes.ready();

  assert.equal(ready.ok, false);
  assert.match(
    String(ready.reason),
    /implementationBindings: strict implementation binding mode requires at least one TakosumiPlugin/,
  );
});
