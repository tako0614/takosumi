import { test, expect } from "bun:test";
import {
  assertValidServiceBinding,
  assertValidServiceExport,
  isServiceGraphCapability,
  isStandardServiceGraphCapability,
  SERVICE_BINDING_STATUSES,
  SERVICE_EXPORT_VISIBILITIES,
  SERVICE_GRAPH_CAPABILITIES,
} from "../../contract/service-graph.ts";

test("Service Graph capability helpers accept product-neutral dotted ids", () => {
  expect(isStandardServiceGraphCapability("protocol.mcp.server")).toBe(true);
  expect(SERVICE_GRAPH_CAPABILITIES).toContain("automation.agent_runtime");
  expect(isServiceGraphCapability("storage.object")).toBe(true);
  expect(isServiceGraphCapability("mcp-server@v1")).toBe(false);
  expect(isServiceGraphCapability("custom.search.rank")).toBe(true);
});

test("Service Graph record contract matches the v1 spec vocabulary", () => {
  expect(SERVICE_EXPORT_VISIBILITIES).toEqual([
    "private",
    "space",
    "public",
    "shared",
  ]);
  expect(SERVICE_EXPORT_VISIBILITIES).not.toContain("internal");
  expect(SERVICE_BINDING_STATUSES).toEqual([
    "pending",
    "bound",
    "blocked",
    "stale",
    "revoked",
  ]);
  expect(SERVICE_BINDING_STATUSES).not.toContain("requested");
  expect(SERVICE_BINDING_STATUSES).not.toContain("disabled");

  expect(() =>
    assertValidServiceExport({
      id: "sexp_tools",
      workspaceId: "ws_1",
      producerCapsuleId: "cap_tools",
      name: "tools",
      capabilities: ["protocol.mcp.server"],
      visibility: "space",
      status: "ready",
      auth: [{ scheme: "bearer", scopes: ["mcp.invoke"] }],
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
    }),
  ).not.toThrow();

  expect(() =>
    assertValidServiceBinding({
      id: "sbind_agent",
      workspaceId: "ws_1",
      consumerCapsuleId: "cap_agent",
      target: { kind: "workload", name: "agent-runtime" },
      selector: { capabilities: ["protocol.mcp.server"] },
      dependencyMode: "variable_injection",
      grantRequest: {
        scopes: ["mcp.invoke"],
        audience: ["cap_agent"],
        env: ["MCP_BASE_URL", "MCP_TOKEN"],
      },
      status: "pending",
      createdAt: "2026-06-14T00:00:01.000Z",
      updatedAt: "2026-06-14T00:00:01.000Z",
    }),
  ).not.toThrow();
});
