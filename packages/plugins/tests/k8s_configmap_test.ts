import assert from "node:assert/strict";
import {
  K8sConfigMapMaterializer,
  K8sDriftError,
  K8sNotFoundError,
  memoryConditionSink,
} from "../src/providers/k8s/mod.ts";
import {
  clockFrom,
  fakeDesired,
  FakeK8sClient,
  fakeResource,
  noopSleep,
} from "./k8s_test_helpers.ts";

function desiredWithEnv() {
  return {
    ...fakeDesired(),
    resources: [
      fakeResource({ env: { DB_HOST: "db.local", SECRET_KEY: "skip" } }),
    ],
  };
}

Deno.test("k8s configmap materialize returns undefined when no non-secret env present", async () => {
  const fake = new FakeK8sClient();
  const configMap = new K8sConfigMapMaterializer({ apply: fake });
  const op = await configMap.materialize("ns", fakeDesired());
  assert.equal(op, undefined);
});

Deno.test("k8s configmap materialize projects non-SECRET_ env vars", async () => {
  const fake = new FakeK8sClient();
  const configMap = new K8sConfigMapMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-1",
  });
  const op = await configMap.materialize("ns", desiredWithEnv());
  assert.ok(op);
  // db.SECRET_KEY must not be in the data; db.DB_HOST should be.
  const observed = [...fake.state.values()].find((s) => s.kind === "ConfigMap");
  assert.ok(observed);
  assert.equal(observed?.data?.["db.DB_HOST"], "db.local");
  assert.equal(observed?.data?.["db.SECRET_KEY"], undefined);
});

Deno.test("k8s configmap reconcile surfaces conditions for transient failures", async () => {
  const fake = new FakeK8sClient({ applyConfigMap: [503] });
  const sink = memoryConditionSink();
  const configMap = new K8sConfigMapMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-2",
    reconcile: {
      sleep: noopSleep(),
      initialBackoffMs: 1,
      conditionSink: sink.sink,
    },
  });
  const op = await configMap.reconcile("ns", desiredWithEnv());
  assert.ok(op);
  assert.ok(sink.conditions.some((c) => c.status === "true"));
});

Deno.test("k8s configmap getConfigMap throws NotFound when absent", async () => {
  const fake = new FakeK8sClient();
  const configMap = new K8sConfigMapMaterializer({ apply: fake, get: fake });
  await assert.rejects(
    () => configMap.getConfigMap("ns", "ghost"),
    (error) => error instanceof K8sNotFoundError,
  );
});

Deno.test("k8s configmap assertInSync detects data drift", async () => {
  const fake = new FakeK8sClient();
  const configMap = new K8sConfigMapMaterializer({
    apply: fake,
    get: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
  });
  const desired = desiredWithEnv();
  await configMap.materialize("ns", desired);
  const id = "ConfigMap:ns:docs-config";
  const observed = fake.state.get(id);
  assert.ok(observed);
  fake.state.set(id, {
    ...observed!,
    data: { "db.DB_HOST": "drifted.local" },
  });
  await assert.rejects(
    () => configMap.assertInSync("ns", desired),
    (error) => error instanceof K8sDriftError,
  );
});
