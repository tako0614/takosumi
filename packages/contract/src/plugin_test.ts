import assert from "node:assert/strict";
import type {
  ApplyListenContext,
  EnvInjection,
  InlineMaterializer,
  KernelPlugin,
  KernelPluginApplyContext,
  KernelPluginApplyResult,
  KernelPluginDeploymentContext,
  KernelPluginDestroyContext,
  KernelPluginInstallationContext,
  Materializer,
  NamespaceMaterial,
  PublishMaterialContext,
} from "./plugin.ts";
import type { Component } from "./app-spec.ts";
import type { Deployment, Installation } from "./installer-api.ts";

Deno.test("KernelPlugin is a plain-array shape: name + provides + apply suffice", () => {
  const plugin: KernelPlugin = {
    name: "@takos/cloudflare-workers",
    version: "1.0.0",
    provides: ["https://takosumi.com/kinds/v1/worker"],
    apply: (ctx: KernelPluginApplyContext) =>
      Promise.resolve<KernelPluginApplyResult>({
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
  assert.equal(plugin.publishMaterial, undefined);
  assert.equal(plugin.applyListen, undefined);
});

Deno.test("KernelPlugin lifecycle hook signatures accept Installation + Deployment", async () => {
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
    source: { kind: "local", commit: "" },
    manifestDigest: "sha256:test",
    status: "succeeded",
    outputs: {},
    createdAt: 0,
  };

  const plugin: KernelPlugin = {
    name: "@example/test",
    version: "0.0.0",
    provides: ["https://example.test/kinds/v1/test"],
    apply: () => Promise.resolve({ resourceHandle: "test://x", outputs: {} }),
    destroy: (_ctx: KernelPluginDestroyContext) => {
      calls.push("destroy");
      return Promise.resolve();
    },
    onInstallStart: (_ctx: KernelPluginInstallationContext) => {
      calls.push("onInstallStart");
      return Promise.resolve();
    },
    onInstallComplete: (_ctx: KernelPluginInstallationContext) => {
      calls.push("onInstallComplete");
      return Promise.resolve();
    },
    onDeploymentStart: (_ctx: KernelPluginDeploymentContext) => {
      calls.push("onDeploymentStart");
      return Promise.resolve();
    },
    onDeploymentComplete: (_ctx: KernelPluginDeploymentContext) => {
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

Deno.test("KernelPlugin.apply receives Component + source + listenedMaterials", async () => {
  const component: Component = {
    kind: "worker",
    publish: { http: { as: "http-endpoint" } },
    listen: {
      db: { from: "database.connection", as: "env", prefix: "DB" },
    },
  };
  const seen: KernelPluginApplyContext[] = [];
  const plugin: KernelPlugin = {
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

  const dbMaterial: NamespaceMaterial = {
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
    listenedMaterials: { db: dbMaterial },
    resolvedBindings: [{
      listenerComponent: "web",
      bindingName: "db",
      sourceRef: "database.connection",
      options: { from: "database.connection", as: "env", prefix: "DB" },
      envInjections: { DB_HOST: "db.internal" },
      material: dbMaterial,
    }],
  });

  assert.equal(result.resourceHandle, "rec://web");
  assert.deepEqual(seen[0].listenedMaterials.db, dbMaterial);
  assert.equal(
    seen[0].resolvedBindings[0]?.envInjections.DB_HOST,
    "db.internal",
  );
  assert.equal(seen[0].source.digest, "sha256:abc");
  assert.equal(seen[0].sourceDirectory, "/tmp/prepared-source");
});

Deno.test("KernelPlugin.publishMaterial emits a NamespaceMaterial", async () => {
  const component: Component = {
    kind: "worker",
    publish: { http: { as: "http-endpoint" } },
  };
  const plugin: KernelPlugin = {
    name: "@example/worker",
    version: "0.0.0",
    provides: ["worker"],
    apply: () =>
      Promise.resolve({
        resourceHandle: "worker://web",
        outputs: { url: "https://web.example.test", id: "w_1" },
      }),
    publishMaterial: (ctx: PublishMaterialContext) =>
      Promise.resolve({
        url: String(ctx.outputs.url),
        id: String(ctx.outputs.id),
      }),
  };

  const material = await plugin.publishMaterial!({
    installationId: "ins_1",
    componentName: "web",
    component,
    publicationName: "http",
    options: { as: "http-endpoint" },
    outputs: { url: "https://web.example.test", id: "w_1" },
  });

  assert.equal(material.url, "https://web.example.test");
  assert.equal(material.id, "w_1");
});

Deno.test("KernelPlugin.applyListen returns an EnvInjection", async () => {
  const component: Component = {
    kind: "worker",
    listen: {
      db: { from: "database.connection", as: "env", prefix: "DB" },
    },
  };
  const plugin: KernelPlugin = {
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
    options: { from: "database.connection", as: "env", prefix: "DB" },
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

Deno.test("InlineMaterializer is the minimal Materializer packaging", () => {
  // `Materializer = KernelPlugin | InlineMaterializer` — both attach to
  // the same installer surface; this test exercises the inline form to
  // pin the type contract.
  const inline: InlineMaterializer = {
    provides: ["https://operator.example.com/kinds/lambda"],
    aliases: ["lambda"],
    apply: (ctx) =>
      Promise.resolve({
        resourceHandle: `lambda://${ctx.componentName}`,
        outputs: { arn: "arn:fake:lambda:web" },
      }),
  };

  const materializer: Materializer = inline;
  assert.deepEqual([...materializer.provides], [
    "https://operator.example.com/kinds/lambda",
  ]);
  assert.deepEqual([...(materializer.aliases ?? [])], ["lambda"]);
});
