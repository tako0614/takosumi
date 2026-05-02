import assert from "node:assert/strict";
import {
  K8sDeploymentMaterializer,
  K8sDriftError,
  K8sNotFoundError,
  memoryConditionSink,
} from "../src/providers/k8s/mod.ts";
import {
  clockFrom,
  fakeDesired,
  FakeK8sClient,
  fakeWorkload,
  noopSleep,
} from "./k8s_test_helpers.ts";

Deno.test("k8s deployment materialize emits both deployment and service operations", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-1",
  });
  const result = await deployment.materialize(
    "takos-space-1-group-1",
    fakeDesired(),
    fakeWorkload(),
  );

  assert.equal(result.deployment.kind, "k8s-deployment-apply");
  assert.equal(result.service.kind, "k8s-service-apply");
  assert.equal(result.serviceName, "web");
});

Deno.test("k8s deployment reconcile retries throttled errors with backoff", async () => {
  const fake = new FakeK8sClient({ applyDeployment: [429] });
  const sink = memoryConditionSink();
  const deployment = new K8sDeploymentMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-2",
    reconcile: {
      sleep: noopSleep(),
      initialBackoffMs: 1,
      conditionSink: sink.sink,
    },
  });

  const result = await deployment.reconcile(
    "takos-ns",
    fakeDesired(),
    fakeWorkload(),
  );
  assert.equal(result.deployment.execution?.status, "succeeded");
  assert.ok(sink.conditions.some((c) => c.reason?.startsWith("Retrying")));
});

Deno.test("k8s deployment getDeployment rejects with NotFound when absent", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({ apply: fake, get: fake });
  await assert.rejects(
    () => deployment.getDeployment("ns", "ghost"),
    (error) => error instanceof K8sNotFoundError,
  );
});

Deno.test("k8s deployment delete returns operation when remove client wired", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({
    apply: fake,
    remove: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-3",
  });
  await deployment.materialize("takos-ns", fakeDesired(), fakeWorkload());
  const op = await deployment.deleteDeployment("takos-ns", "web");
  assert.equal(op?.kind, "k8s-deployment-delete");
});

Deno.test("k8s deployment assertInSync detects image drift", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({
    apply: fake,
    get: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
  });
  await deployment.materialize(
    "takos-ns",
    fakeDesired(),
    fakeWorkload({ image: "ghcr.io/x/web:1.0" }),
  );
  // Drift the observed image
  const id = "Deployment:takos-ns:web";
  const observed = fake.state.get(id)!;
  fake.state.set(id, {
    ...observed,
    spec: {
      ...observed.spec,
      template: {
        ...((observed.spec?.template as Record<string, unknown>) ?? {}),
        spec: { containers: [{ image: "drifted:tag" }] },
      },
    },
  });
  await assert.rejects(
    () =>
      deployment.assertInSync(
        "takos-ns",
        fakeWorkload({ image: "ghcr.io/x/web:1.0" }),
      ),
    (error) => error instanceof K8sDriftError,
  );
});
