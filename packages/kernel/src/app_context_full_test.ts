import assert from "node:assert/strict";
import { createInMemoryAppContext } from "./app_context.ts";
import { NoopTestKms } from "./adapters/kms/mod.ts";
import { InMemoryRouterConfigAdapter } from "./adapters/router/mod.ts";
import { NoopProviderMaterializer } from "./adapters/provider/mod.ts";
import { ImmutableManifestSourceAdapter } from "./adapters/source/mod.ts";
import { MemoryStorageDriver } from "./adapters/storage/mod.ts";
import { MemoryQueueAdapter } from "./adapters/queue/mod.ts";
import { MemoryObjectStorage } from "./adapters/object-storage/mod.ts";
import { InMemoryObservabilitySink } from "./services/observability/mod.ts";
import { UsageProjectionService } from "./services/usage/mod.ts";
import { ServiceEndpointRegistry } from "./domains/service-endpoints/mod.ts";
import { EntitlementPolicyService } from "./services/entitlements/mod.ts";

Deno.test("createInMemoryAppContext exposes full optional composition fields", async () => {
  const context = createInMemoryAppContext({
    dateClock: () => new Date("2026-04-27T00:00:00.000Z"),
    uuidFactory: () => "fixed",
  });

  assert.ok(context.adapters.kms instanceof NoopTestKms);
  assert.ok(
    context.adapters.observability instanceof InMemoryObservabilitySink,
  );
  assert.ok(
    context.adapters.routerConfig instanceof InMemoryRouterConfigAdapter,
  );
  assert.ok(context.adapters.queue instanceof MemoryQueueAdapter);
  assert.ok(context.adapters.objectStorage instanceof MemoryObjectStorage);
  assert.ok(
    context.services.usage.projection instanceof UsageProjectionService,
  );
  assert.ok(
    context.services.serviceEndpoints.registry instanceof
      ServiceEndpointRegistry,
  );
  assert.ok(
    context.services.entitlements.policy instanceof EntitlementPolicyService,
  );

  assert.deepEqual(await context.adapters.kms.activeKeyRef(), {
    provider: "test-noop",
    keyId: "test",
    keyVersion: "v1",
  });
  assert.deepEqual(await context.adapters.observability.listMetrics(), []);
});

Deno.test("full AppContext wires queue and object storage default adapters", async () => {
  const context = createInMemoryAppContext({
    dateClock: () => new Date("2026-04-27T00:00:00.000Z"),
    uuidFactory: () => "fixed",
  });

  const message = await context.adapters.queue.enqueue({
    queue: "deploy.apply",
    payload: { activationId: "activation_a" },
  });
  assert.equal(message.id, "msg_fixed");
  const lease = await context.adapters.queue.lease({ queue: "deploy.apply" });
  assert.equal(lease?.message.id, "msg_fixed");

  const head = await context.adapters.objectStorage.putObject({
    bucket: "takos-artifacts",
    key: "space/group/artifact.json",
    body: JSON.stringify({ ok: true }),
    contentType: "application/json",
  });
  assert.equal(head.contentType, "application/json");
  assert.equal(
    (await context.adapters.objectStorage.getObject({
      bucket: "takos-artifacts",
      key: "space/group/artifact.json",
      expectedDigest: head.digest,
    }))?.digest,
    head.digest,
  );
});

Deno.test("full AppContext composition remains backed by in-memory stores", async () => {
  const context = createInMemoryAppContext({
    dateClock: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  const usage = await context.services.usage.projection.record({
    kind: "agent",
    id: "usage_1",
    spaceId: "space_a",
    groupId: "group_a",
    occurredAt: "2026-04-27T00:00:00.000Z",
    quantity: 2,
    unit: "count",
    metric: "agent.step",
    agentRunId: "agent_run_a",
  });
  assert.equal(usage.aggregate.quantity, 2);
  assert.deepEqual(
    await context.stores.usage.aggregates.listBySpace("space_a"),
    [
      usage.aggregate,
    ],
  );

  const endpoint = await context.services.serviceEndpoints.registry
    .registerEndpoint({
      id: "endpoint_a",
      serviceId: "service_a",
      spaceId: "space_a",
      groupId: "group_a",
      name: "api",
      protocol: "https",
      url: "https://api.example.test",
      health: {
        status: "unknown",
        checkedAt: "2026-04-27T00:00:00.000Z",
      },
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    });
  assert.deepEqual(
    await context.services.serviceEndpoints.registry.getEndpoint("endpoint_a"),
    endpoint,
  );
});

Deno.test("full AppContext composition wires default adapters and services", () => {
  const context = createInMemoryAppContext();

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.source instanceof ImmutableManifestSourceAdapter);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
  assert.ok(context.services.core);
  assert.ok(context.services.deploy.plans);
  assert.ok(context.services.deploy.apply);
  assert.ok(context.services.runtime.materializer);
});
