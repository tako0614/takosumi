import { test } from "bun:test";
import assert from "node:assert/strict";
import { takosumiPluginFromProviderPlugin } from "./takosumi-plugin-adapter.ts";
import type { ProviderPlugin } from "./provider-plugin.ts";

test("takosumiPluginFromProviderPlugin injects resolved env into legacy spec", async () => {
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
  const plugin = takosumiPluginFromProviderPlugin({
    provider,
    kindUri: "https://takosumi.com/kinds/v1/gateway",
    name: "@takosjp/takosumi-plugins/kind/test-gateway",
    version: "0.1.0",
  });

  assert.equal(plugin.name, "@takosjp/takosumi-plugins/kind/test-gateway");
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
        options: { output: "database.connection", inject: "env", prefix: "DB" },
        envInjections: { DB_HOST: "db.internal" },
        material: { host: "db.internal" },
      },
      {
        listenerComponent: "domain",
        bindingName: "app",
        sourceRef: "web.http",
        options: { output: "web.http", inject: "upstream" },
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
  });
});

test("takosumiPluginFromProviderPlugin projects provider outputs as output material", async () => {
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
  const plugin = takosumiPluginFromProviderPlugin({
    provider,
    kindUri: "https://takosumi.com/kinds/v1/postgres",
  });

  const material = await plugin.materializeOutput!({
    installationId: "ins_1",
    componentName: "db",
    component: { kind: "postgres" },
    outputName: "connection",
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
    passwordSecretRef: { secretRef: "secret://postgres/password" },
    configRef: "config://postgres",
  });
});

test("takosumiPluginFromProviderPlugin projects object-store outputs to official material", async () => {
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
          accessKeyIdRef: "secret://bucket/access-key-id",
          secretAccessKeyRef: "secret://bucket/secret-access-key",
        },
      }),
    destroy: () => Promise.resolve(),
    status: () =>
      Promise.resolve({
        kind: "ready",
        observedAt: "2026-05-21T00:00:00.000Z",
      }),
  };
  const plugin = takosumiPluginFromProviderPlugin({
    provider,
    kindUri: "https://takosumi.com/kinds/v1/object-store",
  });

  const material = await plugin.materializeOutput!({
    installationId: "ins_1",
    componentName: "bucket",
    component: { kind: "object-store" },
    outputName: "bucket",
    outputs: {
      bucket: "assets",
      endpoint: "https://s3.example.test",
      region: "auto",
      accessKeyIdRef: "secret://bucket/access-key-id",
      secretAccessKeyRef: "secret://bucket/secret-access-key",
    },
  });

  assert.deepEqual(material, {
    bucket: "assets",
    endpoint: "https://s3.example.test",
    region: "auto",
    accessKeyIdRef: { secretRef: "secret://bucket/access-key-id" },
    secretAccessKeyRef: { secretRef: "secret://bucket/secret-access-key" },
  });

  const legacyAliasMaterial = await plugin.materializeOutput!({
    installationId: "ins_1",
    componentName: "bucket",
    component: { kind: "object-store" },
    outputName: "bucket",
    outputs: {
      bucket: "assets",
      endpoint: "https://s3.example.test",
      accessKeyRef: "secret://bucket/access-key",
      secretKeyRef: "secret://bucket/secret-key",
    },
  });
  assert.deepEqual(legacyAliasMaterial, {
    bucket: "assets",
    endpoint: "https://s3.example.test",
    accessKeyRef: { secretRef: "secret://bucket/access-key" },
    secretKeyRef: { secretRef: "secret://bucket/secret-key" },
  });
});

test("takosumiPluginFromProviderPlugin projects HTTP outputs to endpoint material", async () => {
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
  const plugin = takosumiPluginFromProviderPlugin({
    provider,
    kindUri: "https://takosumi.com/kinds/v1/worker",
  });

  const material = await plugin.materializeOutput!({
    installationId: "ins_1",
    componentName: "web",
    component: { kind: "worker" },
    outputName: "http",
    outputs: { url: "https://web.internal", id: "web" },
  });

  assert.deepEqual(material, {
    url: "https://web.internal",
    id: "web",
  });
});

test("takosumiPluginFromProviderPlugin rejects explicit env collision", async () => {
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
  const plugin = takosumiPluginFromProviderPlugin({
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
          options: {
            output: "database.connection",
            inject: "env",
            prefix: "DB",
          },
          envInjections: { DB_HOST: "db.internal" },
          material: { host: "db.internal" },
        }],
      }),
    /conflicts with explicit spec/,
  );
});
