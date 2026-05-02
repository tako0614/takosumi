import assert from "node:assert/strict";
import {
  K8sNotFoundError,
  K8sSecretMaterializer,
  memoryConditionSink,
} from "../src/providers/k8s/mod.ts";
import {
  clockFrom,
  fakeDesired,
  FakeK8sClient,
  fakeResource,
  noopSleep,
} from "./k8s_test_helpers.ts";

function desiredWithSecret() {
  return {
    ...fakeDesired(),
    resources: [
      fakeResource({
        env: { SECRET_PASSWORD: "p4ssw0rd", DB_HOST: "drop-me" },
      }),
    ],
  };
}

Deno.test("k8s secret materialize returns undefined when no SECRET_ env present", async () => {
  const fake = new FakeK8sClient();
  const secret = new K8sSecretMaterializer({ apply: fake });
  const op = await secret.materialize("ns", fakeDesired());
  assert.equal(op, undefined);
});

Deno.test("k8s secret materialize stores only SECRET_-prefixed env keys", async () => {
  const fake = new FakeK8sClient();
  const secret = new K8sSecretMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-1",
  });
  const op = await secret.materialize("ns", desiredWithSecret());
  assert.ok(op);
  const observed = [...fake.state.values()].find((s) => s.kind === "Secret");
  assert.ok(observed);
  assert.equal(observed?.stringData?.["db.SECRET_PASSWORD"], "p4ssw0rd");
  assert.equal(observed?.stringData?.["db.DB_HOST"], undefined);
});

Deno.test("k8s secret reconcile retries Forbidden once and fails fast", async () => {
  // Forbidden is non-retryable, so reconcile must surface the error on the
  // first attempt rather than burning the retry budget.
  const fake = new FakeK8sClient({ applySecret: [403] });
  const sink = memoryConditionSink();
  const secret = new K8sSecretMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-2",
    reconcile: {
      sleep: noopSleep(),
      initialBackoffMs: 1,
      conditionSink: sink.sink,
    },
  });
  await assert.rejects(
    () => secret.reconcile("ns", desiredWithSecret()),
    (error) => (error as { code?: string }).code === "forbidden",
  );
  assert.equal(fake.calls.applySecret?.length, 1);
});

Deno.test("k8s secret getSecret rejects with NotFound when absent", async () => {
  const fake = new FakeK8sClient();
  const secret = new K8sSecretMaterializer({ apply: fake, get: fake });
  await assert.rejects(
    () => secret.getSecret("ns", "ghost"),
    (error) => error instanceof K8sNotFoundError,
  );
});

Deno.test("k8s secret deleteSecret produces a delete operation when remove client wired", async () => {
  const fake = new FakeK8sClient();
  const secret = new K8sSecretMaterializer({
    apply: fake,
    remove: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id-3",
  });
  await secret.materialize("ns", desiredWithSecret());
  const op = await secret.deleteSecret("ns", "docs-secrets");
  assert.equal(op?.kind, "k8s-secret-delete");
});
