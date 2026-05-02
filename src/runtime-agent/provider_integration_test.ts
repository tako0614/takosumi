/**
 * Integration tests covering provider-level long-running handoff hooks.
 *
 * Each provider exposes a `runtimeAgentHandoff` shaped hook (AWS / k8s
 * via `*RuntimeHooks`, GCP via `GcpRuntimeHooks`). The bridge in
 * `./handoff.ts` adapts the kernel's `RuntimeAgentRegistry` to those hook
 * shapes. These tests ensure the wire-up actually delegates to the
 * registry on each provider.
 */
import assert from "node:assert/strict";
import { InMemoryRuntimeAgentRegistry } from "takosumi-contract";
import {
  DEFAULT_AWS_LONG_RUNNING_THRESHOLD_MS,
  deriveAwsHandoffKey,
  shouldAwsHandoff,
} from "../providers/aws/support.ts";
import {
  DEFAULT_K8S_LONG_RUNNING_THRESHOLD_MS,
  deriveK8sHandoffKey,
  shouldK8sHandoff,
} from "../providers/k8s/reconcile.ts";
import { resolveRuntimeContext } from "../providers/gcp/_runtime.ts";
import { createProviderHandoff } from "./handoff.ts";

Deno.test("AWS long-running threshold defaults to 30s and respects override", () => {
  assert.equal(DEFAULT_AWS_LONG_RUNNING_THRESHOLD_MS, 30_000);
  assert.equal(shouldAwsHandoff(45_000), false); // no hook
  const registry = new InMemoryRuntimeAgentRegistry();
  const handoff = createProviderHandoff({ registry, provider: "aws" });
  assert.equal(
    shouldAwsHandoff(45_000, { runtimeAgentHandoff: handoff }),
    true,
  );
  assert.equal(
    shouldAwsHandoff(20_000, { runtimeAgentHandoff: handoff }),
    false,
  );
  assert.equal(
    shouldAwsHandoff(20_000, {
      runtimeAgentHandoff: handoff,
      longRunningThresholdMs: 15_000,
    }),
    true,
  );
});

Deno.test("AWS handoff key derivation is deterministic", () => {
  const a = deriveAwsHandoffKey("rds.create", "ds_1", "primary");
  const b = deriveAwsHandoffKey("rds.create", "ds_1", "primary");
  const c = deriveAwsHandoffKey("rds.create", "ds_1");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

Deno.test("AWS provider handoff bridge enqueues onto the kernel registry", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const handoff = createProviderHandoff({ registry, provider: "aws" });
  const id = await handoff.enqueue({
    descriptor: "rds.create",
    desiredStateId: "ds_1",
    targetId: "primary",
    idempotencyKey: deriveAwsHandoffKey("rds.create", "ds_1", "primary"),
    payload: { engine: "postgres" },
  });
  const work = await registry.getWork(id);
  assert.equal(work?.kind, "provider.aws.rds.create");
});

Deno.test("k8s long-running threshold defaults to 30s and respects override", () => {
  assert.equal(DEFAULT_K8S_LONG_RUNNING_THRESHOLD_MS, 30_000);
  assert.equal(shouldK8sHandoff(45_000), false); // no hook
  const registry = new InMemoryRuntimeAgentRegistry();
  const handoff = createProviderHandoff({ registry, provider: "k8s" });
  assert.equal(
    shouldK8sHandoff(45_000, { runtimeAgentHandoff: handoff }),
    true,
  );
  assert.equal(
    shouldK8sHandoff(60_000, {
      runtimeAgentHandoff: handoff,
      longRunningThresholdMs: 90_000,
    }),
    false,
  );
});

Deno.test("k8s handoff key derivation tolerates missing target", () => {
  assert.equal(
    deriveK8sHandoffKey("deployment.apply", "ds_1"),
    "k8s-deployment.apply-ds_1-default",
  );
});

Deno.test("k8s provider handoff bridge enqueues onto the kernel registry", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const handoff = createProviderHandoff({ registry, provider: "k8s" });
  const id = await handoff.enqueue({
    descriptor: "deployment.apply",
    desiredStateId: "ds_k8s_1",
    targetId: "tenant-123/web",
    payload: { replicas: 3 },
  });
  const work = await registry.getWork(id);
  assert.equal(work?.kind, "provider.k8s.deployment.apply");
  assert.equal(work?.payload.replicas, 3);
});

Deno.test("GCP runtime context honours runtime-agent handoff via the bridge", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const handoff = createProviderHandoff({ registry, provider: "gcp" });
  const ctx = resolveRuntimeContext({ runtimeAgentHandoff: handoff });
  assert.ok(ctx.handoff);
  const id = await ctx.handoff.enqueue({
    descriptor: "cloud-run.deploy",
    desiredStateId: "ds_cr_1",
    targetId: "web",
    idempotencyKey: "gcp-cr-web",
    enqueuedAt: "2026-04-27T00:00:00.000Z",
  });
  const work = await registry.getWork(id);
  assert.equal(work?.kind, "provider.gcp.cloud-run.deploy");
});

Deno.test("provider handoff bridge skips enqueue when threshold not crossed", () => {
  const registry = new InMemoryRuntimeAgentRegistry();
  const handoff = createProviderHandoff({ registry, provider: "aws" });
  // The bridge itself doesn't gate — providers gate via shouldAwsHandoff.
  // Cross-check: shouldAwsHandoff is false for short ops even with hook set.
  assert.equal(
    shouldAwsHandoff(1_000, { runtimeAgentHandoff: handoff }),
    false,
  );
});
