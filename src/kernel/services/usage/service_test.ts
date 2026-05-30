import assert from "node:assert/strict";
import {
  type BillingPort,
  type BillingUsageProjectionNotice,
  InMemoryUsageAggregateStore,
  LocalUsageQuotaPolicy,
  NoopBillingPort,
  type ResourceUsageEventDto,
  type RuntimeUsageEventDto,
  type UsageEventDto,
  UsageProjectionService,
  UsageQuotaExceededError,
} from "./mod.ts";

Deno.test("UsageProjectionService aggregates deploy/runtime/resource/agent usage events", async () => {
  const aggregates = new InMemoryUsageAggregateStore();
  const service = new UsageProjectionService({
    aggregates,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  await service.record(deployEvent({ id: "deploy_1", quantity: 1 }));
  const deploy = await service.record(
    deployEvent({
      id: "deploy_2",
      quantity: 2,
      occurredAt: "2026-04-26T23:00:00.000Z",
    }),
  );
  await service.record(runtimeEvent());
  await service.record(resourceEvent());
  await service.record(agentEvent());

  assert.equal(deploy.aggregate.ownerKind, "deploy");
  assert.equal(deploy.aggregate.metric, "deploy.apply");
  assert.equal(deploy.aggregate.quantity, 3);
  assert.equal(deploy.aggregate.eventCount, 2);
  assert.equal(
    deploy.aggregate.firstOccurredAt,
    "2026-04-26T23:00:00.000Z",
  );
  assert.equal(
    deploy.aggregate.lastOccurredAt,
    "2026-04-27T01:00:00.000Z",
  );
  assert.deepEqual(
    (await aggregates.listBySpace("space_a")).map((aggregate) => [
      aggregate.ownerKind,
      aggregate.metric,
      aggregate.quantity,
    ]),
    [
      ["deploy", "deploy.apply", 3],
      ["runtime", "runtime.worker_milliseconds", 250],
      ["resource", "resource.storage_bytes", 4096],
      ["agent", "agent.step", 4],
    ],
  );
});

Deno.test("NoopBillingPort is an explicit billing boundary and does not own usage aggregates", async () => {
  const aggregates = new InMemoryUsageAggregateStore();
  const billing = new NoopBillingPort();
  const service = new UsageProjectionService({
    aggregates,
    billing,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const result = await service.record(agentEvent());

  assert.equal(result.billingForwarded, false);
  assert.equal(result.aggregate.quantity, 4);
  assert.equal((await aggregates.listBySpace("space_a")).length, 1);
  assert.equal("invoiceId" in result.aggregate, false);
  assert.equal("priceId" in result.aggregate, false);
});

Deno.test("UsageProjectionService can cross the BillingPort without coupling aggregate storage to billing", async () => {
  const aggregates = new InMemoryUsageAggregateStore();
  const billing = new RecordingBillingPort();
  const service = new UsageProjectionService({ aggregates, billing });

  const result = await service.record(resourceEvent());

  assert.equal(billing.notices.length, 1);
  assert.equal(billing.notices[0]?.aggregate, result.aggregate);
  assert.equal((await aggregates.listBySpace("space_a"))[0], result.aggregate);
});

Deno.test("UsageProjectionService reports CPU storage and bandwidth quota tiers", async () => {
  const aggregates = new InMemoryUsageAggregateStore();
  const quotaPolicy = new LocalUsageQuotaPolicy({
    defaultTierId: "free",
    tiers: {
      free: {
        limits: {
          cpuMilliseconds: 300,
          storageBytes: 4096,
          bandwidthBytes: 1024,
        },
      },
      team: {
        limits: {
          cpuMilliseconds: 1000,
          storageBytes: 8192,
          bandwidthBytes: 2048,
        },
      },
    },
    spaces: {
      space_a: "team",
      space_b: { tierId: "free", limits: { bandwidthBytes: 128 } },
    },
  });
  const service = new UsageProjectionService({
    aggregates,
    quotaPolicy,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const cpu = await service.record(runtimeEvent({ quantity: 250 }));
  assert.equal(cpu.quotaDecision?.key, "cpuMilliseconds");
  assert.equal(cpu.quotaDecision?.tierId, "team");
  assert.equal(cpu.quotaDecision?.allowed, true);
  assert.equal(cpu.quotaDecision?.limit, 1000);

  const storage = await service.record(resourceEvent({ quantity: 4096 }));
  assert.equal(storage.quotaDecision?.key, "storageBytes");
  assert.equal(storage.quotaDecision?.allowed, true);

  const bandwidth = await service.record(bandwidthEvent({
    spaceId: "space_b",
    quantity: 256,
  }));
  assert.equal(bandwidth.quotaDecision?.key, "bandwidthBytes");
  assert.equal(bandwidth.quotaDecision?.tierId, "free");
  assert.equal(bandwidth.quotaDecision?.limit, 128);
  assert.equal(bandwidth.quotaDecision?.allowed, false);
});

Deno.test("UsageProjectionService requireWithinQuota rejects before recording", async () => {
  const aggregates = new InMemoryUsageAggregateStore();
  const service = new UsageProjectionService({
    aggregates,
    quotaPolicy: new LocalUsageQuotaPolicy({
      defaultTierId: "free",
      tiers: { free: { limits: { cpuMilliseconds: 300 } } },
    }),
  });

  await service.requireWithinQuota(runtimeEvent({ quantity: 250 }));
  await assert.rejects(
    () => service.requireWithinQuota(runtimeEvent({ id: "runtime_usage_2" })),
    (error) =>
      error instanceof UsageQuotaExceededError &&
      error.decision.key === "cpuMilliseconds" &&
      error.decision.quantity === 500 &&
      error.decision.limit === 300,
  );

  const aggregatesAfterReject = await aggregates.listBySpace("space_a");
  assert.equal(aggregatesAfterReject.length, 1);
  assert.equal(aggregatesAfterReject[0].quantity, 250);
});

class RecordingBillingPort implements BillingPort {
  readonly notices: BillingUsageProjectionNotice[] = [];

  projectUsage(notice: BillingUsageProjectionNotice): Promise<void> {
    this.notices.push(notice);
    return Promise.resolve();
  }
}

function deployEvent(
  overrides: Partial<UsageEventDto> = {},
): UsageEventDto {
  return {
    kind: "deploy",
    id: "deploy_usage_1",
    spaceId: "space_a",
    groupId: "group_a",
    occurredAt: "2026-04-27T01:00:00.000Z",
    quantity: 1,
    unit: "count",
    metric: "deploy.apply",
    deployId: "deploy_a",
    ...overrides,
  } as UsageEventDto;
}

function runtimeEvent(
  overrides: Partial<RuntimeUsageEventDto> = {},
): RuntimeUsageEventDto {
  return {
    kind: "runtime",
    id: "runtime_usage_1",
    spaceId: "space_a",
    groupId: "group_a",
    occurredAt: "2026-04-27T01:05:00.000Z",
    quantity: 250,
    unit: "millisecond",
    metric: "runtime.worker_milliseconds",
    runtimeId: "runtime_a",
    workloadId: "worker_a",
    ...overrides,
  };
}

function resourceEvent(
  overrides: Partial<ResourceUsageEventDto> = {},
): ResourceUsageEventDto {
  return {
    kind: "resource",
    id: "resource_usage_1",
    spaceId: "space_a",
    groupId: "group_a",
    occurredAt: "2026-04-27T01:10:00.000Z",
    quantity: 4096,
    unit: "byte",
    metric: "resource.storage_bytes",
    resourceInstanceId: "resource_a",
    resourceContract: "postgres.v1",
    ...overrides,
  };
}

function bandwidthEvent(
  overrides: Partial<RuntimeUsageEventDto> = {},
): RuntimeUsageEventDto {
  return runtimeEvent({
    id: "bandwidth_usage_1",
    quantity: 1024,
    unit: "byte",
    metric: "runtime.bandwidth_bytes",
    ...overrides,
  });
}

function agentEvent(): UsageEventDto {
  return {
    kind: "agent",
    id: "agent_usage_1",
    spaceId: "space_a",
    groupId: "group_a",
    occurredAt: "2026-04-27T01:15:00.000Z",
    quantity: 4,
    unit: "count",
    metric: "agent.step",
    agentRunId: "agent_run_a",
    agentId: "agent_a",
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}
