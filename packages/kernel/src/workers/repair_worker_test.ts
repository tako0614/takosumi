import assert from "node:assert/strict";
import type { ProviderMaterializationPlan } from "../adapters/provider/mod.ts";
import {
  BundledRegistrySeedAdapter,
  bundledRegistrySeedTrustRecords,
} from "../adapters/registry/mod.ts";
import {
  InMemoryRuntimeDesiredStateStore,
  type RuntimeDesiredState,
} from "../domains/runtime/mod.ts";
import { PackageConformanceService } from "../services/conformance/mod.ts";
import { ProviderOperationService } from "../services/provider-operations/mod.ts";
import { InMemoryOutboxStore } from "../shared/events.ts";
import { RepairWorker } from "./repair_worker.ts";

Deno.test("RepairWorker rematerializes with a trusted provider package", async () => {
  const desiredStates = new InMemoryRuntimeDesiredStateStore();
  await desiredStates.put(desiredState());
  const outbox = new InMemoryOutboxStore();
  const materializer = new FakeProviderMaterializer();
  const provider = new ProviderOperationService({
    provider: "provider.noop@v1",
    materializer,
    clock: sequenceClock([
      "2026-04-27T00:10:00.000Z",
      "2026-04-27T00:10:01.000Z",
    ]),
  });
  const worker = new RepairWorker({
    desiredStates,
    outboxStore: outbox,
    providerAssessor: new PackageConformanceService({
      registry: new BundledRegistrySeedAdapter(),
    }),
    providerOperations: {
      "provider.noop@v1": provider,
    },
  });

  const result = await worker.rematerializeWithTrustedPackage({
    spaceId: "space-a",
    groupId: "group-a",
    providerRef: "provider.noop@v1",
    requirements: { minimumTier: "tested" },
  });

  assert.equal(result.plan.kind, "repair-plan");
  assert.equal(result.plan.status, "rematerialized");
  assert.equal(result.plan.trustStatus, "trusted");
  assert.equal(result.plan.conformanceTier, "tested");
  assert.equal(result.operation?.status.status, "succeeded");
  assert.equal(materializer.callCount, 1);
  assert.equal(result.event.type, "runtime.repair.rematerialized");
  assert.match(
    result.plan.idempotencyKey ?? "",
    /^repair:space-a:group-a:activation-a:provider\.noop@v1:/,
  );
  const events = await outbox.listPending();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "runtime.repair.rematerialized");
});

Deno.test("RepairWorker blocks rematerialization when provider trust is revoked", async () => {
  const desiredStates = new InMemoryRuntimeDesiredStateStore();
  await desiredStates.put(desiredState());
  const materializer = new FakeProviderMaterializer();
  const trustRecords = bundledRegistrySeedTrustRecords.map((record) =>
    record.packageRef === "provider.noop@v1"
      ? {
        ...record,
        status: "revoked" as const,
        revokedAt: "2026-04-27T00:30:00.000Z",
        reason: "provider signing key was revoked",
      }
      : record
  );
  const worker = new RepairWorker({
    desiredStates,
    providerAssessor: new PackageConformanceService({
      registry: new BundledRegistrySeedAdapter(
        undefined,
        undefined,
        trustRecords,
      ),
    }),
    providerOperations: {
      "provider.noop@v1": new ProviderOperationService({
        provider: "provider.noop@v1",
        materializer,
      }),
    },
  });

  const result = await worker.rematerializeWithTrustedPackage({
    spaceId: "space-a",
    groupId: "group-a",
    providerRef: "provider.noop@v1",
    requirements: { minimumTier: "tested" },
  });

  assert.equal(result.plan.status, "blocked");
  assert.equal(result.plan.reason, "package-conformance-blocked");
  assert.equal(result.plan.trustStatus, "revoked");
  assert.equal(result.operation, undefined);
  assert.equal(materializer.callCount, 0);
  assert.ok(
    result.plan.issues.some((issue) => issue.code === "trust-record-revoked"),
  );
  assert.equal(result.event.type, "runtime.repair.blocked");
});

class FakeProviderMaterializer {
  callCount = 0;

  materialize(
    desired: RuntimeDesiredState,
  ): Promise<ProviderMaterializationPlan> {
    this.callCount += 1;
    return Promise.resolve({
      id: "repair-plan-provider-materialization",
      provider: "provider.noop@v1",
      desiredStateId: desired.id,
      recordedAt: "2026-04-27T00:10:01.000Z",
      operations: [{
        id: "repair-op-runtime",
        kind: "runtime.rematerialize",
        provider: "provider.noop@v1",
        desiredStateId: desired.id,
        targetId: desired.activationId,
        targetName: desired.appName,
        command: ["rematerialize", desired.activationId],
        details: {},
        recordedAt: "2026-04-27T00:10:00.000Z",
        execution: {
          status: "succeeded",
          code: 0,
          startedAt: "2026-04-27T00:10:00.000Z",
          completedAt: "2026-04-27T00:10:01.000Z",
        },
      }],
    });
  }
}

function desiredState(): RuntimeDesiredState {
  return {
    id: "space-a:group-a:activation-a",
    spaceId: "space-a",
    groupId: "group-a",
    activationId: "activation-a",
    appName: "demo-app",
    appVersion: "1.0.0",
    materializedAt: "2026-04-27T00:00:00.000Z",
    workloads: [{
      id: "workload-web",
      spaceId: "space-a",
      groupId: "group-a",
      activationId: "activation-a",
      componentName: "web",
      runtimeName: "group-a-web",
      type: "service",
      image: "ghcr.io/example/web:1",
      command: [],
      args: [],
      env: {},
      depends: [],
    }],
    resources: [],
    routes: [],
  };
}

function sequenceClock(values: readonly string[]): () => Date {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("test clock sequence exhausted");
    index += 1;
    return new Date(value);
  };
}
