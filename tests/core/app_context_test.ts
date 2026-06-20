import { test } from "bun:test";
import assert from "node:assert/strict";
import type { OperatorImplementation } from "takosumi-contract/reference/compat";
import {
  type AppAdapters,
  buildOperatorImplementationRegistry,
  createAppContext,
  createConfiguredAppContext,
  createInMemoryAppContext,
} from "../../core/app_context.ts";
import { LocalActorAdapter } from "../../core/adapters/auth/mod.ts";
import { MemoryCoordinationAdapter } from "../../core/adapters/coordination/mod.ts";
import { NoopTestKms } from "../../core/adapters/kms/mod.ts";
import { MemoryNotificationSink } from "../../core/adapters/notification/mod.ts";
import { MemoryObjectStorage } from "../../core/adapters/object-storage/mod.ts";
import { LocalOperatorConfig } from "../../core/adapters/operator-config/mod.ts";
import { NoopProviderMaterializer } from "../../core/adapters/provider/mod.ts";
import { MemoryQueueAdapter } from "../../core/adapters/queue/mod.ts";
import { MemoryEncryptedSecretStore } from "../../core/adapters/secret-store/mod.ts";
import { ImmutableSourceAdapter } from "../../core/adapters/source/mod.ts";
import { MemoryStorageDriver } from "../../core/adapters/storage/mod.ts";
import { InMemoryRuntimeAgentRegistry } from "../../core/agents/mod.ts";
import { InMemoryObservabilitySink } from "../../core/domains/observability/mod.ts";

test("createInMemoryAppContext keeps default in-memory skeleton wiring", () => {
  const context = createInMemoryAppContext();

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.source instanceof ImmutableSourceAdapter);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
});

test("createInMemoryAppContext backs default runtime-agent registry with storage ledger", async () => {
  const context = createInMemoryAppContext({
    dateClock: () => new Date("2026-04-30T00:00:00.000Z"),
    uuidFactory: sequenceIds(["w_1"]),
  });

  await context.adapters.runtimeAgent.register({
    agentId: "agent_a",
    provider: "aws",
  });
  await context.adapters.runtimeAgent.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });

  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
  const snapshot = context.adapters.storage.snapshot();
  assert.equal(snapshot.runtimeAgents[0].id, "agent_a");
  assert.equal(snapshot.runtimeAgentWorkItems[0].id, "work_w_1");
});

test("createConfiguredAppContext returns in-memory adapters when no overrides are passed", async () => {
  const context = await createConfiguredAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.source instanceof ImmutableSourceAdapter);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
});

test("createAppContext uses operator-injected adapters in production", async () => {
  const customSource = new ImmutableSourceAdapter({
    clock: () => new Date("2026-04-29T00:00:00.000Z"),
    idGenerator: () => "id",
  });
  const productionAdapters = buildProductionAdapters({ source: customSource });
  const context = await createAppContext({
    adapters: productionAdapters,
    runtimeConfig: { environment: "production" },
  });

  assert.equal(context.adapters.source, customSource);
});

test("createAppContext rejects production runtime without explicit adapters", async () => {
  await assert.rejects(
    () =>
      createAppContext({
        runtimeConfig: { environment: "production" },
      }),
    /production runtime requires an explicit/,
  );
});

test("createAppContext rejects staging runtime without explicit adapters", async () => {
  await assert.rejects(
    () =>
      createAppContext({
        runtimeConfig: { environment: "staging" },
      }),
    /staging runtime requires an explicit/,
  );
});

test("buildOperatorImplementationRegistry exposes operator-supplied implementations by kind URI", () => {
  const implementation = buildExampleImplementation();
  const registry = buildOperatorImplementationRegistry({ implementations: [implementation] });
  assert.equal(
    registry.findByKindUri("https://example.test/kinds/v1/test")?.name,
    "@example/test",
  );
});

test("buildOperatorImplementationRegistry leaves bare kind refs to operator implementations", () => {
  const implementation = buildExampleImplementation();
  const registry = buildOperatorImplementationRegistry({ implementations: [implementation] });
  assert.equal(registry.findByKindUri("test"), undefined);
  assert.equal(
    registry.findByKindUri("https://example.test/kinds/v1/test")?.name,
    "@example/test",
  );
});

function buildExampleImplementation(): OperatorImplementation {
  return {
    name: "@example/test",
    version: "1.0.0",
    provides: ["https://example.test/kinds/v1/test"],
    apply: (ctx) =>
      Promise.resolve({
        resourceHandle: `test://${ctx.componentName}`,
        outputs: {},
      }),
  };
}

function buildProductionAdapters(
  overrides: Partial<AppAdapters> = {},
): AppAdapters {
  const clock = () => new Date("2026-04-29T00:00:00.000Z");
  const idGenerator = () => "id";
  const localActor = new LocalActorAdapter();
  const storage = new MemoryStorageDriver();
  return {
    actor: localActor,
    auth: localActor,
    coordination: new MemoryCoordinationAdapter({ clock, idGenerator }),
    notifications: new MemoryNotificationSink({ clock, idGenerator }),
    operatorConfig: new LocalOperatorConfig({ clock }),
    provider: new NoopProviderMaterializer({ clock, idGenerator }),
    secrets: new MemoryEncryptedSecretStore({ clock, idGenerator }),
    source: new ImmutableSourceAdapter({ clock, idGenerator }),
    storage,
    kms: new NoopTestKms({ clock, idGenerator }),
    observability: new InMemoryObservabilitySink(),
    queue: new MemoryQueueAdapter({ clock, idGenerator }),
    objectStorage: new MemoryObjectStorage({ clock }),
    runtimeAgent: new InMemoryRuntimeAgentRegistry({ clock, idGenerator }),
    ...overrides,
  };
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("test id sequence exhausted");
    index += 1;
    return value;
  };
}
