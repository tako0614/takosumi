import assert from "node:assert/strict";
import type { KernelPlugin } from "takosumi-contract";
import {
  type AppAdapters,
  buildKernelPluginRegistry,
  createAppContext,
  createConfiguredAppContext,
  createInMemoryAppContext,
} from "./app_context.ts";
import { LocalActorAdapter } from "./adapters/auth/mod.ts";
import { MemoryCoordinationAdapter } from "./adapters/coordination/mod.ts";
import { NoopTestKms } from "./adapters/kms/mod.ts";
import { MemoryNotificationSink } from "./adapters/notification/mod.ts";
import { MemoryObjectStorage } from "./adapters/object-storage/mod.ts";
import { LocalOperatorConfig } from "./adapters/operator-config/mod.ts";
import { NoopProviderMaterializer } from "./adapters/provider/mod.ts";
import { MemoryQueueAdapter } from "./adapters/queue/mod.ts";
import { InMemoryRouterConfigAdapter } from "./adapters/router/mod.ts";
import { MemoryEncryptedSecretStore } from "./adapters/secret-store/mod.ts";
import { ImmutableManifestSourceAdapter } from "./adapters/source/mod.ts";
import { MemoryStorageDriver } from "./adapters/storage/mod.ts";
import { InMemoryRuntimeAgentRegistry } from "./agents/mod.ts";
import { InMemoryObservabilitySink } from "./services/observability/mod.ts";

Deno.test("createInMemoryAppContext keeps default in-memory skeleton wiring", () => {
  const context = createInMemoryAppContext();

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.source instanceof ImmutableManifestSourceAdapter);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
});

Deno.test("createInMemoryAppContext backs default runtime-agent registry with storage ledger", async () => {
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

Deno.test("createConfiguredAppContext returns in-memory adapters when no overrides are passed", async () => {
  const context = await createConfiguredAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.source instanceof ImmutableManifestSourceAdapter);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
});

Deno.test("createAppContext uses operator-injected adapters in production", async () => {
  const customSource = new ImmutableManifestSourceAdapter({
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

Deno.test("createAppContext rejects production runtime without explicit adapters", async () => {
  await assert.rejects(
    () =>
      createAppContext({
        runtimeConfig: { environment: "production" },
      }),
    /production runtime requires an explicit/,
  );
});

Deno.test("createAppContext rejects staging runtime without explicit adapters", async () => {
  await assert.rejects(
    () =>
      createAppContext({
        runtimeConfig: { environment: "staging" },
      }),
    /staging runtime requires an explicit/,
  );
});

Deno.test("buildKernelPluginRegistry exposes operator-supplied plugins by kind URI", () => {
  const plugin = buildExamplePlugin();
  const registry = buildKernelPluginRegistry({ plugins: [plugin] });
  assert.equal(
    registry.findByKindUri("https://example.test/kinds/v1/test")?.name,
    "@example/test",
  );
});

Deno.test("buildKernelPluginRegistry resolves operator kind aliases", () => {
  const plugin = buildExamplePlugin();
  const registry = buildKernelPluginRegistry({
    kindAliases: { test: "https://example.test/kinds/v1/test" },
    plugins: [plugin],
  });
  assert.equal(registry.findByKindRef("test")?.name, "@example/test");
});

function buildExamplePlugin(): KernelPlugin {
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
    source: new ImmutableManifestSourceAdapter({ clock, idGenerator }),
    storage,
    kms: new NoopTestKms({ clock, idGenerator }),
    observability: new InMemoryObservabilitySink(),
    routerConfig: new InMemoryRouterConfigAdapter({ clock }),
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
