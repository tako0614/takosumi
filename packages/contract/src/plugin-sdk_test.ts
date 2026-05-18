import assert from "node:assert/strict";
import {
  allowUnauthenticatedRuntimeAgentRoutesForTests,
  createKernelPluginRegistry,
  createPluginAdapterOverrides,
  InMemoryRuntimeAgentRegistry,
  registerRuntimeAgentRoutes,
  TAKOSUMI_RUNTIME_AGENT_PATHS,
  type TakosumiKernelPlugin,
} from "./plugin-sdk.ts";
import {
  type KernelPluginPortKind,
  TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
} from "./plugin.ts";

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
