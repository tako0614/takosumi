import assert from "node:assert/strict";
import {
  createAppContext,
  createConfiguredAppContext,
  createInMemoryAppContext,
} from "./app_context.ts";
import {
  type KernelPluginPortKind,
  TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
} from "takosumi-contract";
import { NoopProviderMaterializer } from "./adapters/provider/mod.ts";
import { ImmutableManifestSourceAdapter } from "./adapters/source/mod.ts";
import { MemoryStorageDriver } from "./adapters/storage/mod.ts";
import {
  canonicalTrustedKernelPluginManifest,
  createReferenceKernelPlugin,
  installTrustedKernelPlugins,
  type TakosPaaSKernelPlugin,
  TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
} from "./plugins/mod.ts";

const productionRequiredPorts = [
  "auth",
  "coordination",
  "notification",
  "operator-config",
  "storage",
  "source",
  "provider",
  "queue",
  "object-storage",
  "kms",
  "secret-store",
  "router-config",
  "observability",
  "runtime-agent",
] as const satisfies readonly KernelPluginPortKind[];

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

Deno.test("createConfiguredAppContext wires selected reference plugin adapters from runtime config env", async () => {
  const context = await createConfiguredAppContext({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOS_PROVIDER_PLUGIN: "takos.kernel.reference",
      TAKOS_SOURCE_PLUGIN: "takos.kernel.reference",
    },
  });

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.source instanceof ImmutableManifestSourceAdapter);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
});

Deno.test("createConfiguredAppContext wires selected kernel plugin adapters", async () => {
  const context = await createConfiguredAppContext({
    plugins: [createReferenceKernelPlugin()],
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOS_STORAGE_PLUGIN: "takos.kernel.reference",
      TAKOS_PROVIDER_PLUGIN: "takos.kernel.reference",
      TAKOS_SOURCE_PLUGIN: "takos.kernel.reference",
      TAKOS_KMS_PLUGIN: "takos.kernel.reference",
      TAKOS_SECRET_STORE_PLUGIN: "takos.kernel.reference",
    },
  });

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.source instanceof ImmutableManifestSourceAdapter);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
});

Deno.test("createConfiguredAppContext uses selected storage plugin for canonical stores", async () => {
  const context = await createConfiguredAppContext({
    plugins: [createReferenceKernelPlugin()],
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOS_STORAGE_PLUGIN: "takos.kernel.reference",
      TAKOS_PROVIDER_PLUGIN: "takos.kernel.reference",
    },
  });

  await context.services.core.spaces.createSpace({
    actor: { actorAccountId: "acct_1", roles: ["owner"], requestId: "req_1" },
    spaceId: "space_from_storage_plugin",
    name: "Storage backed space",
  });

  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
  assert.equal(
    context.adapters.storage.snapshot().spaces.some((space) =>
      space.id === "space_from_storage_plugin"
    ),
    true,
  );
});

Deno.test("createConfiguredAppContext storage deploy store exposes only implemented optional methods", async () => {
  const context = await createConfiguredAppContext({
    plugins: [createReferenceKernelPlugin()],
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOS_STORAGE_PLUGIN: "takos.kernel.reference",
      TAKOS_PROVIDER_PLUGIN: "takos.kernel.reference",
    },
  });

  assert.equal(context.stores.deploy.deploys.getGroupHeadHistory, undefined);
  assert.equal(
    context.stores.deploy.deploys.getDefaultRollbackValidators,
    undefined,
  );
  assert.equal(context.stores.deploy.deploys.listObservations, undefined);
});

Deno.test("createConfiguredAppContext storage plugin backs runtime usage and service endpoint stores", async () => {
  const context = await createConfiguredAppContext({
    plugins: [createReferenceKernelPlugin()],
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOS_STORAGE_PLUGIN: "takos.kernel.reference",
      TAKOS_PROVIDER_PLUGIN: "takos.kernel.reference",
    },
  });

  await context.stores.runtime.desiredStates.put({
    id: "desired_storage_1",
    spaceId: "space_storage_1",
    groupId: "group_storage_1",
    activationId: "activation_storage_1",
    appName: "storage-backed-runtime",
    materializedAt: "2026-04-29T00:00:00.000Z",
    workloads: [],
    resources: [],
    routes: [],
  });
  await context.stores.runtime.observedStates.record({
    id: "observed_storage_1",
    spaceId: "space_storage_1",
    groupId: "group_storage_1",
    desiredStateId: "desired_storage_1",
    observedAt: "2026-04-29T00:01:00.000Z",
    workloads: [],
    resources: [],
    routes: [],
    diagnostics: [],
  });
  await context.stores.runtime.providerObservations.record({
    materializationId: "mat_storage_1",
    observedState: "present",
    observedAt: "2026-04-29T00:02:00.000Z",
  });
  await context.stores.usage.aggregates.recordEvent({
    id: "usage_storage_1",
    kind: "runtime",
    metric: "runtime.worker_milliseconds",
    runtimeId: "runtime_storage_1",
    spaceId: "space_storage_1",
    groupId: "group_storage_1",
    occurredAt: "2026-04-29T00:03:00.000Z",
    quantity: 10,
    unit: "millisecond",
  }, "2026-04-29T00:04:00.000Z");
  await context.stores.serviceEndpoints.endpoints.put({
    id: "endpoint_storage_1",
    serviceId: "service_storage_1",
    spaceId: "space_storage_1",
    groupId: "group_storage_1",
    name: "storage-backed-endpoint",
    protocol: "https",
    url: "https://service.example.test",
    health: {
      status: "unknown",
      checkedAt: "2026-04-29T00:05:00.000Z",
    },
    createdAt: "2026-04-29T00:05:00.000Z",
    updatedAt: "2026-04-29T00:05:00.000Z",
  });

  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
  const snapshot = context.adapters.storage.snapshot();
  assert.equal(snapshot.runtimeDesiredStates.length, 1);
  assert.equal(snapshot.runtimeObservedStates.length, 1);
  assert.equal(snapshot.providerObservations.length, 1);
  assert.equal(snapshot.usageAggregates.length, 1);
  assert.equal(snapshot.serviceEndpoints.length, 1);
});

Deno.test("createConfiguredAppContext rejects missing selected kernel plugin", async () => {
  await assert.rejects(
    () =>
      createConfiguredAppContext({
        runtimeEnv: {
          TAKOS_PROVIDER_PLUGIN: "takos.provider.missing",
        },
      }),
    /kernel plugin is not registered: takos.provider.missing/,
  );
});

Deno.test("createAppContext rejects staging/production noop provider fallback", async () => {
  const plugin = createExternalReferenceBackedKernelPlugin(
    "external.kernel.missing-provider",
  );
  const trusted = await trustedPlugin(plugin);
  await assert.rejects(
    () =>
      createAppContext({
        plugins: [trusted],
        runtimeConfig: {
          environment: "staging",
          plugins: pluginSelection(trusted.manifest.id, ["provider"]),
        },
      }),
    /staging runtime requires an explicit provider adapter or provider kernel plugin; refusing noop provider fallback/,
  );
});

Deno.test("createInMemoryAppContext rejects strict direct runtime config fallback ports", async () => {
  const plugin = createExternalReferenceBackedKernelPlugin(
    "external.kernel.strict-direct",
  );
  const trusted = await trustedPlugin(plugin);
  const strictPorts = [
    "coordination",
    "router-config",
    "queue",
    "object-storage",
    "kms",
    "secret-store",
  ] as const satisfies readonly KernelPluginPortKind[];

  for (const missingPort of strictPorts) {
    assert.throws(
      () =>
        createInMemoryAppContext({
          plugins: [trusted],
          runtimeConfig: {
            environment: "production",
            plugins: pluginSelection(trusted.manifest.id, [missingPort]),
          },
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message.includes(
            `production runtime requires an explicit ${missingPort} adapter or ${missingPort} kernel plugin`,
          ),
          true,
        );
        return true;
      },
    );
  }
});

Deno.test("createInMemoryAppContext allows strict runtime-agent default when storage is selected", async () => {
  const plugin = createExternalReferenceBackedKernelPlugin(
    "external.kernel.strict-runtime-agent-storage",
  );
  const trusted = await trustedPlugin(plugin);

  const context = createInMemoryAppContext({
    plugins: [trusted],
    runtimeConfig: {
      environment: "production",
      plugins: pluginSelection(trusted.manifest.id, ["runtime-agent"]),
    },
  });

  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
  await context.adapters.runtimeAgent.register({
    agentId: "agent_strict",
    provider: "aws",
  });
  assert.equal(
    context.adapters.storage.snapshot().runtimeAgents[0].id,
    "agent_strict",
  );
});

Deno.test("createInMemoryAppContext rejects strict direct reference plugin selection", () => {
  assert.throws(
    () =>
      createInMemoryAppContext({
        runtimeConfig: {
          environment: "production",
          plugins: pluginSelection("takos.kernel.reference"),
        },
      }),
    /production cannot select reference\/noop kernel plugin takos\.kernel\.reference/,
  );
});

Deno.test("createConfiguredAppContext wires explicitly injected external plugin", async () => {
  const plugin = createExternalReferenceBackedKernelPlugin(
    "external.kernel.local",
  );
  const context = await createConfiguredAppContext({
    plugins: [plugin],
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOS_PROVIDER_PLUGIN: plugin.manifest.id,
      TAKOS_STORAGE_PLUGIN: plugin.manifest.id,
      TAKOS_OBJECT_STORAGE_PLUGIN: plugin.manifest.id,
    },
  });

  assert.ok(context.adapters.provider instanceof NoopProviderMaterializer);
  assert.ok(context.adapters.storage instanceof MemoryStorageDriver);
});

Deno.test("createConfiguredAppContext allows production external plugin selection", async () => {
  const plugin = createExternalReferenceBackedKernelPlugin(
    "external.kernel.production",
  );
  const trusted = await trustedPlugin(plugin);
  const context = await createConfiguredAppContext({
    plugins: [trusted],
    runtimeEnv: {
      TAKOS_ENVIRONMENT: "production",
      TAKOS_KERNEL_PLUGIN_SELECTIONS: JSON.stringify(
        Object.fromEntries(
          productionRequiredPorts.map((port) => [port, trusted.manifest.id]),
        ),
      ),
    },
  });

  const plan = await context.adapters.provider.materialize({
    id: "desired_1",
    spaceId: "space_1",
    groupId: "group_1",
    activationId: "activation_1",
    appName: "cloud-app",
    materializedAt: "2026-04-29T00:00:00.000Z",
    workloads: [],
    resources: [],
    routes: [],
  });
  assert.equal(plan.provider, "noop");
});

Deno.test("createConfiguredAppContext does not auto-register official cloud plugins", async () => {
  await assert.rejects(
    () =>
      createConfiguredAppContext({
        runtimeEnv: {
          TAKOS_PROVIDER_PLUGIN: "operator.takosumi.cloudflare",
        },
      }),
    /kernel plugin is not registered: operator\.takosumi\.cloudflare/,
  );
});

function createExternalReferenceBackedKernelPlugin(
  id: string,
): TakosPaaSKernelPlugin {
  const reference = createReferenceKernelPlugin();
  return {
    manifest: {
      id,
      name: "External Reference Backed Test Plugin",
      version: "1.0.0",
      kernelApiVersion: TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
      capabilities: productionRequiredPorts.map((port) => ({
        port,
        kind: "external-test",
        externalIo: ["network"],
      })),
    },
    createAdapters(context) {
      return reference.createAdapters(context);
    },
  };
}

function pluginSelection(
  pluginId: string,
  omittedPorts: readonly KernelPluginPortKind[] = [],
): Partial<Record<KernelPluginPortKind, string>> {
  const omitted = new Set<KernelPluginPortKind>(omittedPorts);
  return Object.fromEntries(
    productionRequiredPorts
      .filter((port) => !omitted.has(port))
      .map((port) => [port, pluginId]),
  ) as Partial<Record<KernelPluginPortKind, string>>;
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

async function trustedPlugin(
  plugin: TakosPaaSKernelPlugin,
): Promise<TakosPaaSKernelPlugin> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(
      canonicalTrustedKernelPluginManifest(plugin.manifest),
    ),
  );
  const [installed] = await installTrustedKernelPlugins({
    envelopes: [{
      manifest: plugin.manifest,
      signature: {
        alg: TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
        keyId: "test-key",
        value: encodeBase64Url(new Uint8Array(signature)),
      },
    }],
    availablePlugins: [plugin],
    trustedKeys: [{
      keyId: "test-key",
      publisherId: "test-publisher",
      publicKeyJwk,
    }],
    policy: {
      enabledPluginIds: [plugin.manifest.id],
    },
    environment: "production",
  });
  return installed;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}
