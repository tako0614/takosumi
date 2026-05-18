import assert from "node:assert/strict";
import type {
  KernelPlugin,
  KernelPluginApplyContext,
  KernelPluginApplyResult,
  KernelPluginDeploymentContext,
  KernelPluginDestroyContext,
  KernelPluginInstallationContext,
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
        providerResourceId: `cf-worker:${ctx.componentName}`,
        outputs: { workerUrl: "https://app.example.test" },
      }),
  };

  assert.equal(plugin.name, "@takos/cloudflare-workers");
  assert.deepEqual([...plugin.provides], [
    "https://takosumi.com/kinds/v1/worker",
  ]);
  assert.equal(plugin.destroy, undefined);
  assert.equal(plugin.onInstallStart, undefined);
});

Deno.test("KernelPlugin lifecycle hook signatures accept Installation + Deployment", async () => {
  const calls: string[] = [];
  const installation: Installation = {
    id: "ins_1",
    accountId: "acc_1",
    spaceId: "space_1",
    appId: "app_1",
    currentDeploymentId: null,
    status: "running",
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
    apply: () =>
      Promise.resolve({ providerResourceId: "test://x", outputs: {} }),
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
    providerResourceId: "test://x",
  });

  assert.deepEqual(calls, [
    "onInstallStart",
    "onDeploymentStart",
    "onDeploymentComplete",
    "onInstallComplete",
    "destroy",
  ]);
});

Deno.test("KernelPlugin.apply receives Component + buildOutput + upstreamOutputs", async () => {
  const component: Component = {
    kind: "worker",
    use: { oidc: { mount: "oidc" } },
  };
  const seen: KernelPluginApplyContext[] = [];
  const plugin: KernelPlugin = {
    name: "@example/recording",
    version: "0.0.0",
    provides: ["worker"],
    apply: (ctx) => {
      seen.push(ctx);
      return Promise.resolve({
        providerResourceId: "rec://" + ctx.componentName,
        outputs: { ok: "1" },
      });
    },
  };

  const result = await plugin.apply({
    installationId: "ins_1",
    componentName: "web",
    component,
    buildOutput: { digest: "sha256:abc", uri: "file:///out" },
    upstreamOutputs: { oidc: { OIDC_CLIENT_ID: "c1" } },
  });

  assert.equal(result.providerResourceId, "rec://web");
  assert.deepEqual(seen[0].upstreamOutputs.oidc, { OIDC_CLIENT_ID: "c1" });
  assert.equal(seen[0].buildOutput?.digest, "sha256:abc");
});
