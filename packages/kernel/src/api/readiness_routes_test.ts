import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import type { GroupSummaryStatusProjection } from "../services/status/mod.ts";
import {
  registerReadinessRoutes,
  TAKOSUMI_PAAS_READINESS_PATHS,
} from "./readiness_routes.ts";

Deno.test("readiness routes expose injected liveness and readiness probes", async () => {
  const app = createApp({
    ready: () => ({
      ok: true,
      checkedAt: "2026-04-27T00:00:00.000Z",
      checks: { database: "ok", router: "ok" },
    }),
    live: () => ({ ok: true, pid: 1234 }),
    statusSummary: () => activeStatusSummary,
  });

  const ready = await app.request(TAKOSUMI_PAAS_READINESS_PATHS.ready);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    ok: true,
    checkedAt: "2026-04-27T00:00:00.000Z",
    checks: { database: "ok", router: "ok" },
  });

  const live = await app.request(TAKOSUMI_PAAS_READINESS_PATHS.live);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { ok: true, pid: 1234 });
});

Deno.test("readiness route returns service unavailable for failed probes", async () => {
  const app = createApp({
    ready: () => ({
      ok: false,
      reason: "dependency_unavailable",
      checks: { database: "down" },
    }),
    live: () => {
      throw new Error("event loop stalled");
    },
    statusSummary: () => activeStatusSummary,
  });

  const ready = await app.request(TAKOSUMI_PAAS_READINESS_PATHS.ready);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
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

  const live = await app.request(TAKOSUMI_PAAS_READINESS_PATHS.live);
  assert.equal(live.status, 503);
  assert.deepEqual(await live.json(), {
    error: {
      code: "readiness_probe_failed",
      message: "event loop stalled",
    },
  });
});

Deno.test("status summary route returns existing projection DTO", async () => {
  const app = createApp({
    ready: () => ({ ok: true }),
    live: () => ({ ok: true }),
    statusSummary: async () => activeStatusSummary,
  });

  const response = await app.request(
    TAKOSUMI_PAAS_READINESS_PATHS.statusSummary,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), activeStatusSummary);
});

Deno.test("status summary route reports probe failures", async () => {
  const app = createApp({
    ready: () => ({ ok: true }),
    live: () => ({ ok: true }),
    statusSummary: () => {
      throw new Error("projection store unavailable");
    },
  });

  const response = await app.request(
    TAKOSUMI_PAAS_READINESS_PATHS.statusSummary,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: "readiness_probe_failed",
      message: "projection store unavailable",
    },
  });
});

Deno.test("status summary route rejects non-catalog condition reasons", async () => {
  const app = createApp({
    ready: () => ({ ok: true }),
    live: () => ({ ok: true }),
    statusSummary: () => ({
      ...activeStatusSummary,
      conditions: [{
        type: "ServingConverged",
        status: "false",
        reason: "runtime-not-ready",
      }],
    } as unknown as GroupSummaryStatusProjection),
  });

  const response = await app.request(
    TAKOSUMI_PAAS_READINESS_PATHS.statusSummary,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: "readiness_probe_failed",
      message:
        "status summary emitted non-catalog condition reason at $.conditions[0].reason: runtime-not-ready",
    },
  });
});

function conditionReason(
  reason: string,
): GroupSummaryStatusProjection["conditions"][number] {
  return {
    type: "ServingConverged",
    status: "false",
    reason,
  } as GroupSummaryStatusProjection["conditions"][number];
}

function createApp(
  probes: Parameters<typeof registerReadinessRoutes>[1]["probes"],
): HonoApp {
  const app: HonoApp = new Hono();
  registerReadinessRoutes(app, { probes });
  return app;
}

const activeStatusSummary: GroupSummaryStatusProjection = {
  spaceId: "space_1",
  groupId: "group_1",
  activationId: "activation_1",
  status: "active",
  projectedAt: "2026-04-27T00:00:00.000Z",
  desired: {
    status: "committed",
    conditions: [{ type: "ActivationCommitted", status: "true" }],
  },
  serving: {
    status: "converged",
    conditions: [{ type: "RuntimeConverged", status: "true" }],
  },
  dependencies: {
    status: "ready",
    conditions: [{ type: "DependenciesReady", status: "true" }],
  },
  security: {
    status: "trusted",
    conditions: [{ type: "SecurityTrusted", status: "true" }],
  },
  providers: [],
  conditions: [
    { type: "ActivationCommitted", status: "true" },
    conditionReason("ServingConverged"),
    { type: "DependenciesReady", status: "true" },
    { type: "SecurityTrusted", status: "true" },
  ],
};
