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
    name: "@takos/takosumi-kind-test-gateway",
    version: "0.1.0",
  });

  assert.equal(plugin.name, "@takos/takosumi-kind-test-gateway");
  assert.equal(plugin.version, "0.1.0");

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
        target: {
          targets: [{
            name: "default",
            url: "https://web.example.com",
            visibility: "private",
          }],
        },
        material: {
          targets: [{
            name: "default",
            url: "https://web.example.com",
            visibility: "private",
          }],
        },
      },
    ],
  });

  assert.deepEqual(seenSpec, {
    name: "api.example.com",
    env: { EXISTING: "1", DB_HOST: "db.internal" },
    target: "https://web.example.com",
  });
});

Deno.test("kernelPluginFromProviderPlugin publishes provider outputs as namespace material", async () => {
  const provider: ProviderPlugin = {
    id: "@test/postgres",
    version: "1.0.0",
    implements: { id: "postgres", version: "v1" },
    capabilities: [],
    apply: () =>
      Promise.resolve({
        handle: "postgres://db",
        outputs: {
          host: "db.internal",
          port: 5432,
          passwordSecretRef: "secret://postgres/password",
          configRef: "config://postgres",
        },
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
    kindUri: "https://takosumi.com/kinds/v1/postgres",
  });

  const material = await plugin.publishMaterial!({
    installationId: "ins_1",
    componentName: "db",
    component: {
      kind: "postgres",
      publish: { connection: { as: "service-binding" } },
    },
    publicationName: "connection",
    options: { as: "service-binding" },
    outputs: {
      host: "db.internal",
      port: 5432,
      passwordSecretRef: "secret://postgres/password",
      configRef: "config://postgres",
    },
  });

  assert.deepEqual(material, {
    host: "db.internal",
    port: 5432,
    protocol: "postgresql",
    passwordRef: { secretRef: "secret://postgres/password" },
  });
});

Deno.test("kernelPluginFromProviderPlugin projects object-store outputs to official material", async () => {
  const provider: ProviderPlugin = {
    id: "@test/object-store",
    version: "1.0.0",
    implements: { id: "object-store", version: "v1" },
    capabilities: [],
    apply: () =>
      Promise.resolve({
        handle: "bucket://assets",
        outputs: {
          bucket: "assets",
          endpoint: "https://s3.example.test",
          region: "auto",
          accessKeyRef: "secret://bucket/access-key",
          secretKeyRef: "secret://bucket/secret-key",
        },
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
    kindUri: "https://takosumi.com/kinds/v1/object-store",
  });

  const material = await plugin.publishMaterial!({
    installationId: "ins_1",
    componentName: "bucket",
    component: {
      kind: "object-store",
      publish: { bucket: { as: "object-store" } },
    },
    publicationName: "bucket",
    options: { as: "object-store" },
    outputs: {
      bucket: "assets",
      endpoint: "https://s3.example.test",
      region: "auto",
      accessKeyRef: "secret://bucket/access-key",
      secretKeyRef: "secret://bucket/secret-key",
    },
  });

  assert.deepEqual(material, {
    bucket: "assets",
    endpoint: "https://s3.example.test",
    region: "auto",
    accessKeyIdRef: { secretRef: "secret://bucket/access-key" },
    secretAccessKeyRef: { secretRef: "secret://bucket/secret-key" },
  });
});

Deno.test("kernelPluginFromProviderPlugin projects HTTP outputs to endpoint material", async () => {
  const provider: ProviderPlugin = {
    id: "@test/worker",
    version: "1.0.0",
    implements: { id: "worker", version: "v1" },
    capabilities: [],
    apply: () =>
      Promise.resolve({
        handle: "worker://web",
        outputs: { url: "https://web.internal", id: "web" },
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
    kindUri: "https://takosumi.com/kinds/v1/worker",
  });

  const material = await plugin.publishMaterial!({
    installationId: "ins_1",
    componentName: "web",
    component: {
      kind: "worker",
      publish: { http: { as: "http-endpoint" } },
    },
    publicationName: "http",
    options: { as: "http-endpoint" },
    outputs: { url: "https://web.internal", id: "web" },
  });

  assert.deepEqual(material, {
    targets: [{
      name: "default",
      url: "https://web.internal",
      visibility: "private",
    }],
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
