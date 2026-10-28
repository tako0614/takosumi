import { expect, test } from "bun:test";
import { applyLegacyInterfaceLinkBackfill, planLegacyInterfaceLinkBackfill } from "../../scripts/backfill-interface-links.ts";

test("legacy link backfill dry-run reads old grants and apply uses a guarded PUT", async () => {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const fetcher = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    expect(init?.redirect).toBe("error");
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    requests.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (path === "/api/v1/interfaces") return Response.json({ interfaces: [{ metadata: { id: "iface", workspaceId: "ws", ownerRef: { kind: "Capsule", id: "provider" } }, spec: { type: "mcp.server", version: "1" } }] });
    if (path === "/api/v1/interfaces/iface/bindings") return Response.json({ bindings: [{ metadata: { id: "old_binding", workspaceId: "ws", materializedFrom: { source: "capsule_required_interface", capsuleId: "consumer", requirementKey: "tools", interfaceType: "mcp.server", interfaceVersion: "1" } }, spec: { interfaceId: "iface", subjectRef: { kind: "Principal", id: "subject" } }, status: { phase: "Ready" } }] });
    if (path.endsWith("/candidates")) return Response.json({ generation: 0, candidates: [{ interfaceId: "iface" }] });
    if (method === "PUT") return Response.json({ link: { id: "link", state: "active", providerInterfaceId: "iface", consumerCapsuleId: "consumer", requirementKey: "tools" } });
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const options = { baseUrl: "https://control.example.test", workspaceIds: ["ws"], token: "test-token", fetcher: fetcher as typeof fetch };
  const plan = await planLegacyInterfaceLinkBackfill(options);
  expect(plan).toEqual([{ workspaceId: "ws", consumerCapsuleId: "consumer", requirementKey: "tools", providerInterfaceId: "iface", bindingIds: ["old_binding"] }]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect((await applyLegacyInterfaceLinkBackfill(options, plan)).map((link) => link.id)).toEqual(["link"]);
  expect(requests.at(-1)).toEqual({ method: "PUT", path: "/api/v1/capsules/consumer/interface-links/tools", body: { interfaceId: "iface", expectedGeneration: 0 } });
});

test("backfill refuses embedded credentials or path before sending its bearer", async () => {
  let called = false;
  const fetcher = async (): Promise<Response> => { called = true; throw new Error("must not send"); };
  for (const baseUrl of ["https://user:password@control.example.test/", "https://control.example.test/redirect", "https://control.example.test/?next=other", "http://control.example.test/"]) {
    await expect(planLegacyInterfaceLinkBackfill({ baseUrl, workspaceIds: ["ws"], token: "secret", fetcher: fetcher as typeof fetch })).rejects.toThrow();
  }
  expect(called).toBe(false);
});

test("legacy link backfill refuses a previously selected lineage", async () => {
  const fetcher = async (url: URL | RequestInfo): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/interfaces") return Response.json({ interfaces: [{ metadata: { id: "iface", workspaceId: "ws", ownerRef: { kind: "Capsule", id: "provider" } }, spec: { type: "mcp.server", version: "1" } }] });
    if (path === "/api/v1/interfaces/iface/bindings") return Response.json({ bindings: [{ metadata: { id: "old_binding", workspaceId: "ws", materializedFrom: { source: "capsule_required_interface", capsuleId: "consumer", requirementKey: "tools", interfaceType: "mcp.server", interfaceVersion: "1" } }, spec: { interfaceId: "iface", subjectRef: { kind: "Principal", id: "subject" } }, status: { phase: "Ready" } }] });
    return Response.json({ generation: 3, candidates: [{ interfaceId: "iface" }] });
  };
  await expect(planLegacyInterfaceLinkBackfill({ baseUrl: "https://control.example.test", workspaceIds: ["ws"], token: "test-token", fetcher: fetcher as typeof fetch })).rejects.toThrow("manual review");
});
