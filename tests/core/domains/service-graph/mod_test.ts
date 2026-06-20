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
