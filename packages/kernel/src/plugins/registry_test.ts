import assert from "node:assert/strict";
import {
  type KernelPluginPortKind,
  TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
} from "takosumi-contract";
import type { ProviderMaterializer } from "../adapters/provider/mod.ts";
import {
  createKernelPluginRegistry,
  createPluginAdapterOverrides,
} from "./registry.ts";
import { createReferenceKernelPlugin } from "./reference.ts";
import {
  canonicalTrustedKernelPluginManifest,
  installTrustedKernelPlugins,
  TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
} from "./trusted_install.ts";
import type { TakosPaaSKernelPlugin } from "./types.ts";

const allPorts = [
  "auth",
  "coordination",
  "kms",
  "notification",
  "object-storage",
  "operator-config",
  "provider",
  "queue",
  "router-config",
  "runtime-agent",
  "secret-store",
  "source",
  "storage",
  "observability",
] as const satisfies readonly KernelPluginPortKind[];

Deno.test("kernel plugin registry exposes registered plugin manifests", () => {
  const plugin = createReferenceKernelPlugin();
  const registry = createKernelPluginRegistry([plugin]);

  assert.equal(registry.get("takos.kernel.reference"), plugin);
  assert.deepEqual(
    registry.list().map((item) => item.manifest.id),
    ["takos.kernel.reference"],
  );
});

Deno.test("kernel plugin registry rejects duplicate plugin ids", () => {
  const plugin = createReferenceKernelPlugin();

  assert.throws(
    () => createKernelPluginRegistry([plugin, plugin]),
    /kernel plugin already registered: takos.kernel.reference/,
  );
});

Deno.test("kernel plugin registry has no bundled official provider plugins", () => {
  const registry = createKernelPluginRegistry([createReferenceKernelPlugin()]);

  assert.equal(registry.get("takos.kernel.self-hosted"), undefined);
  assert.equal(registry.get("takos.kernel.cloudflare"), undefined);
  assert.equal(registry.get("takos.kernel.kubernetes"), undefined);
});

Deno.test("production rejects reference plugin selection", () => {
  const plugin = createReferenceKernelPlugin();
  const registry = createKernelPluginRegistry([plugin]);

  assert.throws(
    () =>
      createPluginAdapterOverrides({
        registry,
        selectedPluginIds: { provider: plugin.manifest.id },
        context: createPluginContext({
          environment: "production",
          selectedPluginIds: { provider: plugin.manifest.id },
        }),
      }),
    /production cannot select reference\/noop kernel plugin takos\.kernel\.reference/,
  );
});

Deno.test("production accepts explicitly registered external plugin for selected ports", async () => {
  const plugin = await trustedPlugin(
    createExternalReferenceBackedPlugin("external.kernel.test"),
  );
  const registry = createKernelPluginRegistry([plugin]);
  const overrides = createPluginAdapterOverrides({
    registry,
    selectedPluginIds: {
      provider: plugin.manifest.id,
      storage: plugin.manifest.id,
      "object-storage": plugin.manifest.id,
    },
    context: createPluginContext({
      environment: "production",
      selectedPluginIds: {
        provider: plugin.manifest.id,
        storage: plugin.manifest.id,
        "object-storage": plugin.manifest.id,
      },
    }),
  });

  assert.ok(overrides.provider);
  assert.ok(overrides.storage);
  assert.ok(overrides.objectStorage);
  const plan = await overrides.provider.materialize({
    id: "desired_1",
    spaceId: "space_1",
    groupId: "group_1",
    activationId: "activation_1",
    appName: "app",
    materializedAt: "2026-04-29T00:00:00.000Z",
    workloads: [],
    resources: [],
    routes: [],
  });
  assert.equal(plan.provider, "noop");
});

Deno.test("selected plugin must declare every selected port", () => {
  const plugin = createExternalReferenceBackedPlugin("external.provider.only", [
    "provider",
  ]);
  const registry = createKernelPluginRegistry([plugin]);

  assert.throws(
    () =>
      createPluginAdapterOverrides({
        registry,
        selectedPluginIds: {
          provider: plugin.manifest.id,
          storage: plugin.manifest.id,
        },
        context: createPluginContext({
          environment: "production",
          selectedPluginIds: {
            provider: plugin.manifest.id,
            storage: plugin.manifest.id,
          },
        }),
      }),
    /kernel plugin external\.provider\.only does not declare capability for selected port storage/,
  );
});

Deno.test("selected plugin must return every selected adapter", async () => {
  const plugin: TakosPaaSKernelPlugin = {
    manifest: {
      id: "external.incomplete",
      name: "Incomplete External Plugin",
      version: "1.0.0",
      kernelApiVersion: TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
      capabilities: [
        {
          port: "provider",
          kind: "external-test",
          externalIo: ["network"],
        },
      ],
    },
    createAdapters() {
      return {};
    },
  };
  const trusted = await trustedPlugin(plugin);
  const registry = createKernelPluginRegistry([trusted]);

  assert.throws(
    () =>
      createPluginAdapterOverrides({
        registry,
        selectedPluginIds: { provider: trusted.manifest.id },
        context: createPluginContext({
          environment: "production",
          selectedPluginIds: { provider: trusted.manifest.id },
        }),
      }),
    /kernel plugin external\.incomplete did not provide adapter provider for selected port provider/,
  );
});

Deno.test("selected plugin must not return adapters for unselected ports", () => {
  const reference = createReferenceKernelPlugin();
  const referenceAdapters = reference.createAdapters(createPluginContext({}));
  const plugin: TakosPaaSKernelPlugin = {
    manifest: {
      id: "external.overbroad",
      name: "Overbroad External Plugin",
      version: "1.0.0",
      kernelApiVersion: TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
      capabilities: [
        {
          port: "provider",
          kind: "external-test",
          externalIo: ["network"],
        },
      ],
    },
    createAdapters() {
      return {
        provider: referenceAdapters.provider,
        storage: referenceAdapters.storage,
      };
    },
  };
  const registry = createKernelPluginRegistry([plugin]);

  assert.throws(
    () =>
      createPluginAdapterOverrides({
        registry,
        selectedPluginIds: { provider: plugin.manifest.id },
        context: createPluginContext({
          selectedPluginIds: { provider: plugin.manifest.id },
        }),
      }),
    /kernel plugin external\.overbroad provided unselected adapter storage/,
  );
});

Deno.test("selected plugins cannot claim duplicate adapter ownership", () => {
  const reference = createReferenceKernelPlugin();
  const referenceAdapters = reference.createAdapters(createPluginContext({}));
  const providerPlugin: TakosPaaSKernelPlugin = {
    manifest: {
      id: "external.provider.owner",
      name: "Provider Owner",
      version: "1.0.0",
      kernelApiVersion: TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
      capabilities: [{
        port: "provider",
        kind: "external-test",
        externalIo: ["network"],
      }],
    },
    createAdapters() {
      return { provider: referenceAdapters.provider };
    },
  };
  const storagePlugin: TakosPaaSKernelPlugin = {
    manifest: {
      id: "external.storage.owner",
      name: "Storage Owner",
      version: "1.0.0",
      kernelApiVersion: TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
      capabilities: [{
        port: "storage",
        kind: "external-test",
        externalIo: ["network"],
      }],
    },
    createAdapters() {
      return {
        provider: referenceAdapters.provider,
        storage: referenceAdapters.storage,
      };
    },
  };
  const registry = createKernelPluginRegistry([providerPlugin, storagePlugin]);

  assert.throws(
    () =>
      createPluginAdapterOverrides({
        registry,
        selectedPluginIds: {
          provider: providerPlugin.manifest.id,
          storage: storagePlugin.manifest.id,
        },
        context: createPluginContext({
          selectedPluginIds: {
            provider: providerPlugin.manifest.id,
            storage: storagePlugin.manifest.id,
          },
        }),
      }),
    /kernel plugin external\.storage\.owner attempted duplicate ownership of adapter provider/,
  );
});

Deno.test("external plugin can resolve operator-injected clients", async () => {
  const injectedProvider: ProviderMaterializer = {
    materialize(desiredState) {
      return Promise.resolve({
        id: "provider_plan_injected",
        provider: "injected-provider",
        desiredStateId: desiredState.id,
        recordedAt: "2026-04-29T00:00:00.000Z",
        operations: [],
      });
    },
    listRecordedOperations: () => Promise.resolve([]),
    clearRecordedOperations: () => Promise.resolve(),
  };
  const plugin: TakosPaaSKernelPlugin = {
    manifest: {
      id: "external.client-registry",
      name: "External Client Registry Plugin",
      version: "1.0.0",
      kernelApiVersion: TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
      capabilities: [
        {
          port: "provider",
          kind: "external-test",
          externalIo: ["network", "provider-control-plane"],
        },
      ],
    },
    createAdapters(context) {
      const config = context.operatorConfig?.[this.manifest.id];
      const ref = isRecord(config) && isRecord(config.provider)
        ? config.provider.operatorClientRef
        : undefined;
      if (typeof ref !== "string") {
        throw new Error("external.client-registry requires provider ref");
      }
      const provider = context.clientRegistry?.get<ProviderMaterializer>(ref);
      if (!provider) {
        throw new Error(`missing injected provider client: ${ref}`);
      }
      return { provider };
    },
  };
  const trusted = await trustedPlugin(plugin);
  const registry = createKernelPluginRegistry([trusted]);
  const overrides = createPluginAdapterOverrides({
    registry,
    selectedPluginIds: { provider: trusted.manifest.id },
    context: createPluginContext({
      environment: "production",
      selectedPluginIds: { provider: trusted.manifest.id },
      operatorConfig: {
        [trusted.manifest.id]: {
          provider: { operatorClientRef: "provider-client" },
        },
      },
      clientRegistry: {
        get: <T = unknown>(ref: string) =>
          ref === "provider-client" ? injectedProvider as T : undefined,
      },
    }),
  });

  const plan = await overrides.provider?.materialize({
    id: "desired_1",
    spaceId: "space_1",
    groupId: "group_1",
    activationId: "activation_1",
    appName: "app",
    materializedAt: "2026-04-29T00:00:00.000Z",
    workloads: [],
    resources: [],
    routes: [],
  });
  assert.equal(plan?.id, "provider_plan_injected");
});

Deno.test("production rejects untrusted external plugin selection", () => {
  const plugin = createExternalReferenceBackedPlugin("external.kernel.raw");
  const registry = createKernelPluginRegistry([plugin]);

  assert.throws(
    () =>
      createPluginAdapterOverrides({
        registry,
        selectedPluginIds: { provider: plugin.manifest.id },
        context: createPluginContext({
          environment: "production",
          selectedPluginIds: { provider: plugin.manifest.id },
        }),
      }),
    /production requires trusted install metadata for kernel plugin external\.kernel\.raw/,
  );
});

function createExternalReferenceBackedPlugin(
  id: string,
  ports: readonly KernelPluginPortKind[] = allPorts,
): TakosPaaSKernelPlugin {
  const reference = createReferenceKernelPlugin();
  return {
    manifest: {
      id,
      name: "External Reference Backed Test Plugin",
      version: "1.0.0",
      kernelApiVersion: TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
      capabilities: ports.map((port) => ({
        port,
        kind: "external-test",
        externalIo: ["network"],
      })),
    },
    createAdapters(context) {
      const adapters = reference.createAdapters(context);
      const selectedPorts = ports.filter((port) =>
        context.selectedPluginIds[port] === id
      );
      return Object.fromEntries(
        selectedPorts.flatMap((port) => {
          const adapterKey = adapterKeyForPort(port);
          return adapterKey ? [[adapterKey, adapters[adapterKey]]] : [];
        }),
      ) as ReturnType<TakosPaaSKernelPlugin["createAdapters"]>;
    },
  };
}

function adapterKeyForPort(
  port: KernelPluginPortKind,
): keyof ReturnType<TakosPaaSKernelPlugin["createAdapters"]> | undefined {
  switch (port) {
    case "auth":
      return "auth";
    case "coordination":
      return "coordination";
    case "kms":
      return "kms";
    case "notification":
      return "notifications";
    case "object-storage":
      return "objectStorage";
    case "operator-config":
      return "operatorConfig";
    case "provider":
      return "provider";
    case "queue":
      return "queue";
    case "router-config":
      return "routerConfig";
    case "secret-store":
      return "secrets";
    case "source":
      return "source";
    case "storage":
      return "storage";
    case "observability":
      return "observability";
    case "runtime-agent":
      return "runtimeAgent";
  }
}

function createPluginContext(
  overrides: Partial<
    Parameters<typeof createPluginAdapterOverrides>[0]["context"]
  >,
): Parameters<typeof createPluginAdapterOverrides>[0]["context"] {
  return {
    kernelApiVersion: TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
    environment: "local",
    processRole: "takosumi-api",
    selectedPluginIds: {},
    operatorConfig: {},
    clock: () => new Date("2026-04-29T00:00:00.000Z"),
    idGenerator: () => "id",
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
