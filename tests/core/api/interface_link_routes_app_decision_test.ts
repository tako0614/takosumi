/**
 * Core's Interface link routes give an account caller provider approval only
 * through the host's per-app decision (TASK-0118 9.1). A host without
 * `authorizeInterfaceApp` fails closed: the link waits as `pending_approval`
 * instead of falling back to the same-Workspace approval policy.
 */
import { expect, test } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuControllerError } from "../../../core/domains/deploy-control/errors.ts";
import { createInMemoryInterfaceStores, InterfaceService } from "../../../core/domains/interfaces/mod.ts";
import type { RegisterInterfaceRoutesOptions } from "../../../core/api/interface_routes.ts";

const requirement = { key: "tools", interface: { type: "mcp.server", version: "1" }, permissions: ["mcp.read"], delivery: { type: "none" } } as const;

async function harness(authorizeInterfaceApp?: RegisterInterfaceRoutesOptions["authorizeInterfaceApp"]) {
  const capsules = new Map(["consumer", "provider"].map((id) => [id, { id, workspaceId: "ws", name: id, installConfigId: "config", status: "active" } as Capsule]));
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-10-30T00:00:00.000Z",
    capsules: {
      getCapsule: async (id) => {
        const capsule = capsules.get(id);
        if (!capsule) throw new OpenTofuControllerError("not_found", "Capsule not found");
        return capsule;
      },
      getInstallConfig: async () => ({ requiredInterfaces: [requirement] }) as unknown as InstallConfig,
    },
  });
  const provider = await service.create({
    workspaceId: "ws", name: "provider", ownerRef: { kind: "Capsule", id: "provider" },
    spec: { type: "mcp.server", version: "1", document: {}, inputs: { endpoint: { source: "literal", value: "https://provider.example.test/mcp" } }, access: { visibility: "workspace" } },
  }, undefined, undefined, undefined, "operator");
  const actors: Record<string, ActorContext> = {
    member: { actorAccountId: "tsub_member", roles: [], requestId: "r1", principalKind: "account", workspaceId: "ws" },
    service: { actorAccountId: "svc", roles: [], requestId: "r2", principalKind: "service", serviceId: "svc", workspaceId: "ws" },
  };
  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      authorizeInterfaceBearer: ({ token }) => actors[token],
      // Both callers may manage the shared partition.
      authorizeInterfaceWorkspace: ({ workspaceId }) => workspaceId === "ws",
      ...(authorizeInterfaceApp ? { authorizeInterfaceApp } : {}),
    },
    requestCorrelation: false,
  });
  const put = async (token: string) => {
    const response = await api.request("/api/v1/capsules/consumer/interface-links/tools", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ interfaceId: provider.metadata.id, expectedGeneration: 0 }),
    });
    return { status: response.status, body: await response.json() as { link?: { state: string; approvedPermissions: string[] } } };
  };
  return { put };
}

test("without a host app decision, an account caller's link waits for the provider", async () => {
  const h = await harness();
  const linked = await h.put("member");
  expect(linked.status).toBe(200);
  expect(linked.body.link).toMatchObject({ state: "pending_approval", approvedPermissions: [] });
});

test("a service principal keeps the approval policy", async () => {
  const h = await harness();
  const linked = await h.put("service");
  expect(linked.status).toBe(200);
  expect(linked.body.link?.state).toBe("active");
});

test("with a host app decision, provider approval follows it", async () => {
  // The caller may change links on both apps.
  const both = await harness(() => true);
  expect((await both.put("member")).body.link?.state).toBe("active");
  // Consumer only: the provider app must approve.
  const consumerOnly = await harness(({ capsuleId }) => capsuleId === "consumer");
  expect((await consumerOnly.put("member")).body.link?.state).toBe("pending_approval");
  // No ownership rows: the Workspace decision applies to both apps.
  const legacy = await harness(() => undefined);
  expect((await legacy.put("member")).body.link?.state).toBe("active");
});
