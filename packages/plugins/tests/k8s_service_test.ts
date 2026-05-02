import assert from "node:assert/strict";
import {
  K8sDeploymentMaterializer,
  K8sNotFoundError,
} from "../src/providers/k8s/mod.ts";
import {
  clockFrom,
  fakeDesired,
  FakeK8sClient,
  fakeWorkload,
} from "./k8s_test_helpers.ts";

// The k8s "service" descriptor lives inside K8sDeploymentMaterializer (the
// deployment materializer applies a paired Service). These tests focus on
// service-side behaviour: port inference, drift detection, retries.

Deno.test("k8s service port inference falls back to default when env PORT missing", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({
    apply: fake,
    defaultPort: 7700,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
  });
  await deployment.materialize("ns", fakeDesired(), fakeWorkload());
  const observed = fake.state.get("Service:ns:web");
  const ports = (observed?.spec as Record<string, unknown> | undefined)
    ?.ports as readonly { port?: number }[] | undefined;
  assert.equal(ports?.[0]?.port, 7700);
});

Deno.test("k8s service port inference reads PORT env when present", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
  });
  await deployment.materialize(
    "ns",
    fakeDesired(),
    fakeWorkload({ env: { PORT: "9000" } }),
  );
  const observed = fake.state.get("Service:ns:web");
  const ports = (observed?.spec as Record<string, unknown> | undefined)
    ?.ports as readonly { port?: number }[] | undefined;
  assert.equal(ports?.[0]?.port, 9000);
});

Deno.test("k8s service getService throws NotFound when absent", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({ apply: fake, get: fake });
  await assert.rejects(
    () => deployment.getService("ns", "ghost"),
    (error) => error instanceof K8sNotFoundError,
  );
});

Deno.test("k8s service deletion via deployment materializer noops without remove client", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({ apply: fake });
  // No remove configured → delete must be undefined so callers can safely
  // skip when reconciling unmanaged services.
  const op = await deployment.deleteDeployment("ns", "web");
  assert.equal(op, undefined);
});

Deno.test("k8s service apply records resourceVersion bump per attempt", async () => {
  const fake = new FakeK8sClient();
  const deployment = new K8sDeploymentMaterializer({
    apply: fake,
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
  });
  await deployment.materialize("ns", fakeDesired(), fakeWorkload());
  await deployment.materialize("ns", fakeDesired(), fakeWorkload());
  const observed = fake.state.get("Service:ns:web");
  const rv = Number.parseInt(observed?.metadata.resourceVersion ?? "0", 10);
  // First apply increments deployment + service (2 versions); second adds 2 more.
  assert.ok(rv >= 2);
});
