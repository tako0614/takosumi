import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import { registerInterfaceRoutes } from "../../../core/api/interface_routes.ts";
import { InterfaceService, createInMemoryInterfaceStores } from "../../../core/domains/interfaces/mod.ts";
import { handleCapsuleInterfaceLinks } from "../../../accounts/service/src/control/interface-links.ts";
import type { ControlDispatchContext } from "../../../accounts/service/src/control/shared.ts";
import { stableJsonDigest } from "../../../core/adapters/source/digest.ts";

const requirement = { key: "tools", interface: { type: "mcp.server", version: "1" }, permissions: ["mcp.invoke"], delivery: { type: "none" } } as const;
async function fixture() {
  const stores = createInMemoryInterfaceStores({ workspaceManagementAuthority: { isWorkspaceManagementAdmissionAllowed: () => true } });
  const capsules = new Map(["consumer", "provider"].map((id) => [id, { id, name: `${id} app`, workspaceId: "ws", installConfigId: "config", status: "active" } as Capsule]));
  const service = new InterfaceService({ stores, capsules: { getCapsule: async (id) => capsules.get(id)!, getInstallConfig: async () => ({ requiredInterfaces: [requirement] }) as unknown as InstallConfig } });
  const provider = await service.create({ workspaceId: "ws", name: "provider-mcp", ownerRef: { kind: "Capsule", id: "provider" }, spec: { type: "mcp.server", version: "1", document: {}, access: { visibility: "workspace" } } });
  const app = new Hono();
  registerInterfaceRoutes(app, { service, authorizeInterfaceBearer: ({ token }) => ({ actorAccountId: "account", requestId: "request", workspaceId: token === "foreign" ? "other_ws" : "ws", roles: token === "runtime" ? ["runtime-principal"] : ["owner"] }) });
  const request = (path: string, method = "GET", body?: unknown, token = "manager") => app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const path = "/api/v1/capsules/consumer/interface-links/tools";
  return { stores, capsules, service, provider, request, path };
}

test("Interface link routes require control authority and enforce Workspace fences", async () => {
  const f = await fixture();
  expect((await f.request(`${f.path}/candidates`, "GET", undefined, "runtime")).status).toBe(403);
  expect((await f.request(`${f.path}/candidates`, "GET", undefined, "foreign")).status).toBe(403);
  expect((await f.request(f.path, "PUT", { interfaceId: f.provider.metadata.id, expectedGeneration: 0 }, "foreign")).status).toBe(403);
  expect(await f.service.listCapsuleInterfaceLinks("consumer")).toHaveLength(0);
});

test("Interface link routes return data-free candidates, use generation CAS and unlink", async () => {
  const f = await fixture();
  const candidates = await f.request(`${f.path}/candidates`);
  expect(candidates.status).toBe(200);
  expect(await candidates.json()).toEqual({ candidates: [{ interfaceId: f.provider.metadata.id, providerCapsuleId: "provider", providerCapsuleName: "provider app", interfaceName: "provider-mcp" }], generation: 0, requirementFingerprint: await stableJsonDigest({ permissions: requirement.permissions, delivery: requirement.delivery }) });
  expect((await f.request(f.path, "PUT", { interfaceId: f.provider.metadata.id, expectedGeneration: -1 })).status).toBe(400);
  expect((await f.request(f.path, "PUT", { interfaceId: f.provider.metadata.id, expectedGeneration: 0, expectedRequirementFingerprint: await stableJsonDigest({ permissions: ["other"], delivery: requirement.delivery }) })).status).toBe(409);
  const selected = await f.request(f.path, "PUT", { interfaceId: f.provider.metadata.id, expectedGeneration: 0 });
  expect(selected.status).toBe(200);
  // This host decides no apps, so an account caller never approves for the
  // provider: the link waits for it (TASK-0118 9.1).
  expect((await selected.json()).link.state).toBe("pending_approval");
  expect((await f.request(f.path, "PUT", { interfaceId: f.provider.metadata.id, expectedGeneration: 0 })).status).toBe(409);
  expect((await f.request(f.path, "DELETE", { expectedGeneration: 0 })).status).toBe(409);
  const unlinked = await f.request(f.path, "DELETE", { expectedGeneration: 1 });
  expect(unlinked.status).toBe(200);
  expect((await unlinked.json()).link.state).toBe("revoked");
});

test("account-session Interface link handler fences consumers and serves candidate projection", async () => {
  const f = await fixture();
  const request = new Request(`https://accounts.example.test${f.path}/candidates`);
  const ctx = { request, url: new URL(request.url), session: { subject: "owner" }, store: {}, operations: { interfaces: f.service, capsules: { getCapsule: async (id: string) => f.capsules.get(id)! }, workspaces: { getWorkspace: async (id: string) => ({ id, ownerUserId: "owner" }) } } } as unknown as ControlDispatchContext;
  expect((await handleCapsuleInterfaceLinks(ctx, f.capsules.get("consumer")!, ["capsules", "consumer", "interface-links", "tools", "candidates"], "GET")).status).toBe(200);
  const foreign = { ...ctx, session: { subject: "owner", workspaceId: "another_workspace" } } as ControlDispatchContext;
  expect((await handleCapsuleInterfaceLinks(foreign, f.capsules.get("consumer")!, ["capsules", "consumer", "interface-links", "tools", "candidates"], "GET")).status).toBe(403);
});

test("provider manager can revoke an existing cross-workspace link without gaining consumer writes", async () => {
  const f = await fixture();
  f.capsules.set("foreign_provider", { ...f.capsules.get("provider")!, id: "foreign_provider", workspaceId: "other_ws" });
  const provider = await f.service.create({ workspaceId: "other_ws", name: "foreign-provider", ownerRef: { kind: "Capsule", id: "foreign_provider" }, spec: { type: "mcp.server", version: "1", document: {}, access: { visibility: "workspace" } } });
  const record = { id: "legacy_cross_workspace", generation: 1, consumerCapsuleId: "consumer", requirementKey: "tools", interface: requirement.interface, requestedPermissions: [...requirement.permissions], approvedPermissions: [...requirement.permissions], deliveryType: "none", providerInterfaceId: provider.metadata.id, providerCapsuleId: "foreign_provider", state: "active" as const, selection: "explicit" as const, requestedBy: "original_actor", createdAt: "2026-07-13T12:00:00.000Z", updatedAt: "2026-07-13T12:00:00.000Z" };
  expect(await f.stores.links.create(record)).toBe(true);
  expect((await f.request(f.path, "PUT", { interfaceId: f.provider.metadata.id, expectedGeneration: 1 }, "foreign")).status).toBe(403);
  const response = await f.request(f.path, "DELETE", { expectedGeneration: 1 }, "foreign");
  expect(response.status).toBe(200);
  expect((await response.json()).link.state).toBe("revoked");
});

test("account-session provider manager can unlink a requirement removed from current config", async () => {
  const f = await fixture();
  const [link] = await f.service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer", requirements: [requirement], selections: [{ requirementKey: "tools", interfaceId: f.provider.metadata.id, selection: "explicit" }] });
  f.capsules.set("consumer", { ...f.capsules.get("consumer")!, workspaceId: "consumer_ws" });
  f.service.getInterfaceLinkRequirement = async () => { throw new Error("current config no longer declares this requirement"); };
  const request = new Request(`https://accounts.example.test${f.path}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedGeneration: link!.generation }) });
  const ctx = { request, url: new URL(request.url), session: { subject: "provider_owner", requiredAccess: "write" }, store: {}, operations: { interfaces: f.service, capsules: { getCapsule: async (id: string) => f.capsules.get(id)! }, workspaces: { getWorkspace: async (id: string) => ({ id, ownerUserId: id === "ws" ? "provider_owner" : "someone_else" }), captureManagementAuthority: async (id: string) => ({ workspaceId: id, managementState: "active", managementEpoch: 1 }) }, members: { listMembers: async () => [] } } } as unknown as ControlDispatchContext;
  const response = await handleCapsuleInterfaceLinks(ctx, f.capsules.get("consumer")!, ["capsules", "consumer", "interface-links", "tools"], "DELETE");
  expect(response.status).toBe(200);
  expect((await response.json()).link.state).toBe("revoked");
});

test("provider-authorized DELETE cannot revoke a newly repointed provider", async () => {
  const f = await fixture();
  f.capsules.set("foreign_provider", { ...f.capsules.get("provider")!, id: "foreign_provider", workspaceId: "other_ws" });
  const foreign = await f.service.create({ workspaceId: "other_ws", name: "foreign-provider", ownerRef: { kind: "Capsule", id: "foreign_provider" }, spec: f.provider.spec });
  const old = { id: "old_provider_link", generation: 1, consumerCapsuleId: "consumer", requirementKey: "tools", interface: requirement.interface, requestedPermissions: [...requirement.permissions], approvedPermissions: [...requirement.permissions], deliveryType: "none", providerInterfaceId: foreign.metadata.id, providerCapsuleId: "foreign_provider", state: "active" as const, selection: "explicit" as const, requestedBy: "original_actor", createdAt: "2026-07-13T12:00:00.000Z", updatedAt: "2026-07-13T12:00:00.000Z" };
  expect(await f.stores.links.create(old)).toBe(true);
  const authorized = { linkId: old.id, providerInterfaceId: old.providerInterfaceId, providerCapsuleId: old.providerCapsuleId };
  const replacement = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.provider.metadata.id, expectedGeneration: old.generation });
  await expect(f.service.revokeCapsuleInterfaceLink("consumer", "tools", replacement.generation, undefined, undefined, authorized)).rejects.toThrow("authorized Interface provider changed");
  expect((await f.stores.links.get(replacement.id))?.state).toBe("active");
});

test("provider DELETE route pins the authorized link before its service read", async () => {
  const f = await fixture();
  f.capsules.set("foreign_provider", { ...f.capsules.get("provider")!, id: "foreign_provider", workspaceId: "other_ws" });
  const foreign = await f.service.create({ workspaceId: "other_ws", name: "foreign-provider", ownerRef: { kind: "Capsule", id: "foreign_provider" }, spec: f.provider.spec });
  const old = { id: "old_route_link", generation: 1, consumerCapsuleId: "consumer", requirementKey: "tools", interface: requirement.interface, requestedPermissions: [...requirement.permissions], approvedPermissions: [...requirement.permissions], deliveryType: "none", providerInterfaceId: foreign.metadata.id, providerCapsuleId: "foreign_provider", state: "active" as const, selection: "explicit" as const, requestedBy: "original_actor", createdAt: "2026-07-13T12:00:00.000Z", updatedAt: "2026-07-13T12:00:00.000Z" };
  expect(await f.stores.links.create(old)).toBe(true);
  const original = f.service.getLatestCapsuleInterfaceLink.bind(f.service);
  let replacementId = "";
  f.service.getLatestCapsuleInterfaceLink = async (capsuleId, key) => {
    const authorized = await original(capsuleId, key);
    const replacement = await f.service.putCapsuleInterfaceLink({ capsuleId, requirementKey: key, interfaceId: f.provider.metadata.id, expectedGeneration: old.generation });
    replacementId = replacement.id;
    return authorized;
  };
  const response = await f.request(f.path, "DELETE", { expectedGeneration: 3 }, "foreign");
  expect(response.status).toBe(403);
  expect((await f.stores.links.get(replacementId))?.state).toBe("active");
});

test("account route reauthorizes a revoked bearer after binding preparation before link CAS", async () => {
  const f = await fixture();
  const [old] = await f.service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer", requirements: [requirement], selections: [{ requirementKey: "tools", interfaceId: f.provider.metadata.id, selection: "explicit" }] });
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "pairwise", requirements: [requirement] });
  f.capsules.set("provider_two", { ...f.capsules.get("provider")!, id: "provider_two" });
  const next = await f.service.create({ workspaceId: "ws", name: "provider-two", ownerRef: { kind: "Capsule", id: "provider_two" }, spec: f.provider.spec });
  let live = true;
  const create = f.stores.bindings.create.bind(f.stores.bindings);
  f.stores.bindings.create = async (record, authority) => { const result = await create(record, authority); if (record.spec.interfaceId === next.metadata.id) live = false; return result; };
  const request = new Request(`https://accounts.example.test${f.path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ interfaceId: next.metadata.id, expectedGeneration: old!.generation }) });
  const ctx = { request, url: new URL(request.url), session: { subject: "owner", requiredAccess: "write", reauthorizeBearer: async () => live }, store: {}, operations: { interfaces: f.service, capsules: { getCapsule: async (id: string) => f.capsules.get(id)! }, workspaces: { getWorkspace: async (id: string) => ({ id, ownerUserId: "owner" }), captureManagementAuthority: async (id: string) => ({ workspaceId: id, managementState: "active", managementEpoch: 1 }) } } } as unknown as ControlDispatchContext;
  const response = await handleCapsuleInterfaceLinks(ctx, f.capsules.get("consumer")!, ["capsules", "consumer", "interface-links", "tools"], "PUT");
  expect(response.status).toBe(403);
  expect((await f.stores.links.get(old!.id))?.state).toBe("active");
  expect((await f.service.listBindings(next.metadata.id))[0]!.status.phase).toBe("Revoked");
});
