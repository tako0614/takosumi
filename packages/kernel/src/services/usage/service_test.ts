import assert from "node:assert/strict";
import {
  type BillingPort,
  type BillingUsageProjectionNotice,
  InMemoryUsageAggregateStore,
  NoopBillingPort,
  type UsageEventDto,
  UsageProjectionService,
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

function runtimeEvent(): UsageEventDto {
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
  };
}

function resourceEvent(): UsageEventDto {
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
  };
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
