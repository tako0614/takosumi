import assert from "node:assert/strict";
import {
  type CoreDnsRecordDescriptor,
  InMemoryCoreDnsLifecycle,
} from "@takos/takosumi-plugins/shape-providers/gateway/coredns-local";
import { coreDnsGatewayProvider } from "./mod.ts";

Deno.test("coreDnsGatewayProvider materializes multiple upstream routes", async () => {
  const lifecycle = new InMemoryCoreDnsLifecycle("/tmp/takosumi.test.zone");
  const plugin = coreDnsGatewayProvider({
    lifecycle,
    defaultHost: "app.takosumi.test",
    ingressTarget: "127.0.0.1",
  });
  const result = await plugin.apply({
    installationId: "ins_1",
    componentName: "public",
    component: {
      kind: "gateway",
      spec: {
        listeners: {
          public: { protocol: "https", tls: "auto" },
        },
        routes: [
          { listener: "public", path: "/git", to: "git" },
          { listener: "public", path: "/", to: "app" },
        ],
      },
    },
    source: { kind: "local", digest: "sha256:test" },
    sourceDirectory: "/src",
    listenedMaterials: {},
    resolvedBindings: [
      {
        listenerComponent: "public",
        bindingName: "git",
        sourceRef: "git.http",
        options: { from: "git.http", as: "upstream" },
        envInjections: {},
        target: { url: "http://git:8790" },
        material: { url: "http://git:8790" },
      },
      {
        listenerComponent: "public",
        bindingName: "app",
        sourceRef: "app.http",
        options: { from: "app.http", as: "upstream" },
        envInjections: {},
        target: { url: "http://app:8080" },
        material: { url: "http://app:8080" },
      },
    ],
  });
  assert.equal(result.resourceHandle, "coredns-1");
  assert.equal(result.outputs.url, "https://app.takosumi.test");
  const record = await lifecycle.describeRecord({
    recordName: result.resourceHandle,
  }) as CoreDnsRecordDescriptor;
  assert.equal(record.fqdn, "app.takosumi.test");
  assert.deepEqual(record.routes, [
    { pathPrefix: "/git", to: "git", target: "http://git:8790" },
    { pathPrefix: "/", to: "app", target: "http://app:8080" },
  ]);
});

Deno.test("coreDnsGatewayProvider requires a host or defaultHost", async () => {
  const plugin = coreDnsGatewayProvider();
  await assert.rejects(
    () =>
      plugin.apply({
        installationId: "ins_1",
        componentName: "public",
        component: {
          kind: "gateway",
          spec: {
            listeners: {
              public: { protocol: "https", tls: "auto" },
            },
            routes: [{ listener: "public", path: "/", to: "app" }],
          },
        },
        source: { kind: "local", digest: "sha256:test" },
        sourceDirectory: "/src",
        listenedMaterials: {},
        resolvedBindings: [
          {
            listenerComponent: "public",
            bindingName: "app",
            sourceRef: "app.http",
            options: { from: "app.http", as: "upstream" },
            envInjections: {},
            target: { url: "http://app:8080" },
            material: { url: "http://app:8080" },
          },
        ],
      }),
    /requires spec\.listeners\.<name>\.host or defaultHost/,
  );
});
