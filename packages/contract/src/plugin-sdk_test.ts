import assert from "node:assert/strict";
import {
  allowUnauthenticatedRuntimeAgentRoutesForTests,
  canonicalTrustedKernelPluginManifest,
  createKernelPluginRegistry,
  createPluginAdapterOverrides,
  InMemoryRuntimeAgentRegistry,
  installTrustedKernelPlugins,
  registerRuntimeAgentRoutes,
  TAKOSUMI_RUNTIME_AGENT_PATHS,
  type TakosumiKernelPlugin,
  TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
} from "./plugin-sdk.ts";
import {
  type KernelPluginPortKind,
  TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
  type TakosumiKernelPluginManifest,
} from "./plugin.ts";

Deno.test("plugin-sdk trusted install verifies signature, implementation manifest, and policy", async () => {
  const fixture = await signedFixture();

  const installed = await installTrustedKernelPlugins({
    envelopes: [fixture.envelope],
    availablePlugins: [fixture.plugin],
    trustedKeys: [fixture.trustedKey],
    policy: {
      enabledPluginIds: [fixture.plugin.manifest.id],
      trustedKeyIds: [fixture.trustedKey.keyId],
      allowedPublisherIds: [fixture.trustedKey.publisherId],
      allowedPorts: ["provider"],
      allowedExternalIo: ["network", "provider-control-plane"],
    },
    environment: "production",
  });

  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.manifest, fixture.plugin.manifest);
  assert.deepEqual(installed[0]?.trustedInstall, {
    source: "trusted-signed-manifest",
    keyId: fixture.trustedKey.keyId,
    publisherId: fixture.trustedKey.publisherId,
    signatureAlgorithm: TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
  });
});

Deno.test("plugin-sdk trusted install rejects signed manifest that does not exactly match implementation", async () => {
  const fixture = await signedFixture();
  const mismatchedPlugin = plugin({
    ...fixture.plugin.manifest,
    version: "9.9.9",
  });

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [mismatchedPlugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
        },
        environment: "production",
      }),
    /manifest does not match available implementation/,
  );
});

Deno.test("plugin-sdk trusted install rejects key, publisher, port, and external I/O policy violations", async () => {
  const fixture = await signedFixture();

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
          trustedKeyIds: ["other-key"],
        },
        environment: "production",
      }),
    /key is not allowed by install policy/,
  );
  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
          allowedPublisherIds: ["other-publisher"],
        },
        environment: "production",
      }),
    /publisher is not allowed by install policy/,
  );
  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
          allowedPorts: ["auth"],
        },
        environment: "production",
      }),
    /declares port outside install policy/,
  );
  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
          allowedExternalIo: ["network"],
        },
        environment: "production",
      }),
    /declares external I\/O outside install policy/,
  );
});

Deno.test("plugin-sdk trusted install verifies implementation provenance metadata", async () => {
  const fixture = await signedFixture({
    metadata: {
      implementationProvenance: {
        moduleSpecifier: "file:///plugins/provider.ts",
        provenanceRef: "prov://provider-module",
      },
    },
  });

  const installed = await installTrustedKernelPlugins({
    envelopes: [fixture.envelope],
    availablePlugins: [fixture.plugin],
    trustedKeys: [fixture.trustedKey],
    policy: {
      enabledPluginIds: [fixture.plugin.manifest.id],
      requireImplementationProvenance: true,
    },
    environment: "production",
  });

  assert.equal(installed.length, 1);
});

Deno.test("plugin-sdk trusted install rejects unsigned or mismatched implementation provenance", async () => {
  const unsignedFixture = await signedFixture();
  const pluginWithUnsignedProvenance = {
    ...unsignedFixture.plugin,
    implementationProvenance: {
      moduleSpecifier: "file:///plugins/provider.ts",
    },
  };

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [unsignedFixture.envelope],
        availablePlugins: [pluginWithUnsignedProvenance],
        trustedKeys: [unsignedFixture.trustedKey],
        policy: {
          enabledPluginIds: [unsignedFixture.plugin.manifest.id],
        },
        environment: "production",
      }),
    /implementation provenance is not covered by signed manifest/,
  );

  const signedFixtureWithProvenance = await signedFixture({
    metadata: {
      implementationProvenance: {
        moduleSpecifier: "file:///plugins/provider.ts",
      },
    },
  });
  const mismatchedPlugin = {
    ...signedFixtureWithProvenance.plugin,
    implementationProvenance: {
      moduleSpecifier: "file:///plugins/other.ts",
    },
  };

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [signedFixtureWithProvenance.envelope],
        availablePlugins: [mismatchedPlugin],
        trustedKeys: [signedFixtureWithProvenance.trustedKey],
        policy: {
          enabledPluginIds: [signedFixtureWithProvenance.plugin.manifest.id],
        },
        environment: "production",
      }),
    /implementation provenance does not match signed manifest/,
  );
});

Deno.test("plugin-sdk strict trusted install rejects missing implementation provenance", async () => {
  const fixture = await signedFixture();

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
          requireImplementationProvenance: true,
        },
        environment: "production",
      }),
    /requires implementation provenance metadata/,
  );
});

Deno.test("plugin-sdk adapter overrides are limited to selected ports", () => {
  const provider = {};
  const storage = {};
  const plugin = pluginWithAdapters(
    "takosumi.provider.overbroad",
    ["provider"],
    {
      provider,
      storage,
    },
  );
  const registry = createKernelPluginRegistry([plugin]);

  assert.throws(
    () =>
      createPluginAdapterOverrides({
        registry,
        selectedPluginIds: { provider: plugin.manifest.id },
        context: pluginContext({
          selectedPluginIds: { provider: plugin.manifest.id },
        }),
      }),
    /kernel plugin takosumi\.provider\.overbroad provided unselected adapter storage/,
  );
});

Deno.test("plugin-sdk adapter overrides reject duplicate ownership", () => {
  const provider = {};
  const storage = {};
  const providerPlugin = pluginWithAdapters(
    "takosumi.provider.owner",
    ["provider"],
    { provider },
  );
  const storagePlugin = pluginWithAdapters("takosumi.storage.owner", [
    "storage",
  ], {
    provider,
    storage,
  });
  const registry = createKernelPluginRegistry([providerPlugin, storagePlugin]);

  assert.throws(
    () =>
      createPluginAdapterOverrides({
        registry,
        selectedPluginIds: {
          provider: providerPlugin.manifest.id,
          storage: storagePlugin.manifest.id,
        },
        context: pluginContext({
          selectedPluginIds: {
            provider: providerPlugin.manifest.id,
            storage: storagePlugin.manifest.id,
          },
        }),
      }),
    /kernel plugin takosumi\.storage\.owner attempted duplicate ownership of adapter provider/,
  );
});

Deno.test("plugin-sdk runtime agent routes fail closed without authenticate", async () => {
  const handlers = new Map<string, RuntimeAgentRouteHandler>();
  registerRuntimeAgentRoutes({
    post(path: string, handler: RuntimeAgentRouteHandler) {
      handlers.set(path, handler);
    },
    get(_path: string, _handler: RuntimeAgentRouteHandler) {},
  }, {
    registry: new InMemoryRuntimeAgentRegistry(),
  });

  const handler = handlers.get(TAKOSUMI_RUNTIME_AGENT_PATHS.enroll);
  assert.ok(handler);
  const response = await handler(runtimeRouteContext(
    TAKOSUMI_RUNTIME_AGENT_PATHS.enroll,
    {
      provider: "provider",
      capabilities: { providers: ["provider"] },
    },
  ));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "runtime agent route authentication is not configured",
  });
});

Deno.test("plugin-sdk exposes explicit unauthenticated runtime route test helper", async () => {
  const authenticate = allowUnauthenticatedRuntimeAgentRoutesForTests();
  assert.deepEqual(await authenticate(new Request("https://example.test")), {
    ok: true,
  });
});

async function signedFixture(
  overrides: Partial<TakosumiKernelPluginManifest> = {},
) {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  );
  const manifest: TakosumiKernelPluginManifest = {
    id: "takosumi.provider.trusted",
    name: "Trusted Provider",
    version: "1.0.0",
    kernelApiVersion: TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
    capabilities: [{
      port: "provider",
      kind: "provider-control-plane",
      externalIo: ["network", "provider-control-plane"],
    }],
    ...overrides,
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(canonicalTrustedKernelPluginManifest(manifest)),
  );
  return {
    plugin: plugin(manifest),
    trustedKey: {
      keyId: "takosumi-test-root",
      publisherId: "takosumi-test-publisher",
      publicKeyJwk,
    },
    envelope: {
      manifest,
      signature: {
        alg: TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
        keyId: "takosumi-test-root",
        value: encodeBase64Url(new Uint8Array(signature)),
      },
    },
  };
}

function pluginWithAdapters(
  id: string,
  ports: readonly KernelPluginPortKind[],
  adapters: Record<string, unknown>,
): TakosumiKernelPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      kernelApiVersion: TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
      capabilities: ports.map((port) => ({
        port,
        kind: "external-test",
        externalIo: ["network"],
      })),
    },
    createAdapters() {
      return adapters as ReturnType<TakosumiKernelPlugin["createAdapters"]>;
    },
  };
}

function pluginContext(
  overrides: Partial<
    Parameters<typeof createPluginAdapterOverrides>[0]["context"]
  >,
): Parameters<typeof createPluginAdapterOverrides>[0]["context"] {
  return {
    kernelApiVersion: TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
    environment: "local",
    processRole: "takosumi-api",
    selectedPluginIds: {},
    operatorConfig: {},
    clock: () => new Date("2026-04-29T00:00:00.000Z"),
    idGenerator: () => "id",
    ...overrides,
  };
}

type RuntimeAgentRouteApp = Parameters<typeof registerRuntimeAgentRoutes>[0];
type RuntimeAgentRouteHandler = Parameters<RuntimeAgentRouteApp["post"]>[1];
type RuntimeAgentRouteContext = Parameters<RuntimeAgentRouteHandler>[0];

function runtimeRouteContext(
  path: string,
  body: unknown,
): RuntimeAgentRouteContext {
  const raw = new Request(`https://paas.example.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    req: {
      raw,
      method: "POST",
      url: raw.url,
      param() {
        return "agent_1";
      },
      query() {
        return undefined;
      },
    },
    json(responseBody: unknown, status = 200) {
      return Response.json(responseBody, { status });
    },
  };
}

function plugin(
  manifest: TakosumiKernelPluginManifest,
): TakosumiKernelPlugin {
  return {
    manifest,
    createAdapters() {
      return {};
    },
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}
