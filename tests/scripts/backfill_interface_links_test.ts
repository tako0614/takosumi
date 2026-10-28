import { expect, test } from "bun:test";
import { applyLegacyInterfaceLinkBackfill, planLegacyInterfaceLinkBackfill } from "../../scripts/backfill-interface-links.ts";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";

const grant = { permissions: ["mcp.read"], delivery: { type: "oauth2" } };
const fingerprint = await stableJsonDigest(grant);

test("legacy link backfill dry-run reads old grants and apply uses a guarded PUT", async () => {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const fetcher = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    expect(init?.redirect).toBe("error");
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    requests.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (path === "/api/v1/interfaces") return Response.json({ interfaces: [{ metadata: { id: "iface", workspaceId: "ws", ownerRef: { kind: "Capsule", id: "provider" } }, spec: { type: "mcp.server", version: "1" } }] });
    if (path === "/api/v1/interfaces/iface/bindings") return Response.json({ bindings: [{ metadata: { id: "old_binding", workspaceId: "ws", generation: 2, materializedFrom: { source: "capsule_required_interface", capsuleId: "consumer", requirementKey: "tools", interfaceType: "mcp.server", interfaceVersion: "1" } }, spec: { interfaceId: "iface", subjectRef: { kind: "Principal", id: "subject" }, ...grant }, status: { phase: "Ready" } }] });
    if (path.endsWith("/candidates")) return Response.json({ generation: 0, requirementFingerprint: fingerprint, candidates: [{ interfaceId: "iface" }] });
    if (method === "PUT") return Response.json({ link: { id: "link", state: "active", providerInterfaceId: "iface", consumerCapsuleId: "consumer", requirementKey: "tools" } });
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const options = { baseUrl: "https://control.example.test", workspaceIds: ["ws"], token: "test-token", fetcher: fetcher as typeof fetch };
  const plan = await planLegacyInterfaceLinkBackfill(options);
  expect(plan).toEqual([{ workspaceId: "ws", consumerCapsuleId: "consumer", requirementKey: "tools", providerInterfaceId: "iface", bindings: [{ id: "old_binding", generation: 2 }], grantFingerprint: fingerprint }]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect((await applyLegacyInterfaceLinkBackfill(options, plan)).map((link) => link.id)).toEqual(["link"]);
  expect(requests.at(-1)).toEqual({ method: "PUT", path: "/api/v1/capsules/consumer/interface-links/tools", body: { interfaceId: "iface", expectedGeneration: 0, expectedRequirementFingerprint: fingerprint } });
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
    if (path === "/api/v1/interfaces/iface/bindings") return Response.json({ bindings: [{ metadata: { id: "old_binding", workspaceId: "ws", generation: 2, materializedFrom: { source: "capsule_required_interface", capsuleId: "consumer", requirementKey: "tools", interfaceType: "mcp.server", interfaceVersion: "1" } }, spec: { interfaceId: "iface", subjectRef: { kind: "Principal", id: "subject" }, ...grant }, status: { phase: "Ready" } }] });
    return Response.json({ generation: 3, requirementFingerprint: fingerprint, candidates: [{ interfaceId: "iface" }] });
  };
  await expect(planLegacyInterfaceLinkBackfill({ baseUrl: "https://control.example.test", workspaceIds: ["ws"], token: "test-token", fetcher: fetcher as typeof fetch })).rejects.toThrow("manual review");
});

test("backfill refuses a narrower legacy grant than the current requirement", async () => {
  let writes = 0;
  const fetcher = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "PUT") { writes += 1; throw new Error("must not write"); }
    if (path === "/api/v1/interfaces") return Response.json({ interfaces: [{ metadata: { id: "iface", workspaceId: "ws", ownerRef: { kind: "Capsule", id: "provider" } }, spec: { type: "mcp.server", version: "1" } }] });
    if (path === "/api/v1/interfaces/iface/bindings") return Response.json({ bindings: [{ metadata: { id: "old_binding", workspaceId: "ws", generation: 2, materializedFrom: { source: "capsule_required_interface", capsuleId: "consumer", requirementKey: "tools", interfaceType: "mcp.server", interfaceVersion: "1" } }, spec: { interfaceId: "iface", subjectRef: { kind: "Principal", id: "subject" }, ...grant }, status: { phase: "Ready" } }] });
    return Response.json({ generation: 0, requirementFingerprint: await stableJsonDigest({ permissions: ["mcp.read", "mcp.write"], delivery: grant.delivery }), candidates: [{ interfaceId: "iface" }] });
  };
  await expect(planLegacyInterfaceLinkBackfill({ baseUrl: "https://control.example.test", workspaceIds: ["ws"], token: "test-token", fetcher: fetcher as typeof fetch })).rejects.toThrow("differs from the current requirement");
  expect(writes).toBe(0);
});

test("backfill rechecks Ready Binding generations before a write", async () => {
  let bindingReads = 0;
  let writes = 0;
  const fetcher = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "PUT") { writes += 1; throw new Error("must not write"); }
    if (path === "/api/v1/interfaces") return Response.json({ interfaces: [{ metadata: { id: "iface", workspaceId: "ws", ownerRef: { kind: "Capsule", id: "provider" } }, spec: { type: "mcp.server", version: "1" } }] });
    if (path === "/api/v1/interfaces/iface/bindings") {
      bindingReads += 1;
      return Response.json({ bindings: [{ metadata: { id: "old_binding", workspaceId: "ws", generation: bindingReads === 1 ? 2 : 3, materializedFrom: { source: "capsule_required_interface", capsuleId: "consumer", requirementKey: "tools", interfaceType: "mcp.server", interfaceVersion: "1" } }, spec: { interfaceId: "iface", subjectRef: { kind: "Principal", id: "subject" }, ...grant }, status: { phase: bindingReads === 1 ? "Ready" : "Revoked" } }] });
    }
    return Response.json({ generation: 0, requirementFingerprint: fingerprint, candidates: [{ interfaceId: "iface" }] });
  };
  const options = { baseUrl: "https://control.example.test", workspaceIds: ["ws"], token: "test-token", fetcher: fetcher as typeof fetch };
  const plan = await planLegacyInterfaceLinkBackfill(options);
  await expect(applyLegacyInterfaceLinkBackfill(options, plan)).rejects.toThrow("changed since review");
  expect(writes).toBe(0);
});
