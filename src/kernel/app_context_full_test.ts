import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInMemoryAppContext } from "./app_context.ts";
import { NoopTestKms } from "./adapters/kms/mod.ts";
import { InMemoryRouterConfigAdapter } from "./adapters/router/mod.ts";
import { NoopProviderMaterializer } from "./adapters/provider/mod.ts";
import { ImmutableManifestSourceAdapter } from "./adapters/source/mod.ts";
import { MemoryStorageDriver } from "./adapters/storage/mod.ts";
import { MemoryQueueAdapter } from "./adapters/queue/mod.ts";
import { MemoryObjectStorage } from "./adapters/object-storage/mod.ts";
import {
  InMemoryObservabilitySink,
  OtlpObservabilitySink,
} from "./services/observability/mod.ts";
import { EntitlementPolicyService } from "./services/entitlements/mod.ts";

test("createInMemoryAppContext exposes full optional composition fields", async () => {
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
    context.services.entitlements.policy instanceof EntitlementPolicyService,
  );

  assert.deepEqual(await context.adapters.kms.activeKeyRef(), {
    provider: "test-noop",
    keyId: "test",
    keyVersion: "v1",
  });
  assert.deepEqual(await context.adapters.observability.listMetrics(), []);
});

test("full AppContext wires queue and object storage default adapters", async () => {
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

test("createInMemoryAppContext wraps observability with OTLP metrics exporter from env", () => {
  const context = createInMemoryAppContext({
    runtimeEnv: {
      TAKOSUMI_OTLP_METRICS_ENDPOINT: "http://collector.local/v1/metrics",
      TAKOSUMI_DEV_MODE: "1",
    },
  });

  assert.ok(context.adapters.observability instanceof OtlpObservabilitySink);
});

test("full AppContext composition wires default adapters and services", () => {
  const context = createInMemoryAppContext();

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.source instanceof ImmutableManifestSourceAdapter);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
  assert.ok(context.services.core);
  assert.ok(context.services.deploy.plans);
  assert.ok(context.services.deploy.apply);
  assert.ok(context.services.runtime.materializer);
});
