import assert from "node:assert/strict";
import type { RuntimeDesiredState } from "../../domains/runtime/mod.ts";
import { DryRunProviderMaterializer } from "./dry_run.ts";
import { NoopProviderMaterializer } from "./noop.ts";

Deno.test("NoopProviderMaterializer records a noop operation without side effects", async () => {
  const materializer = new NoopProviderMaterializer({
    clock: fixedClock("2026-04-27T01:00:00.000Z"),
    idGenerator: sequenceIds(["op_1", "plan_1"]),
  });

  const plan = await materializer.materialize(desiredState());

  assert.equal(plan.id, "provider_plan_plan_1");
  assert.equal(plan.provider, "noop");
  assert.equal(plan.desiredStateId, "space-a:group-a:activation-a");
  assert.equal(plan.recordedAt, "2026-04-27T01:00:00.000Z");
  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0], {
    id: "provider_op_op_1",
    kind: "noop",
    provider: "noop",
    desiredStateId: "space-a:group-a:activation-a",
    targetId: "space-a:group-a:activation-a",
    targetName: "demo-app",
    command: [],
    details: { workloadCount: 1, resourceCount: 1, routeCount: 1 },
    recordedAt: "2026-04-27T01:00:00.000Z",
  });

  assert.deepEqual(
    await materializer.listRecordedOperations(),
    plan.operations,
  );
  await materializer.clearRecordedOperations();
  assert.deepEqual(await materializer.listRecordedOperations(), []);
});

Deno.test("DryRunProviderMaterializer renders protocol-aware route operations", async () => {
  const materializer = new DryRunProviderMaterializer({
    clock: fixedClock("2026-04-27T01:00:00.000Z"),
    idGenerator: sequenceIds([
      "plan_1",
      "workload_1",
      "resource_1",
      "http_1",
      "tcp_1",
      "queue_1",
    ]),
  });

  const plan = await materializer.materialize(desiredState({
    routes: [{
      id: "route_http",
      spaceId: "space-a",
      groupId: "group/with slash",
      activationId: "activation-a",
      routeName: "http",
      targetComponentName: "web/api",
      host: "demo.localhost",
      path: "/",
      protocol: "https",
      targetPort: 8080,
    }, {
      id: "route_tcp",
      spaceId: "space-a",
      groupId: "group/with slash",
      activationId: "activation-a",
      routeName: "socket",
      targetComponentName: "web/api",
      protocol: "tcp",
      port: 7000,
      targetPort: 8080,
    }, {
      id: "route_jobs",
      spaceId: "space-a",
      groupId: "group/with slash",
      activationId: "activation-a",
      routeName: "jobs",
      targetComponentName: "web/api",
      protocol: "queue",
      source: "jobs",
    }],
  }));

  assert.equal(plan.provider, "provider.dry-run");
  assert.deepEqual(plan.operations.map((operation) => operation.kind), [
    "runtime.workload.ensure",
    "runtime.resource.ensure",
    "router.listener.ensure",
    "router.listener.ensure",
    "event.subscription.ensure",
  ]);
  assert.deepEqual(plan.operations[3].details, {
    protocol: "tcp",
    host: undefined,
    path: undefined,
    port: 7000,
    source: undefined,
    targetComponentName: "web/api",
    targetPort: 8080,
  });
});

function desiredState(
  overrides: Partial<RuntimeDesiredState> = {},
): RuntimeDesiredState {
  return {
    id: "space-a:group-a:activation-a",
    spaceId: "space-a",
    groupId: "group/with slash",
    activationId: "activation-a",
    appName: "demo-app",
    appVersion: "1.0.0",
    materializedAt: "2026-04-27T00:00:00.000Z",
    workloads: [{
      id: "workload_web",
      spaceId: "space-a",
      groupId: "group/with slash",
      activationId: "activation-a",
      componentName: "web/api",
      runtimeName: "group-web",
      type: "service",
      image: "ghcr.io/example/web:1",
      command: ["serve"],
      args: ["--port", "8080"],
      env: { APP_ENV: "test", PORT: "8080" },
      depends: ["db"],
    }],
    resources: [{
      id: "resource_db",
      spaceId: "space-a",
      groupId: "group/with slash",
      activationId: "activation-a",
      resourceName: "db",
      runtimeName: "group-db",
      type: "postgres",
      env: { POSTGRES_DB: "demo" },
    }],
    routes: [{
      id: "route_http",
      spaceId: "space-a",
      groupId: "group/with slash",
      activationId: "activation-a",
      routeName: "http",
      targetComponentName: "web/api",
      host: "demo.localhost",
      path: "/",
      protocol: "http",
    }],
    ...overrides,
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("test id sequence exhausted");
    index += 1;
    return value;
  };
}
