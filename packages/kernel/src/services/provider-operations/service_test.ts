import assert from "node:assert/strict";
import type {
  ProviderMaterializationPlan,
  ProviderMaterializer,
  ProviderOperation,
} from "../../adapters/provider/mod.ts";
import { InMemoryAuditStore } from "../../domains/audit/mod.ts";
import type { RuntimeDesiredState } from "../../domains/runtime/mod.ts";
import {
  classifyProviderOperationFailure,
  deriveProviderOperationIdempotencyKey,
  ProviderOperationService,
} from "./mod.ts";

Deno.test("ProviderOperationService materializes provider output and returns success status", async () => {
  const provider = new FakeProviderMaterializer({
    plan: providerPlan({ id: "plan-success", operationStatus: "succeeded" }),
  });
  const service = new ProviderOperationService({
    provider: "fake",
    materializer: provider,
    clock: sequenceClock([
      "2026-04-27T00:00:00.000Z",
      "2026-04-27T00:00:01.000Z",
    ]),
  });

  const result = await service.execute({ desiredState: desiredState() });

  assert.equal(provider.callCount, 1);
  assert.equal(result.status.status, "succeeded");
  assert.equal(result.status.provider, "fake");
  assert.equal(result.status.desiredStateId, "space-a:group-a:activation-a");
  assert.equal(result.status.activationId, "activation-a");
  assert.equal(result.status.materializationPlanId, "plan-success");
  assert.equal(result.status.recordedOperationCount, 1);
  assert.equal(result.status.failedProviderOperationCount, 0);
  assert.equal(result.status.retryable, false);
  assert.equal(result.status.startedAt, "2026-04-27T00:00:00.000Z");
  assert.equal(result.status.updatedAt, "2026-04-27T00:00:01.000Z");
  assert.match(
    result.status.idempotencyKey,
    /^provider-operation:fake:space-a:group-a:activation-a:[0-9a-f]{64}$/,
  );
  assert.deepEqual(
    await service.getStatus(result.status.idempotencyKey),
    result.status,
  );
});

Deno.test("ProviderOperationService replays same idempotency key without invoking provider again", async () => {
  const provider = new FakeProviderMaterializer({
    plan: providerPlan({ id: "plan-once", operationStatus: "succeeded" }),
  });
  const service = new ProviderOperationService({
    provider: "fake",
    materializer: provider,
    clock: sequenceClock([
      "2026-04-27T00:01:00.000Z",
      "2026-04-27T00:01:01.000Z",
    ]),
  });
  const desired = desiredState();
  const idempotencyKey = await deriveProviderOperationIdempotencyKey({
    provider: "fake",
    desiredState: desired,
  });

  const first = await service.execute({
    desiredState: desired,
    idempotencyKey,
  });
  const second = await service.execute({
    desiredState: desired,
    idempotencyKey,
  });

  assert.equal(provider.callCount, 1);
  assert.deepEqual(second.status, first.status);
  assert.deepEqual(second.record, first.record);
});

Deno.test("ProviderOperationService classifies failed provider operation status", async () => {
  const provider = new FakeProviderMaterializer({
    plan: providerPlan({
      id: "plan-failed",
      operationStatus: "failed",
      stderr: "invalid image reference",
    }),
  });
  const service = new ProviderOperationService({
    provider: "fake",
    materializer: provider,
    clock: sequenceClock([
      "2026-04-27T00:02:00.000Z",
      "2026-04-27T00:02:01.000Z",
    ]),
  });

  const result = await service.execute({ desiredState: desiredState() });

  assert.equal(provider.callCount, 1);
  assert.equal(result.status.status, "failed");
  assert.equal(result.status.materializationPlanId, "plan-failed");
  assert.equal(result.status.recordedOperationCount, 1);
  assert.equal(result.status.failedProviderOperationCount, 1);
  assert.equal(result.status.failureReason, "provider_rejected");
  assert.equal(result.status.retryable, false);
  assert.match(result.status.message ?? "", /invalid image reference/);
});

Deno.test("ProviderOperationService classifies thrown transient provider failures", async () => {
  const provider = new FakeProviderMaterializer({
    error: new Error("connection refused by provider daemon"),
  });
  const service = new ProviderOperationService({
    provider: "fake",
    materializer: provider,
    clock: sequenceClock([
      "2026-04-27T00:03:00.000Z",
      "2026-04-27T00:03:01.000Z",
    ]),
  });

  const result = await service.execute({ desiredState: desiredState() });

  assert.equal(provider.callCount, 1);
  assert.equal(result.status.status, "failed");
  assert.equal(result.status.materializationPlanId, undefined);
  assert.equal(result.status.recordedOperationCount, 0);
  assert.equal(result.status.failureReason, "provider_unavailable");
  assert.equal(result.status.retryable, true);
});

Deno.test("ProviderOperationService writes an audit event when provider credentials are used", async () => {
  const auditStore = new InMemoryAuditStore();
  const service = new ProviderOperationService({
    provider: "fake",
    materializer: new FakeProviderMaterializer({
      plan: providerPlan({ id: "plan-audit", operationStatus: "succeeded" }),
    }),
    auditStore,
    auditIdFactory: () => "audit_provider_credentials",
    clock: sequenceClock([
      "2026-04-27T00:04:00.000Z",
      "2026-04-27T00:04:01.000Z",
    ]),
  });

  await service.execute({
    desiredState: desiredState(),
    credentialRefs: ["secret://providers/fake"],
    actorId: "worker/provider",
    requestId: "req_provider",
  });

  const events = await auditStore.list({
    type: "provider.credentials.used",
    targetType: "provider-operation",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "audit_provider_credentials");
  assert.equal(events[0].eventClass, "security");
  assert.equal(events[0].severity, "warning");
  assert.deepEqual(events[0].payload.credentialRefs, [
    "secret://providers/fake",
  ]);
  assert.equal(events[0].payload.actorId, "worker/provider");
  assert.equal(events[0].requestId, "req_provider");
});

Deno.test("classifyProviderOperationFailure maps timeout to retryable timeout", () => {
  assert.deepEqual(
    classifyProviderOperationFailure(new Error("request timed out")),
    {
      reason: "provider_timeout",
      retryable: true,
      message: "request timed out",
    },
  );
});

class FakeProviderMaterializer implements ProviderMaterializer {
  callCount = 0;
  readonly #plan?: ProviderMaterializationPlan;
  readonly #error?: unknown;

  constructor(options: {
    readonly plan?: ProviderMaterializationPlan;
    readonly error?: unknown;
  }) {
    this.#plan = options.plan;
    this.#error = options.error;
  }

  materialize(
    _desiredState: RuntimeDesiredState,
  ): Promise<ProviderMaterializationPlan> {
    this.callCount += 1;
    if (this.#error) return Promise.reject(this.#error);
    if (!this.#plan) throw new Error("fake provider plan missing");
    return Promise.resolve(this.#plan);
  }

  listRecordedOperations(): Promise<readonly ProviderOperation[]> {
    return Promise.resolve(this.#plan?.operations ?? []);
  }

  clearRecordedOperations(): Promise<void> {
    return Promise.resolve();
  }
}

function providerPlan(options: {
  readonly id: string;
  readonly operationStatus: "succeeded" | "failed";
  readonly stderr?: string;
}): ProviderMaterializationPlan {
  const execution = {
    status: options.operationStatus,
    code: options.operationStatus === "succeeded" ? 0 : 1,
    stderr: options.stderr,
    startedAt: "2026-04-27T00:00:00.000Z",
    completedAt: "2026-04-27T00:00:00.500Z",
  } as const;
  return {
    id: options.id,
    provider: "fake",
    desiredStateId: "space-a:group-a:activation-a",
    recordedAt: "2026-04-27T00:00:00.500Z",
    operations: [{
      id: `${options.id}:op`,
      kind: "noop",
      provider: "fake",
      desiredStateId: "space-a:group-a:activation-a",
      targetId: "space-a:group-a:activation-a",
      targetName: "demo-app",
      command: [],
      details: {},
      recordedAt: "2026-04-27T00:00:00.000Z",
      execution,
    }],
  };
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
