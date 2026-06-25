import { test, expect } from "bun:test";
import {
  InMemoryServiceBindingStore,
  InMemoryServiceExportStore,
  InMemoryServiceGraphGrantStore,
  ServiceGraphService,
} from "../../../../core/domains/service-graph/mod.ts";

test("Service Graph stores query exports, bindings, and grants by canonical ids", async () => {
  const exports = new InMemoryServiceExportStore();
  const bindings = new InMemoryServiceBindingStore();
  const grants = new InMemoryServiceGraphGrantStore();

  await exports.put({
    id: "sexp_mcp",
    workspaceId: "ws_1",
    producerCapsuleId: "cap_tools",
    outputId: "out_1",
    outputGeneration: 7,
    name: "tools",
    capabilities: ["protocol.mcp.server"],
    visibility: "space",
    status: "ready",
    endpoints: [{ name: "mcp", url: "https://tools.example.test/mcp" }],
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  });
  await bindings.put({
    id: "sbind_agent",
    workspaceId: "ws_1",
    consumerCapsuleId: "cap_agent",
    target: { kind: "workload", name: "agent-runtime" },
    selector: { capabilities: ["protocol.mcp.server"] },
    selectedServiceExportId: "sexp_mcp",
    dependencySnapshotId: "deps_1",
    dependencyMode: "variable_injection",
    grantRequest: {
      scopes: ["mcp.invoke"],
      audience: ["cap_agent"],
      env: ["MCP_BASE_URL", "MCP_TOKEN"],
    },
    status: "bound",
    createdAt: "2026-06-14T00:00:01.000Z",
    updatedAt: "2026-06-14T00:00:01.000Z",
  });
  await grants.put({
    id: "sgrant_agent",
    workspaceId: "ws_1",
    bindingId: "sbind_agent",
    serviceExportId: "sexp_mcp",
    consumerCapsuleId: "cap_agent",
    scopes: ["mcp.invoke"],
    audience: ["cap_agent"],
    material: { baseUrlEnv: "MCP_BASE_URL", tokenEnv: "MCP_TOKEN" },
    secretRef: "vault://service-grants/sgrant_agent/token",
    status: "active",
    createdAt: "2026-06-14T00:00:02.000Z",
    expiresAt: "2026-06-15T00:00:00.000Z",
  });

  expect(
    await exports.listByCapability("ws_1", "protocol.mcp.server"),
  ).toHaveLength(1);
  expect(await bindings.listBySelectedExport("sexp_mcp")).toHaveLength(1);
  expect(
    await grants.listActiveByConsumerCapsule(
      "cap_agent",
      "2026-06-14T12:00:00.000Z",
    ),
  ).toHaveLength(1);
  expect(
    await grants.listActiveByConsumerCapsule(
      "cap_agent",
      "2026-06-16T00:00:00.000Z",
    ),
  ).toHaveLength(0);
});

test("ServiceGraphService projects exports, resolves bindings fail-closed, and issues grants", async () => {
  const stores = {
    exports: new InMemoryServiceExportStore(),
    bindings: new InMemoryServiceBindingStore(),
    grants: new InMemoryServiceGraphGrantStore(),
  };
  const service = new ServiceGraphService({
    stores,
    clock: () => "2026-06-14T01:00:00.000Z",
    idGenerator: (prefix) => `${prefix}_test`,
  });

  const projected = await service.projectExportsFromOutputSnapshot({
    workspaceId: "ws_1",
    producerCapsuleId: "cap_tools",
    applyRunId: "run_apply_1",
    outputId: "out_1",
    outputGeneration: 1,
    outputs: {
      service_exports: [
        {
          name: "tools",
          capabilities: ["protocol.mcp.server"],
          endpoints: [{ name: "mcp", url: "https://tools.example.test/mcp" }],
          auth: [{ scheme: "bearer", scopes: ["mcp.invoke"] }],
          visibility: "space",
        },
      ],
    },
  });

  expect(projected).toHaveLength(1);
  expect(projected[0]?.status).toBe("ready");

  const binding = await service.requestBinding({
    id: "sbind_agent",
    workspaceId: "ws_1",
    consumerCapsuleId: "cap_agent",
    target: { kind: "workload", name: "agent-runtime" },
    selector: { capabilities: ["protocol.mcp.server"], name: "tools" },
    grantRequest: {
      scopes: ["mcp.invoke"],
      audience: ["cap_agent"],
      env: ["MCP_BASE_URL", "MCP_TOKEN"],
    },
  });
  expect(binding.status).toBe("pending");

  const resolved = await service.resolveBinding("sbind_agent");
  expect(resolved.status).toBe("bound");
  expect(resolved.selectedServiceExportId).toBe(projected[0]?.id);

  const grant = await service.issueGrant({
    id: "sgrant_agent",
    bindingId: "sbind_agent",
    material: { baseUrlEnv: "MCP_BASE_URL", tokenEnv: "MCP_TOKEN" },
    secretRef: "vault://service-grants/sgrant_agent/token",
  });
  expect(grant.status).toBe("active");
  expect(grant.serviceExportId).toBe(projected[0]?.id);
});

test("ServiceGraphService projects takos_app publish and consume declarations", async () => {
  const stores = {
    exports: new InMemoryServiceExportStore(),
    bindings: new InMemoryServiceBindingStore(),
    grants: new InMemoryServiceGraphGrantStore(),
  };
  const service = new ServiceGraphService({
    stores,
    clock: () => "2026-06-14T01:00:00.000Z",
  });

  const projected = await service.projectFromOutputSnapshot({
    workspaceId: "ws_1",
    producerCapsuleId: "cap_yurucommu",
    applyRunId: "run_apply_1",
    outputId: "out_1",
    outputGeneration: 1,
    outputs: {
      takos_app: {
        name: "yurucommu",
        version: "2.0.0",
        compute: {
          web: {
            kind: "worker",
            consume: [
              {
                publication: "launcher",
                inject: { env: { url: "APP_URL" } },
              },
              {
                publication: "identity.oidc",
                inject: {
                  env: {
                    issuerUrl: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
                    clientId: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
                  },
                },
              },
            ],
          },
        },
        publish: [
          {
            name: "launcher",
            publisher: "web",
            type: "UiSurface",
            outputs: { url: { kind: "url", routeRef: "root" } },
            display: {
              title: "Yurucommu",
              category: "social",
            },
            spec: { launcher: true },
          },
        ],
      },
    },
  });

  expect(projected.serviceExports).toHaveLength(1);
  expect(projected.serviceExports[0]?.name).toBe("launcher");
  expect(projected.serviceExports[0]?.capabilities).toEqual([
    "interface.ui.surface",
  ]);
  expect(projected.serviceExports[0]?.labels).toEqual({
    app: "yurucommu",
    version: "2.0.0",
    publisher: "web",
  });
  expect(projected.serviceExports[0]?.metadata?.display).toEqual({
    title: "Yurucommu",
    category: "social",
  });

  expect(projected.serviceBindings).toHaveLength(2);
  const launcher = projected.serviceBindings.find(
    (binding) => binding.selector.name === "launcher",
  );
  expect(launcher?.selector).toEqual({
    capabilities: ["interface.ui.surface"],
    name: "launcher",
    producerCapsuleId: "cap_yurucommu",
  });
  expect(launcher?.grantRequest.env).toEqual(["APP_URL"]);

  const oidc = projected.serviceBindings.find(
    (binding) => binding.selector.name === "identity.oidc",
  );
  expect(oidc?.selector.capabilities).toEqual(["identity.oidc"]);
  expect(oidc?.target).toEqual({
    kind: "workload",
    name: "web",
    metadata: {
      source: "takos_app.compute",
      appName: "yurucommu",
      componentName: "web",
      componentKind: "worker",
    },
  });
  expect(oidc?.grantRequest.env).toEqual([
    "TAKOSUMI_ACCOUNTS_ISSUER_URL",
    "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  ]);
  expect(oidc?.grantRequest.scopes).toEqual(["openid", "profile", "email"]);
  expect(oidc?.grantRequest.metadata?.sourceRef).toEqual(
    "takosumi.identity.oidc",
  );
});

test("ServiceGraphService projects generic service_exports and service_bindings", async () => {
  const stores = {
    exports: new InMemoryServiceExportStore(),
    bindings: new InMemoryServiceBindingStore(),
    grants: new InMemoryServiceGraphGrantStore(),
  };
  const service = new ServiceGraphService({
    stores,
    clock: () => "2026-06-14T01:00:00.000Z",
  });

  const projected = await service.projectFromOutputSnapshot({
    workspaceId: "ws_1",
    producerCapsuleId: "cap_yurucommu",
    applyRunId: "run_apply_1",
    outputId: "out_1",
    outputGeneration: 1,
    outputs: {
      service_exports: [
        {
          name: "launcher",
          capabilities: ["interface.ui.surface"],
          endpoints: [{ name: "default", protocol: "https", pathPrefix: "/" }],
          metadata: { title: "Yurucommu", category: "social" },
          visibility: "space",
        },
      ],
      service_bindings: [
        {
          name: "web_launcher",
          target: {
            kind: "workload",
            name: "web",
            metadata: { componentKind: "worker" },
          },
          selector: {
            name: "launcher",
            producer: "self",
            capabilities: ["interface.ui.surface"],
          },
          grant_request: {
            scopes: [],
            audience: ["web"],
            env: ["APP_URL"],
            metadata: { inject: { env: { url: "APP_URL" } } },
          },
        },
        {
          name: "web_identity_oidc",
          target: {
            kind: "workload",
            name: "web",
            metadata: { componentKind: "worker" },
          },
          selector: {
            name: "identity.oidc",
            capabilities: ["identity.oidc"],
          },
          grant_request: {
            scopes: ["openid", "profile", "email"],
            audience: ["web"],
            env: [
              "TAKOSUMI_ACCOUNTS_ISSUER_URL",
              "TAKOSUMI_ACCOUNTS_CLIENT_ID",
            ],
            metadata: { sourceRef: "takosumi.identity.oidc" },
          },
        },
      ],
    },
  });

  expect(projected.serviceExports).toHaveLength(1);
  expect(projected.serviceExports[0]?.name).toBe("launcher");
  expect(projected.serviceExports[0]?.metadata).toEqual({
    title: "Yurucommu",
    category: "social",
  });

  expect(projected.serviceBindings).toHaveLength(2);
  const launcher = projected.serviceBindings.find(
    (binding) => binding.selector.name === "launcher",
  );
  expect(launcher?.selector).toEqual({
    capabilities: ["interface.ui.surface"],
    name: "launcher",
    producerCapsuleId: "cap_yurucommu",
  });
  expect(launcher?.target).toEqual({
    kind: "workload",
    name: "web",
    metadata: { componentKind: "worker" },
  });
  expect(launcher?.grantRequest.env).toEqual(["APP_URL"]);

  const oidc = projected.serviceBindings.find(
    (binding) => binding.selector.name === "identity.oidc",
  );
  expect(oidc?.selector.capabilities).toEqual(["identity.oidc"]);
  expect(oidc?.grantRequest.scopes).toEqual(["openid", "profile", "email"]);
  expect(oidc?.grantRequest.env).toEqual([
    "TAKOSUMI_ACCOUNTS_ISSUER_URL",
    "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  ]);
});

test("ServiceGraphService enforces grant ttl and requested env material", async () => {
  const service = seededBoundServiceGraph();

  const grant = await service.issueGrant({
    id: "sgrant_ttl",
    bindingId: "sbind_agent",
    material: { tokenEnv: "MCP_TOKEN" },
  });

  expect(grant.expiresAt).toBe("2026-06-14T01:05:00.000Z");
  await expect(
    service.issueGrant({
      id: "sgrant_bad_env",
      bindingId: "sbind_agent",
      material: { tokenEnv: "OTHER_TOKEN" },
    }),
  ).rejects.toThrow(/not listed in grantRequest\.env/);
  await expect(
    service.issueGrant({
      id: "sgrant_long_ttl",
      bindingId: "sbind_agent",
      expiresAt: "2026-06-14T01:10:01.000Z",
    }),
  ).rejects.toThrow(/ttlSeconds/);
});

test("ServiceGraphService rejects extension capability tokens unless policy enables them", async () => {
  const stores = {
    exports: new InMemoryServiceExportStore(),
    bindings: new InMemoryServiceBindingStore(),
    grants: new InMemoryServiceGraphGrantStore(),
  };
  const service = new ServiceGraphService({ stores });

  await expect(
    service.recordExport({
      workspaceId: "ws_1",
      producerCapsuleId: "cap_extension",
      name: "custom",
      capabilities: ["vendor.custom"],
    }),
  ).rejects.toThrow(/standard Service Graph capability/);

  const extensionService = new ServiceGraphService({
    stores,
    allowExtensionCapabilities: true,
  });
  const serviceExport = await extensionService.recordExport({
    workspaceId: "ws_1",
    producerCapsuleId: "cap_extension",
    name: "custom",
    capabilities: ["vendor.custom"],
  });
  expect(serviceExport.capabilities).toEqual(["vendor.custom"]);
});

function seededBoundServiceGraph(): ServiceGraphService {
  const stores = {
    exports: new InMemoryServiceExportStore(
      new Map([
        [
          "sexp_mcp",
          {
            id: "sexp_mcp",
            workspaceId: "ws_1",
            producerCapsuleId: "cap_tools",
            outputId: "out_1",
            outputGeneration: 1,
            name: "tools",
            capabilities: ["protocol.mcp.server"],
            visibility: "space",
            status: "ready",
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z",
          },
        ],
      ]),
    ),
    bindings: new InMemoryServiceBindingStore(
      new Map([
        [
          "sbind_agent",
          {
            id: "sbind_agent",
            workspaceId: "ws_1",
            consumerCapsuleId: "cap_agent",
            target: { kind: "workload", name: "agent-runtime" },
            selector: { capabilities: ["protocol.mcp.server"] },
            selectedServiceExportId: "sexp_mcp",
            dependencyMode: "variable_injection",
            grantRequest: {
              scopes: ["mcp.invoke"],
              audience: ["cap_agent"],
              env: ["MCP_BASE_URL", "MCP_TOKEN"],
              ttlSeconds: 300,
            },
            status: "bound",
            createdAt: "2026-06-14T00:00:01.000Z",
            updatedAt: "2026-06-14T00:00:01.000Z",
          },
        ],
      ]),
    ),
    grants: new InMemoryServiceGraphGrantStore(),
  };
  return new ServiceGraphService({
    stores,
    clock: () => "2026-06-14T01:00:00.000Z",
  });
}
