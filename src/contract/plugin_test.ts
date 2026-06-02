import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type ApplyListenContext,
  type EnvInjection,
  type InlineMaterializer,
  type TakosumiPlugin,
  type TakosumiPluginApplyContext,
  type TakosumiPluginApplyResult,
  type TakosumiPluginDeploymentContext,
  type TakosumiPluginDestroyContext,
  takosumiPluginFromNativeKindOperations,
  type TakosumiPluginInstallationContext,
  type Materializer,
  mergeResolvedEnv,
  type OutputMaterial,
  type OutputMaterialContext,
  outputsToOutputMaterial,
} from "./plugin.ts";
import type { Component } from "./plugin.ts";
import type { Deployment, Installation } from "./installer-api.ts";

test("takosumiPluginFromNativeKindOperations wraps native operations without provider bridge", async () => {
  const seenSpecs: unknown[] = [];
  const plugin = takosumiPluginFromNativeKindOperations({
    kindUri: "https://takosumi.com/kinds/v1/worker",
    operations: {
      id: "@example/native-worker",
      version: "1.0.0",
      capabilities: ["scale-to-zero"],
      apply(spec) {
        seenSpecs.push(spec);
        return Promise.resolve({
          handle: "worker://web",
          outputs: {
            url: "https://web.example.test",
            id: "web",
          },
        });
      },
      destroy(handle) {
        assert.equal(handle, "worker://web");
        return Promise.resolve();
      },
      status(handle) {
        assert.equal(handle, "worker://web");
        return Promise.resolve({
          kind: "ready",
          outputs: {
            url: "https://web.example.test",
            id: "web",
          },
          observedAt: "2026-05-26T00:00:00.000Z",
        });
      },
    },
  });

  const result = await plugin.apply({
    installationId: "ins_1",
    componentName: "web",
    component: {
      kind: "worker",
      spec: {
        entrypoint: "src/main.ts",
        env: { EXPLICIT: "yes" },
      },
      connect: { db: { output: "database.connection", inject: "env" } },
    },
    source: { kind: "prepared", url: "file:///src.tar", digest: "sha256:abc" },
    sourceDirectory: "/tmp/prepared-source",
    listenedMaterials: {},
    resolvedBindings: [{
      listenerComponent: "web",
      bindingName: "db",
      sourceRef: "database.connection",
      options: { output: "database.connection", inject: "env" },
      envInjections: {
        DB_HOST: "db.internal",
        DB_PASSWORD: { secretRef: "secret://db/password" },
      },
      material: {},
    }],
  });

  assert.equal(plugin.name, "@example/native-worker");
  assert.equal(plugin.version, "1.0.0");
  assert.deepEqual(plugin.provides, ["https://takosumi.com/kinds/v1/worker"]);
  assert.deepEqual(plugin.capabilities, ["scale-to-zero"]);
  assert.equal(result.resourceHandle, "worker://web");
  assert.deepEqual(seenSpecs, [{
    entrypoint: "src/main.ts",
    env: { EXPLICIT: "yes" },
  }]);

  const material = await plugin.materializeOutput!({
    installationId: "ins_1",
    componentName: "web",
    component: { kind: "worker" },
    outputName: "http",
    outputs: result.outputs,
  });
  assert.deepEqual(material, {
    url: "https://web.example.test",
    id: "web",
  });

  await plugin.destroy?.({
    installationId: "ins_1",
    componentName: "web",
    resourceHandle: "worker://web",
  });

  const status = await plugin.status?.({
    installationId: "ins_1",
    componentName: "web",
    resourceHandle: "worker://web",
  });
  assert.deepEqual(status, {
    kind: "ready",
    outputs: {
      url: "https://web.example.test",
      id: "web",
    },
    observedAt: "2026-05-26T00:00:00.000Z",
  });
});

test("takosumiPluginFromNativeKindOperations validates author spec before apply", async () => {
  let applied = false;
  const plugin = takosumiPluginFromNativeKindOperations({
    kindUri: "https://takosumi.com/kinds/v1/worker",
    operations: {
      id: "@example/native-worker",
      version: "1.0.0",
      validateSpec(value) {
        if (
          typeof value === "object" && value !== null &&
          "unsupported" in value
        ) {
          return [{ path: "$.unsupported", message: "unknown field" }];
        }
        return [];
      },
      apply() {
        applied = true;
        return Promise.resolve({ handle: "worker://web", outputs: {} });
      },
    },
  });

  await assert.rejects(
    () =>
      plugin.apply({
        installationId: "ins_1",
        componentName: "web",
        component: {
          kind: "worker",
          spec: { entrypoint: "src/main.ts", unsupported: true },
        },
        source: { kind: "local", commit: "" },
        sourceDirectory: "/tmp/prepared-source",
        listenedMaterials: {},
        resolvedBindings: [],
      }),
    /component web spec invalid for https:\/\/takosumi\.com\/kinds\/v1\/worker: \$\.unsupported unknown field/,
  );
  assert.equal(applied, false);
});

test("takosumiPluginFromNativeKindOperations keeps listen env out of spec validation", async () => {
  let applied = false;
  let seenSpec: unknown;
  const plugin = takosumiPluginFromNativeKindOperations({
    kindUri: "https://takosumi.com/kinds/v1/postgres",
    operations: {
      id: "@example/native-postgres",
      version: "1.0.0",
      validateSpec(value) {
        if (
          typeof value === "object" && value !== null &&
          "env" in value
        ) {
          return [{ path: "$.env", message: "unknown field" }];
        }
        return [];
      },
      apply(spec) {
        applied = true;
        seenSpec = spec;
        return Promise.resolve({ handle: "postgres://db", outputs: {} });
      },
    },
  });

  await plugin.apply({
    installationId: "ins_1",
    componentName: "db",
    component: {
      kind: "postgres",
      spec: { version: "16", size: "small" },
    },
    source: { kind: "local", commit: "" },
    sourceDirectory: "/tmp/prepared-source",
    listenedMaterials: {},
    resolvedBindings: [{
      listenerComponent: "db",
      bindingName: "upstream",
      sourceRef: "gateway.public",
      options: { output: "gateway.public", inject: "env" },
      envInjections: { UPSTREAM_URL: "https://app.example.test" },
      material: {},
    }],
  });
  assert.equal(applied, true);
  assert.deepEqual(seenSpec, { version: "16", size: "small" });
});

test("mergeResolvedEnv explicitly merges runtime env for native providers", () => {
  const env = mergeResolvedEnv({ EXPLICIT: "yes" }, [{
    listenerComponent: "web",
    bindingName: "db",
    sourceRef: "database.connection",
    options: { output: "database.connection", inject: "secret-env" },
    envInjections: {
      DB_HOST: "db.internal",
      DB_PASSWORD: { secretRef: "secret://db/password" },
    },
    material: {},
  }]);

  assert.deepEqual(env, {
    EXPLICIT: "yes",
    DB_HOST: "db.internal",
    DB_PASSWORD: { secretRef: "secret://db/password" },
  });

  assert.throws(
    () =>
      mergeResolvedEnv({ DB_HOST: "explicit" }, [{
        listenerComponent: "web",
        bindingName: "db",
        sourceRef: "database.connection",
        options: { output: "database.connection", inject: "env" },
        envInjections: { DB_HOST: "db.internal" },
        material: {},
      }]),
    /binding-derived \$\.env\.DB_HOST conflicts with explicit spec/,
  );
});

test("outputsToOutputMaterial projects official materials and secret refs", () => {
  const service = outputsToOutputMaterial({
    host: "db.internal",
    port: 5432,
    database: "app",
    username: "app",
    passwordSecretRef: "secret://db/password",
  }, "service-binding");
  assert.deepEqual(service, {
    protocol: "postgresql",
    host: "db.internal",
    port: 5432,
    service: "db.internal",
    database: "app",
    username: "app",
    passwordRef: { secretRef: "secret://db/password" },
  });

  const objectStore = outputsToOutputMaterial({
    bucket: "assets",
    endpoint: "https://s3.example.test",
    accessKeyIdRef: "secret://bucket/access-key-id",
    secretAccessKeyRef: "secret://bucket/secret-access-key",
  }, "object-store");
  assert.deepEqual(objectStore, {
    bucket: "assets",
    endpoint: "https://s3.example.test",
    accessKeyIdRef: { secretRef: "secret://bucket/access-key-id" },
    secretAccessKeyRef: {
      secretRef: "secret://bucket/secret-access-key",
    },
  });
});

test("outputsToOutputMaterial rejects retired object-store credential aliases", () => {
  assert.throws(
    () =>
      outputsToOutputMaterial({
        bucket: "assets",
        endpoint: "https://s3.example.test",
        accessKeyRef: "secret://bucket/access-key",
        secretKeyRef: "secret://bucket/secret-key",
      }, "object-store"),
    /plugin outputs cannot be projected to object-store material: \$\.accessKeyRef unknown field; \$\.secretKeyRef unknown field/,
  );
});

test("mergeResolvedEnv rejects listen env collisions", () => {
  assert.throws(
    () =>
      mergeResolvedEnv({ DB_HOST: "explicit.example" }, [
        {
          listenerComponent: "web",
          bindingName: "db",
          sourceRef: "database.connection",
          options: { output: "database.connection", inject: "env" },
          envInjections: { DB_HOST: "db.internal" },
          material: {},
        },
      ]),
    /binding-derived \$\.env\.DB_HOST conflicts with explicit spec/,
  );
});

test("TakosumiPlugin is a plain-array shape: name + provides + apply suffice", () => {
  const plugin: TakosumiPlugin = {
    name: "@takos/cloudflare-workers",
    version: "1.0.0",
    provides: ["https://takosumi.com/kinds/v1/worker"],
    apply: (ctx: TakosumiPluginApplyContext) =>
      Promise.resolve<TakosumiPluginApplyResult>({
        resourceHandle: `cf-worker:${ctx.componentName}`,
        outputs: { workerUrl: "https://app.example.test" },
      }),
  };

  assert.equal(plugin.name, "@takos/cloudflare-workers");
  assert.deepEqual([...plugin.provides], [
    "https://takosumi.com/kinds/v1/worker",
  ]);
  assert.equal(plugin.destroy, undefined);
  assert.equal(plugin.onInstallStart, undefined);
  assert.equal(plugin.materializeOutput, undefined);
  assert.equal(plugin.applyListen, undefined);
});

test("TakosumiPlugin lifecycle hook signatures accept Installation + Deployment", async () => {
  const calls: string[] = [];
  const installation: Installation = {
    id: "ins_1",
    spaceId: "space_1",
    appId: "app_1",
    currentDeploymentId: null,
    status: "ready",
    createdAt: 0,
  };
  const deployment: Deployment = {
    id: "dep_1",
    installationId: "ins_1",
    source: { kind: "local", url: "/tmp/app" },
    planSnapshotDigest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    planSnapshot: {
      source: { kind: "local", url: "/tmp/app" },
      repo: { id: "app_1", name: "app" },
      requestedBindings: [],
      resolvedBindings: [],
      publications: [],
      changes: [],
      warnings: [],
    },
    bindingsSnapshot: [],
    status: "succeeded",
    outputs: {},
    createdAt: 0,
  };

  const plugin: TakosumiPlugin = {
    name: "@example/test",
    version: "0.0.0",
    provides: ["https://example.test/kinds/v1/test"],
    apply: () => Promise.resolve({ resourceHandle: "test://x", outputs: {} }),
    destroy: (_ctx: TakosumiPluginDestroyContext) => {
      calls.push("destroy");
      return Promise.resolve();
    },
    onInstallStart: (_ctx: TakosumiPluginInstallationContext) => {
      calls.push("onInstallStart");
      return Promise.resolve();
    },
    onInstallComplete: (_ctx: TakosumiPluginInstallationContext) => {
      calls.push("onInstallComplete");
      return Promise.resolve();
    },
    onDeploymentStart: (_ctx: TakosumiPluginDeploymentContext) => {
      calls.push("onDeploymentStart");
      return Promise.resolve();
    },
    onDeploymentComplete: (_ctx: TakosumiPluginDeploymentContext) => {
      calls.push("onDeploymentComplete");
      return Promise.resolve();
    },
  };

  await plugin.onInstallStart?.({ installation });
  await plugin.onDeploymentStart?.({ installation, deployment });
  await plugin.onDeploymentComplete?.({ installation, deployment });
  await plugin.onInstallComplete?.({ installation, deployment });
  await plugin.destroy?.({
    installationId: "ins_1",
    componentName: "web",
    resourceHandle: "test://x",
  });

  assert.deepEqual(calls, [
    "onInstallStart",
    "onDeploymentStart",
    "onDeploymentComplete",
    "onInstallComplete",
    "destroy",
  ]);
});

test("TakosumiPlugin.apply receives Component + source + input materials", async () => {
  const component: Component = {
    kind: "worker",
    connect: {
      db: { output: "database.connection", inject: "env", prefix: "DB" },
    },
  };
  const seen: TakosumiPluginApplyContext[] = [];
  const plugin: TakosumiPlugin = {
    name: "@example/recording",
    version: "0.0.0",
    provides: ["worker"],
    apply: (ctx) => {
      seen.push(ctx);
      return Promise.resolve({
        resourceHandle: "rec://" + ctx.componentName,
        outputs: { ok: "1" },
      });
    },
  };

  const dbMaterial: OutputMaterial = {
    host: "db.internal",
    port: "5432",
    passwordSecretRef: "secret://db/password",
  };

  const result = await plugin.apply({
    installationId: "ins_1",
    componentName: "web",
    component,
    source: { kind: "prepared", url: "file:///src.tar", digest: "sha256:abc" },
    sourceDirectory: "/tmp/prepared-source",
    inputMaterials: { db: dbMaterial },
    listenedMaterials: { db: dbMaterial },
    resolvedBindings: [{
      listenerComponent: "web",
      bindingName: "db",
      sourceRef: "database.connection",
      options: { output: "database.connection", inject: "env", prefix: "DB" },
      envInjections: { DB_HOST: "db.internal" },
      material: dbMaterial,
    }],
  });

  assert.equal(result.resourceHandle, "rec://web");
  assert.deepEqual(seen[0].inputMaterials?.db, dbMaterial);
  assert.deepEqual(seen[0].listenedMaterials.db, dbMaterial);
  assert.equal(
    seen[0].resolvedBindings[0]?.envInjections.DB_HOST,
    "db.internal",
  );
  assert.equal(seen[0].source.digest, "sha256:abc");
  assert.equal(seen[0].sourceDirectory, "/tmp/prepared-source");
});

test("TakosumiPlugin.materializeOutput emits output material", async () => {
  const component: Component = {
    kind: "worker",
  };
  const plugin: TakosumiPlugin = {
    name: "@example/worker",
    version: "0.0.0",
    provides: ["worker"],
    apply: () =>
      Promise.resolve({
        resourceHandle: "worker://web",
        outputs: { url: "https://web.example.test", id: "w_1" },
      }),
    materializeOutput: (ctx: OutputMaterialContext) =>
      Promise.resolve({
        url: String(ctx.outputs.url),
        id: String(ctx.outputs.id),
      }),
  };

  const material = await plugin.materializeOutput!({
    installationId: "ins_1",
    componentName: "web",
    component,
    outputName: "http",
    outputs: { url: "https://web.example.test", id: "w_1" },
  });

  assert.equal(material.url, "https://web.example.test");
  assert.equal(material.id, "w_1");
});

test("TakosumiPlugin.applyListen returns an EnvInjection", async () => {
  const component: Component = {
    kind: "worker",
    connect: {
      db: { output: "database.connection", inject: "env", prefix: "DB" },
    },
  };
  const plugin: TakosumiPlugin = {
    name: "@example/worker",
    version: "0.0.0",
    provides: ["worker"],
    apply: () =>
      Promise.resolve({ resourceHandle: "worker://web", outputs: {} }),
    applyListen: (ctx: ApplyListenContext): Promise<EnvInjection> => {
      const prefix = ctx.options.prefix ?? "";
      const env: Record<string, string | { secretRef: string }> = {};
      for (const [field, value] of Object.entries(ctx.material)) {
        const key = prefix
          ? `${prefix}_${field.toUpperCase()}`
          : field.toUpperCase();
        if (typeof value === "string") {
          env[key] = value;
        } else if (
          value !== null && typeof value === "object" &&
          !Array.isArray(value) && typeof value.secretRef === "string"
        ) {
          env[key] = { secretRef: value.secretRef };
        }
      }
      return Promise.resolve({ env });
    },
  };

  const injection = await plugin.applyListen!({
    installationId: "ins_1",
    componentName: "web",
    component,
    bindingName: "db",
    sourceRef: "database.connection",
    options: { output: "database.connection", inject: "env", prefix: "DB" },
    material: {
      host: "db.internal",
      port: "5432",
    },
  });

  assert.deepEqual(injection.env, {
    DB_HOST: "db.internal",
    DB_PORT: "5432",
  });
});

test("InlineMaterializer is the minimal Materializer packaging", () => {
  // `Materializer = TakosumiPlugin | InlineMaterializer` — both attach to
  // the same installer surface; this test exercises the inline form to
  // pin the type contract.
  const inline: InlineMaterializer = {
    provides: ["https://example.com/kinds/lambda"],
    aliases: ["lambda"],
    apply: (ctx) =>
      Promise.resolve({
        resourceHandle: `lambda://${ctx.componentName}`,
        outputs: { arn: "arn:fake:lambda:web" },
      }),
  };

  const materializer: Materializer = inline;
  assert.deepEqual([...materializer.provides], [
    "https://example.com/kinds/lambda",
  ]);
  assert.deepEqual([...(materializer.aliases ?? [])], ["lambda"]);
});
