import assert from "node:assert/strict";
import { kernelPluginFromProviderPlugin } from "./kernel-plugin-adapter.ts";
import type { ProviderPlugin } from "./provider-plugin.ts";

Deno.test("kernelPluginFromProviderPlugin injects resolved env and target into legacy spec", async () => {
  let seenSpec: unknown;
  const provider: ProviderPlugin = {
    id: "@test/gateway",
    version: "1.0.0",
    implements: { id: "gateway", version: "v1" },
    capabilities: [],
    apply: (spec) => {
      seenSpec = spec;
      return Promise.resolve({
        handle: "dns://api.example.com",
        outputs: { fqdn: "api.example.com" },
      });
    },
    destroy: () => Promise.resolve(),
    status: () =>
      Promise.resolve({
        kind: "ready",
        observedAt: "2026-05-21T00:00:00.000Z",
      }),
  };
  const plugin = kernelPluginFromProviderPlugin({
    provider,
    kindUri: "https://takosumi.com/kinds/v1/gateway",
  });

  await plugin.apply({
    installationId: "ins_1",
    componentName: "domain",
    component: {
      kind: "gateway",
      spec: {
        name: "api.example.com",
        env: { EXISTING: "1" },
      },
    },
    source: { kind: "local", url: "/tmp/src" },
    sourceDirectory: "/tmp/src",
    listenedMaterials: {
      app: { url: "https://web.example.com" },
      db: { host: "db.internal" },
    },
    resolvedBindings: [
      {
        listenerComponent: "domain",
        bindingName: "db",
        sourceRef: "database.connection",
        options: { from: "database.connection", as: "env", prefix: "DB" },
        envInjections: { DB_HOST: "db.internal" },
        material: { host: "db.internal" },
      },
      {
        listenerComponent: "domain",
        bindingName: "app",
        sourceRef: "web.http",
        options: { from: "web.http", as: "upstream" },
        envInjections: {},
        target: { url: "https://web.example.com" },
        material: { url: "https://web.example.com" },
      },
    ],
  });

  assert.deepEqual(seenSpec, {
    name: "api.example.com",
    env: { EXISTING: "1", DB_HOST: "db.internal" },
    target: "https://web.example.com",
  });
});

Deno.test("kernelPluginFromProviderPlugin rejects explicit env collision", async () => {
  const provider: ProviderPlugin = {
    id: "@test/web",
    version: "1.0.0",
    implements: { id: "web-service", version: "v1" },
    capabilities: [],
    apply: () =>
      Promise.resolve({
        handle: "web://api",
        outputs: { url: "https://api.example.com" },
      }),
    destroy: () => Promise.resolve(),
    status: () =>
      Promise.resolve({
        kind: "ready",
        observedAt: "2026-05-21T00:00:00.000Z",
      }),
  };
  const plugin = kernelPluginFromProviderPlugin({
    provider,
    kindUri: "https://takosumi.com/kinds/v1/web-service",
  });

  await assert.rejects(
    () =>
      plugin.apply({
        installationId: "ins_1",
        componentName: "web",
        component: {
          kind: "web-service",
          spec: { env: { DB_HOST: "explicit" } },
        },
        source: { kind: "local", url: "/tmp/src" },
        sourceDirectory: "/tmp/src",
        listenedMaterials: { db: { host: "db.internal" } },
        resolvedBindings: [{
          listenerComponent: "web",
          bindingName: "db",
          sourceRef: "database.connection",
          options: { from: "database.connection", as: "env", prefix: "DB" },
          envInjections: { DB_HOST: "db.internal" },
          material: { host: "db.internal" },
        }],
      }),
    /conflicts with explicit spec/,
  );
});
