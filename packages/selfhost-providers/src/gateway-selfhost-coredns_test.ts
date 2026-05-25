import assert from "node:assert/strict";
import type { KernelPluginApplyContext } from "takosumi-contract/reference/plugin";
import {
  InMemoryCoreDnsLifecycle,
} from "@takos/takosumi-plugins/shape-providers/gateway/coredns-local";
import { selfhostCoreDnsGatewayProvider } from "./gateway-selfhost-coredns.ts";

Deno.test("selfhostCoreDnsGatewayProvider materializes multiple upstream routes", async () => {
  const lifecycle = new InMemoryCoreDnsLifecycle("/tmp/takosumi.test.zone");
  const plugin = selfhostCoreDnsGatewayProvider({
    lifecycle,
    defaultHost: "takos.test",
    ingressTarget: "127.0.0.1",
  });

  const applied = await plugin.apply(context());

  assert.equal(applied.resourceHandle, "coredns-1");
  assert.deepEqual(applied.outputs, {
    url: "https://takos.test",
    host: "takos.test",
    scheme: "https",
    listener: "public",
    ingressTarget: "127.0.0.1",
    routes: [
      {
        pathPrefix: "/git",
        to: "git",
        target: "http://127.0.0.1:19080",
      },
      {
        pathPrefix: "/",
        to: "app",
        target: "http://127.0.0.1:19082",
      },
    ],
  });
  const material = await plugin.publishMaterial!({
    installationId: "ins_1",
    componentName: "public",
    component: context().component,
    publicationName: "public",
    options: { as: "http-endpoint" },
    outputs: applied.outputs,
  });
  assert.equal(material.url, "https://takos.test");
  assert.deepEqual(material.routes, applied.outputs.routes);
});

Deno.test("selfhostCoreDnsGatewayProvider requires a host or defaultHost", async () => {
  const plugin = selfhostCoreDnsGatewayProvider();

  await assert.rejects(
    () => plugin.apply(context()),
    /requires spec\.listeners\.<name>\.host or selfhost defaultHost/,
  );
});

function context(): KernelPluginApplyContext {
  return {
    installationId: "ins_1",
    componentName: "public",
    component: {
      kind: "gateway",
      listen: {
        app: { from: "app.http", as: "upstream" },
        git: { from: "git.http", as: "upstream" },
      },
      publish: {
        public: { as: "http-endpoint" },
      },
      spec: {
        listeners: {
          public: {
            protocol: "https",
            tls: "auto",
          },
        },
        routes: [
          { listener: "public", path: "/git", to: "git" },
          { listener: "public", path: "/", to: "app" },
        ],
      },
    },
    source: { kind: "local", url: "/workspace/takos" },
    sourceDirectory: "/workspace/takos",
    listenedMaterials: {
      app: { url: "http://127.0.0.1:19082" },
      git: { url: "http://127.0.0.1:19080" },
    },
    resolvedBindings: [
      {
        listenerComponent: "public",
        bindingName: "app",
        sourceRef: "app.http",
        options: { from: "app.http", as: "upstream" },
        envInjections: {},
        target: { url: "http://127.0.0.1:19082" },
        material: { url: "http://127.0.0.1:19082" },
      },
      {
        listenerComponent: "public",
        bindingName: "git",
        sourceRef: "git.http",
        options: { from: "git.http", as: "upstream" },
        envInjections: {},
        target: { url: "http://127.0.0.1:19080" },
        material: { url: "http://127.0.0.1:19080" },
      },
    ],
  };
}
