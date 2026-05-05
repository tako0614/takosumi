import assert from "node:assert/strict";
import { createInMemoryAppContext } from "../app_context.ts";
import { createRoleReadinessProbes } from "./readiness.ts";

Deno.test("worker readiness reports booting before the daemon completes an initial tick", async () => {
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
