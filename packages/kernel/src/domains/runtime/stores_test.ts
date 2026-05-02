import assert from "node:assert/strict";
import {
  InMemoryRuntimeDesiredStateStore,
  InMemoryRuntimeObservedStateStore,
  type RuntimeDesiredState,
  type RuntimeObservedStateSnapshot,
} from "./mod.ts";

Deno.test("runtime observed snapshots are stored separately from canonical desired state", async () => {
  const desiredStore = new InMemoryRuntimeDesiredStateStore();
  const observedStore = new InMemoryRuntimeObservedStateStore();

  const desired: RuntimeDesiredState = {
    id: "space_a:group_a:activation_1",
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_1",
    appName: "example",
    appVersion: "1.0.0",
    materializedAt: "2026-04-27T00:00:00.000Z",
    workloads: [{
      id: "workload_web",
      spaceId: "space_a",
      groupId: "group_a",
      activationId: "activation_1",
      componentName: "web",
      runtimeName: "group_a-web",
      type: "service",
      image: "example/web:1",
      command: [],
      args: [],
      env: {},
      depends: [],
    }],
    resources: [],
    routes: [],
  };

  await desiredStore.put(desired);
  await observedStore.record(
    snapshot("obs_old", "starting", "2026-04-27T00:01:00.000Z"),
  );
  await observedStore.record(
    snapshot("obs_new", "degraded", "2026-04-27T00:02:00.000Z"),
  );

  const latest = await observedStore.latestForGroup("space_a", "group_a");
  assert.equal(latest?.id, "obs_new");
  assert.equal(latest?.workloads[0]?.phase, "degraded");

  const canonical = await desiredStore.findByActivation(
    "space_a",
    "group_a",
    "activation_1",
  );
  assert.equal(canonical?.id, desired.id);
  assert.equal(canonical?.workloads[0]?.componentName, "web");
  assert.equal(canonical?.workloads[0]?.runtimeName, "group_a-web");
});

function snapshot(
  id: string,
  phase: RuntimeObservedStateSnapshot["workloads"][number]["phase"],
  observedAt: string,
): RuntimeObservedStateSnapshot {
  return {
    id,
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_1",
    desiredStateId: "space_a:group_a:activation_1",
    observedAt,
    workloads: [{ workloadId: "workload_web", phase }],
    resources: [],
    routes: [],
    diagnostics: [],
  };
}
