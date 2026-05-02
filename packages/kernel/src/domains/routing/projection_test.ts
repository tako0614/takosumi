import assert from "node:assert/strict";
import {
  DefaultRouteProjector,
  InMemoryRouteProjectionStore,
  routeOwnershipKey,
} from "./mod.ts";

Deno.test("routing projects runtime route bindings to addressable targets", async () => {
  const projector = new DefaultRouteProjector({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  const projection = await projector.project({
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_1",
    desiredStateId: "desired_1",
    routes: [{
      id: "route_web",
      spaceId: "space_a",
      groupId: "group_a",
      activationId: "activation_1",
      routeName: "web",
      targetComponentName: "frontend",
      host: "app.example.test",
      path: "/",
    }, {
      id: "route_tcp",
      spaceId: "space_a",
      groupId: "group_a",
      activationId: "activation_1",
      routeName: "socket",
      targetComponentName: "socket",
      protocol: "tcp",
      port: 4433,
      targetPort: 7000,
    }],
  });

  assert.equal(projection.id, "space_a:group_a:activation_1");
  assert.equal(projection.projectedAt, "2026-04-27T00:00:00.000Z");
  assert.deepEqual(projection.routes.map((route) => route.protocol), [
    "https",
    "tcp",
  ]);
  assert.deepEqual(projection.routes[0]?.target, {
    componentName: "frontend",
    runtimeRouteId: "route_web",
  });
  assert.deepEqual(projection.routes[1]?.target, {
    componentName: "socket",
    runtimeRouteId: "route_tcp",
    port: 7000,
  });
  assert.equal(projection.routes[1]?.port, 4433);
  assert.equal(
    routeOwnershipKey("app.example.test", "/", "https"),
    "https:app.example.test:/",
  );
  assert.equal(routeOwnershipKey(undefined, undefined, "https"), "https:*:/");
  assert.equal(
    routeOwnershipKey({
      protocol: "tcp",
      host: "app.example.test",
      port: 4433,
    }),
    "tcp:app.example.test:4433",
  );
  assert.equal(
    routeOwnershipKey({ protocol: "queue", source: "jobs" }),
    "queue:jobs",
  );

  const store = new InMemoryRouteProjectionStore();
  await store.put(projection);
  assert.equal(
    (await store.findByActivation("space_a", "group_a", "activation_1"))?.id,
    projection.id,
  );
});
