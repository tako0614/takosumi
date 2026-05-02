import assert from "node:assert/strict";
import {
  K8sIngressMaterializer,
  K8sNotFoundError,
  memoryConditionSink,
} from "../src/providers/k8s/mod.ts";
import {
  clockFrom,
  fakeDesired,
  FakeK8sClient,
  fakeRoute,
  noopSleep,
} from "./k8s_test_helpers.ts";

const route = fakeRoute();

Deno.test("k8s ingress materialize returns undefined when no routes configured", async () => {
  const fake = new FakeK8sClient();
  const ingress = new K8sIngressMaterializer({ apply: fake });
  const op = await ingress.materialize("ns", fakeDesired());
  assert.equal(op, undefined);
});

Deno.test("k8s ingress materialize emits an apply operation when routes exist", async () => {
  const fake = new FakeK8sClient();
  const ingress = new K8sIngressMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-1",
  });
  const op = await ingress.materialize("ns", {
    ...fakeDesired(),
    routes: [route],
  });
  assert.ok(op);
  assert.equal(op?.kind, "k8s-ingress-apply");
  assert.equal(fake.calls.applyIngress?.length, 1);
});

Deno.test("k8s ingress reconcile surfaces retrying conditions on transient timeouts", async () => {
  const fake = new FakeK8sClient({ applyIngress: [504] });
  const sink = memoryConditionSink();
  const ingress = new K8sIngressMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-2",
    reconcile: {
      sleep: noopSleep(),
      initialBackoffMs: 1,
      conditionSink: sink.sink,
    },
  });
  const op = await ingress.reconcile("ns", {
    ...fakeDesired(),
    routes: [route],
  });
  assert.ok(op);
  assert.ok(sink.conditions.some((c) => c.reason?.startsWith("Retrying")));
});

Deno.test("k8s ingress getIngress rejects with NotFound when absent", async () => {
  const fake = new FakeK8sClient();
  const ingress = new K8sIngressMaterializer({ apply: fake, get: fake });
  await assert.rejects(
    () => ingress.getIngress("ns", "ghost"),
    (error) => error instanceof K8sNotFoundError,
  );
});

Deno.test("k8s ingress delete returns undefined when no remove client present", async () => {
  const fake = new FakeK8sClient();
  const ingress = new K8sIngressMaterializer({ apply: fake });
  const op = await ingress.deleteIngress("ns", "x");
  assert.equal(op, undefined);
});
