import assert from "node:assert/strict";
import type { RouteProjection } from "../../domains/routing/mod.ts";
import { InMemoryRouterConfigAdapter, NoopRouterConfigAdapter } from "./mod.ts";

Deno.test("InMemoryRouterConfigAdapter renders and stores route projections", async () => {
  const adapter = new InMemoryRouterConfigAdapter({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const projection = routeProjection();

  const result = await adapter.apply(projection);

  assert.equal(result.adapter, "memory");
  assert.equal(result.appliedAt, "2026-04-27T00:00:00.000Z");
  assert.equal(result.config.activationId, "activation-a");
  assert.deepEqual(result.config.routes[0], {
    id: "route-http",
    name: "http",
    host: "demo.localhost",
    path: "/",
    protocol: "http",
    target: {
      componentName: "web",
      runtimeRouteId: "route-http",
    },
    activationId: "activation-a",
  });
  assert.deepEqual(await adapter.get(projection.id), result.config);
});

Deno.test("NoopRouterConfigAdapter renders without writing state", async () => {
  const adapter = new NoopRouterConfigAdapter({
    clock: () => new Date("2026-04-27T02:00:00.000Z"),
  });

  const result = await adapter.apply(routeProjection());

  assert.equal(result.adapter, "noop");
  assert.equal(result.noop, true);
  assert.equal(result.config.routes.length, 1);
});

Deno.test("router config adapters reject activation mutation", async () => {
  const adapter = new InMemoryRouterConfigAdapter();
  const projection = routeProjection({ routeActivationId: "activation-b" });

  await assert.rejects(
    () => adapter.apply(projection),
    /mutates activation|activation mismatch/,
  );
});

function routeProjection(options: {
  readonly routeActivationId?: string;
} = {}): RouteProjection {
  return {
    id: "space-a:group-a:activation-a",
    spaceId: "space-a",
    groupId: "group-a",
    activationId: "activation-a",
    desiredStateId: "desired-a",
    projectedAt: "2026-04-27T00:00:00.000Z",
    routes: [{
      id: "route-http",
      name: "http",
      spaceId: "space-a",
      groupId: "group-a",
      activationId: options.routeActivationId ?? "activation-a",
      host: "demo.localhost",
      path: "/",
      protocol: "http",
      target: {
        componentName: "web",
        runtimeRouteId: "route-http",
      },
    }],
  };
}
