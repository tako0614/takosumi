import assert from "node:assert/strict";
import {
  K8sDriftError,
  K8sNamespaceMaterializer,
  K8sNotFoundError,
  memoryConditionSink,
} from "../src/providers/k8s/mod.ts";
import {
  clockFrom,
  fakeDesired,
  FakeK8sClient,
  noopSleep,
} from "./k8s_test_helpers.ts";

Deno.test("k8s namespace ensure produces a successful provider operation with labels", async () => {
  const fake = new FakeK8sClient();
  const namespace = new K8sNamespaceMaterializer({
    apply: fake,
    get: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-1",
  });
  const op = await namespace.ensure(fakeDesired());

  assert.equal(op.kind, "k8s-namespace-apply");
  assert.equal(op.execution?.status, "succeeded");
  assert.equal(fake.calls.applyNamespace?.length, 1);
});

Deno.test("k8s namespace reconcile retries Conflict and emits attempt conditions", async () => {
  const fake = new FakeK8sClient({ applyNamespace: [409, 409] });
  const sink = memoryConditionSink();
  const namespace = new K8sNamespaceMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-2",
    reconcile: {
      sleep: noopSleep(),
      initialBackoffMs: 1,
      conditionSink: sink.sink,
    },
  });

  const op = await namespace.reconcile(fakeDesired());

  assert.equal(op.execution?.status, "succeeded");
  // 2 retries + 1 success → at least 3 condition records emitted
  assert.ok(sink.conditions.length >= 3);
  assert.ok(sink.conditions.some((c) => c.reason?.startsWith("Retrying")));
  const success = sink.conditions.find((c) =>
    c.status === "true" && c.reason === "Succeeded"
  );
  assert.ok(success, "expected a Succeeded condition");
});

Deno.test("k8s namespace get rejects with K8sNotFoundError when missing", async () => {
  const fake = new FakeK8sClient();
  const namespace = new K8sNamespaceMaterializer({ apply: fake, get: fake });
  await assert.rejects(
    () => namespace.get("ghost"),
    (error) => error instanceof K8sNotFoundError,
  );
});

Deno.test("k8s namespace remove yields a delete operation when remove client is wired", async () => {
  const fake = new FakeK8sClient();
  const namespace = new K8sNamespaceMaterializer({
    apply: fake,
    remove: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-3",
  });
  const desired = fakeDesired();
  await namespace.ensure(desired);
  const op = await namespace.remove(desired);
  assert.ok(op);
  assert.equal(op?.kind, "k8s-namespace-delete");
});

Deno.test("k8s namespace assertInSync throws K8sDriftError when labels diverge", async () => {
  const fake = new FakeK8sClient();
  const namespace = new K8sNamespaceMaterializer({
    apply: fake,
    get: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
  });
  const desired = fakeDesired();
  await namespace.ensure(desired);
  // Mutate observed labels to simulate drift.
  const ns = fake.state.get(
    `Namespace:_:${namespace.resolveNamespace(desired)}`,
  );
  if (!ns) throw new Error("expected namespace state");
  fake.state.set(`Namespace:_:${namespace.resolveNamespace(desired)}`, {
    ...ns,
    metadata: {
      ...ns.metadata,
      labels: { ...(ns.metadata.labels ?? {}), "takos.jp/space": "drifted" },
    },
  });
  await assert.rejects(
    () => namespace.assertInSync(desired),
    (error) => error instanceof K8sDriftError,
  );
});
