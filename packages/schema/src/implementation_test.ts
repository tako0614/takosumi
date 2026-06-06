import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type ApplyListenContext,
  type EnvInjection,
  type InlineMaterializer,
  type OperatorImplementation,
  type OperatorImplementationApplyContext,
  type OperatorImplementationApplyResult,
  type OperatorImplementationDeploymentContext,
  type OperatorImplementationDestroyContext,
  operatorImplementationFromNativeKindOperations,
  type OperatorImplementationInstallationContext,
  type Materializer,
  mergeResolvedEnv,
  type OutputMaterial,
  type OutputMaterialContext,
  outputsToOutputMaterial,
} from "./implementation.ts";
import type { Component } from "./implementation.ts";
import type { Deployment, Installation } from "./deploy-control-api.ts";

test("operatorImplementationFromNativeKindOperations wraps native operations without provider bridge", async () => {
  const seenSpecs: unknown[] = [];
  const implementation = operatorImplementationFromNativeKindOperations({
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

  const result = await implementation.apply({
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

  assert.equal(implementation.name, "@example/native-worker");
  assert.equal(implementation.version, "1.0.0");
  assert.deepEqual(implementation.provides, ["https://takosumi.com/kinds/v1/worker"]);
  assert.deepEqual(implementation.capabilities, ["scale-to-zero"]);
  assert.equal(result.resourceHandle, "worker://web");
  assert.deepEqual(seenSpecs, [{
    entrypoint: "src/main.ts",
    env: { EXPLICIT: "yes" },
  }]);

  const material = await implementation.materializeOutput!({
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

  await implementation.destroy?.({
    installationId: "ins_1",
    componentName: "web",
    resourceHandle: "worker://web",
  });

  const status = await implementation.status?.({
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

test("operatorImplementationFromNativeKindOperations validates author spec before apply", async () => {
  let applied = false;
  const implementation = operatorImplementationFromNativeKindOperations({
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
      implementation.apply({
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

test("operatorImplementationFromNativeKindOperations keeps listen env out of spec validation", async () => {
  let applied = false;
  let seenSpec: unknown;
  const implementation = operatorImplementationFromNativeKindOperations({
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

  await implementation.apply({
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
    /implementation outputs cannot be projected to object-store material: \$\.accessKeyRef unknown field; \$\.secretKeyRef unknown field/,
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

test("OperatorImplementation is a plain-array shape: name + provides + apply suffice", () => {
  const implementation: OperatorImplementation = {
    name: "@takos/cloudflare-workers",
    version: "1.0.0",
    provides: ["https://takosumi.com/kinds/v1/worker"],
    apply: (ctx: OperatorImplementationApplyContext) =>
      Promise.resolve<OperatorImplementationApplyResult>({
        resourceHandle: `cf-worker:${ctx.componentName}`,
        outputs: { workerUrl: "https://app.example.test" },
      }),
  };

  assert.equal(implementation.name, "@takos/cloudflare-workers");
  assert.deepEqual([...implementation.provides], [
    "https://takosumi.com/kinds/v1/worker",
  ]);
  assert.equal(implementation.destroy, undefined);
  assert.equal(implementation.onInstallStart, undefined);
  assert.equal(implementation.materializeOutput, undefined);
  assert.equal(implementation.applyListen, undefined);
});

test("OperatorImplementation lifecycle hook signatures accept Installation + Deployment", async () => {
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
    planDigest:
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

  const implementation: OperatorImplementation = {
    name: "@example/test",
    version: "0.0.0",
    provides: ["https://example.test/kinds/v1/test"],
    apply: () => Promise.resolve({ resourceHandle: "test://x", outputs: {} }),
    destroy: (_ctx: OperatorImplementationDestroyContext) => {
      calls.push("destroy");
      return Promise.resolve();
    },
    onInstallStart: (_ctx: OperatorImplementationInstallationContext) => {
      calls.push("onInstallStart");
      return Promise.resolve();
    },
    onInstallComplete: (_ctx: OperatorImplementationInstallationContext) => {
      calls.push("onInstallComplete");
      return Promise.resolve();
    },
    onDeploymentStart: (_ctx: OperatorImplementationDeploymentContext) => {
      calls.push("onDeploymentStart");
      return Promise.resolve();
    },
    onDeploymentComplete: (_ctx: OperatorImplementationDeploymentContext) => {
      calls.push("onDeploymentComplete");
      return Promise.resolve();
    },
  };

  await implementation.onInstallStart?.({ installation });
  await implementation.onDeploymentStart?.({ installation, deployment });
  await implementation.onDeploymentComplete?.({ installation, deployment });
  await implementation.onInstallComplete?.({ installation, deployment });
  await implementation.destroy?.({
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

test("OperatorImplementation.apply receives Component + source + input materials", async () => {
  const component: Component = {
    kind: "worker",
    connect: {
      db: { output: "database.connection", inject: "env", prefix: "DB" },
    },
  };
  const seen: OperatorImplementationApplyContext[] = [];
  const implementation: OperatorImplementation = {
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

  const result = await implementation.apply({
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

test("OperatorImplementation.materializeOutput emits output material", async () => {
  const component: Component = {
    kind: "worker",
  };
  const implementation: OperatorImplementation = {
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

  const material = await implementation.materializeOutput!({
    installationId: "ins_1",
    componentName: "web",
    component,
    outputName: "http",
    outputs: { url: "https://web.example.test", id: "w_1" },
  });

  assert.equal(material.url, "https://web.example.test");
  assert.equal(material.id, "w_1");
});

test("OperatorImplementation.applyListen returns an EnvInjection", async () => {
  const component: Component = {
    kind: "worker",
    connect: {
      db: { output: "database.connection", inject: "env", prefix: "DB" },
    },
  };
  const implementation: OperatorImplementation = {
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

  const injection = await implementation.applyListen!({
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
  // `Materializer = OperatorImplementation | InlineMaterializer` — both attach to
  // the same deploy control surface; this test exercises the inline form to
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
