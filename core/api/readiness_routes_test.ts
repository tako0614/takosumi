import { test } from "bun:test";
import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import {
  registerReadinessRoutes,
  TAKOSUMI_SERVICE_READINESS_PATHS,
} from "./readiness_routes.ts";

test("readiness routes expose injected liveness and readiness probes", async () => {
  const app = createApp({
    ready: () => ({
      ok: true,
      checkedAt: "2026-04-27T00:00:00.000Z",
      checks: { database: "ok", router: "ok" },
    }),
    live: () => ({ ok: true, pid: 1234 }),
  });

  const ready = await app.request(TAKOSUMI_SERVICE_READINESS_PATHS.ready);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    ok: true,
    checkedAt: "2026-04-27T00:00:00.000Z",
    checks: { database: "ok", router: "ok" },
  });

  const live = await app.request(TAKOSUMI_SERVICE_READINESS_PATHS.live);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { ok: true, pid: 1234 });
});

test("readiness route returns service unavailable for failed probes", async () => {
  const app = createApp({
    ready: () => ({
      ok: false,
      reason: "dependency_unavailable",
      checks: { database: "down" },
    }),
    live: () => {
      throw new Error("event loop stalled");
    },
  });

  const ready = await app.request(TAKOSUMI_SERVICE_READINESS_PATHS.ready);
  assert.equal(ready.status, 503);
  const readyBody = await ready.json() as {
    error: { requestId?: string };
  };
  assert.equal(typeof readyBody.error.requestId, "string");
  const { requestId: _readyRequestId, ...readyError } = readyBody.error;
  assert.deepEqual({ error: readyError }, {
    error: {
      code: "readiness_probe_failed",
      message: "dependency_unavailable",
      details: {
        ok: false,
        reason: "dependency_unavailable",
        checks: { database: "down" },
      },
    },
  });

  const live = await app.request(TAKOSUMI_SERVICE_READINESS_PATHS.live);
  assert.equal(live.status, 503);
  const liveBody = await live.json() as {
    error: { requestId?: string };
  };
  assert.equal(typeof liveBody.error.requestId, "string");
  const { requestId: _liveRequestId, ...liveError } = liveBody.error;
  assert.deepEqual({ error: liveError }, {
    error: {
      code: "readiness_probe_failed",
      message: "event loop stalled",
    },
  });
});

test("readiness route returns service unavailable for booting probes", async () => {
  const app = createApp({
    ready: () => ({
      ok: false,
      state: "booting",
      reason: "worker daemon has not completed an initial tick",
    }),
    live: () => ({ ok: true }),
  });

  const ready = await app.request(TAKOSUMI_SERVICE_READINESS_PATHS.ready);

  assert.equal(ready.status, 503);
  const bootingBody = await ready.json() as {
    error: { requestId?: string };
  };
  assert.equal(typeof bootingBody.error.requestId, "string");
  const { requestId: _bootingRequestId, ...bootingError } = bootingBody.error;
  assert.deepEqual({ error: bootingError }, {
    error: {
      code: "readiness_probe_failed",
      message: "worker daemon has not completed an initial tick",
      details: {
        ok: false,
        state: "booting",
        reason: "worker daemon has not completed an initial tick",
      },
    },
  });
});

function createApp(
  probes: Parameters<typeof registerReadinessRoutes>[1]["probes"],
): HonoApp {
  const app: HonoApp = new Hono();
  registerReadinessRoutes(app, { probes });
  return app;
}
