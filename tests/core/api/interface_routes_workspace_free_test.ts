/**
 * Interface discovery, bindings and token issuance without a Workspace
 * (TASK-0118 9.1). An app-bound runtime principal is authorized by its exact
 * current Principal Bindings across every internal partition; an account
 * actor without a Workspace is decided per app for Capsule-owned Interfaces.
 */
import { expect, test } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import type { Capsule } from "takosumi-contract/install-configs";
import { createApiApp } from "../../../core/api/app.ts";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
} from "../../../core/domains/interfaces/mod.ts";

const RUNTIME_APP = "pairwise_app_runtime";
const OWNER = "acct_owner";

function mcpInterface(workspaceId: string, name: string, capsuleId?: string) {
  return {
    workspaceId,
    name,
    ownerRef: capsuleId
      ? { kind: "Capsule" as const, id: capsuleId }
      : { kind: "Workspace" as const, id: workspaceId },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "literal" as const, value: `https://${name}.example.test/mcp` },
      },
      access: { visibility: "private" as const, resourceUriInput: "endpoint" },
    },
  };
}

async function fixture(options: {
  readonly app?: (input: { actor: ActorContext; capsuleId: string; access: "read" | "write" }) => boolean | undefined;
  readonly workspace?: (input: { actor: ActorContext; workspaceId: string }) => boolean;
} = {}) {
  let id = 0;
  const issued: Record<string, unknown>[] = [];
  const capsules = new Map<string, Pick<Capsule, "id" | "workspaceId" | "status">>([
    ["cap_a", { id: "cap_a", workspaceId: "ns_a", status: "active" }],
    ["cap_a2", { id: "cap_a2", workspaceId: "ns_a", status: "active" }],
    ["cap_b", { id: "cap_b", workspaceId: "ns_b", status: "active" }],
  ]);
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-10-30T00:00:00.000Z",
    newId: (prefix) => `${prefix}_${++id}`,
    oauth2ResourceAuthorizer: () => true,
    capsules: {
      getCapsule: async (capsuleId) => {
        const capsule = capsules.get(capsuleId);
        if (!capsule) throw Object.assign(new Error("missing"), { code: "not_found" });
        return capsule as Capsule;
      },
      getInstallConfig: async () => { throw new Error("unused"); },
    },
    credentialIssuer: {
      issuePrincipalOAuth2Token: (input) => {
        issued.push(input as unknown as Record<string, unknown>);
        return Promise.resolve({ accessToken: "tok_issued", expiresAt: "2026-10-30T00:01:00.000Z" });
      },
    },
  });
  const boundA = await service.create(mcpInterface("ns_a", "bound-a", "cap_a"));
  const boundB = await service.create(mcpInterface("ns_b", "bound-b", "cap_b"));
  const unbound = await service.create(mcpInterface("ns_a", "unbound", "cap_a"));
  const otherApp = await service.create(mcpInterface("ns_a", "other-app", "cap_a2"));
  const workspaceOwned = await service.create(mcpInterface("ns_a", "workspace-owned"));
  for (const iface of [boundA, boundB]) {
    await service.createBinding(iface.metadata.id, {
      subjectRef: { kind: "Principal", id: RUNTIME_APP },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    });
  }
  await service.createBinding(unbound.metadata.id, {
    subjectRef: { kind: "Principal", id: "pairwise_someone_else" },
    permissions: ["mcp.invoke"],
    delivery: { type: "none" },
  });
  const actors: Record<string, ActorContext> = {
    "runtime-app": { actorAccountId: RUNTIME_APP, roles: ["runtime-principal"], requestId: "r1", principalKind: "account" },
    "runtime-ws": { actorAccountId: RUNTIME_APP, roles: ["runtime-principal"], requestId: "r2", principalKind: "account", workspaceId: "ns_a" },
    account: { actorAccountId: OWNER, roles: [], requestId: "r3", principalKind: "account" },
  };
  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      authorizeInterfaceBearer: ({ token }) => actors[token],
      authorizeInterfaceWorkspace: ({ actor, workspaceId }) =>
        actor.roles.includes("runtime-principal")
          ? actor.workspaceId === workspaceId
          : options.workspace?.({ actor, workspaceId }) ?? false,
      ...(options.app ? { authorizeInterfaceApp: ({ actor, capsuleId, access }) => options.app!({ actor, capsuleId, access }) } : {}),
    },
    requestCorrelation: false,
  });
  const call = async (token: string, path: string, init: RequestInit = {}) => {
    const response = await api.request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { /* empty */ }
    return { status: response.status, body };
  };
  const ids = (body: Record<string, unknown>) =>
    ((body.interfaces as { metadata: { id: string } }[]) ?? []).map((entry) => entry.metadata.id).sort();
  return { service, call, ids, issued, boundA, boundB, unbound, otherApp, workspaceOwned };
}

test("an app-bound runtime principal discovers its bound Interfaces in every partition", async () => {
  const h = await fixture();
  const listed = await h.call("runtime-app", "/api/v1/interfaces?type=mcp.server&permission=mcp.invoke");
  expect(listed.status).toBe(200);
  expect(h.ids(listed.body)).toEqual([h.boundA.metadata.id, h.boundB.metadata.id].sort());
  // capsuleId narrows to one provider app.
  const narrowed = await h.call("runtime-app", "/api/v1/interfaces?permission=mcp.invoke&capsuleId=cap_b");
  expect(h.ids(narrowed.body)).toEqual([h.boundB.metadata.id]);
  // The permission is still required for runtime discovery.
  expect((await h.call("runtime-app", "/api/v1/interfaces?type=mcp.server")).status).toBe(400);
});

test("an app-bound runtime principal reads, lists bindings and gets tokens only through its bindings", async () => {
  const h = await fixture();
  expect((await h.call("runtime-app", `/api/v1/interfaces/${h.boundB.metadata.id}?permission=mcp.invoke`)).status).toBe(200);
  expect((await h.call("runtime-app", `/api/v1/interfaces/${h.unbound.metadata.id}?permission=mcp.invoke`)).status).toBe(404);
  const bindings = await h.call("runtime-app", `/api/v1/interfaces/${h.boundB.metadata.id}/bindings?permission=mcp.invoke`);
  expect(bindings.status).toBe(200);
  expect((bindings.body.bindings as unknown[]).length).toBe(1);
  expect((await h.call("runtime-app", `/api/v1/interfaces/${h.unbound.metadata.id}/bindings?permission=mcp.invoke`)).status).toBe(404);
  const token = await h.call("runtime-app", `/api/v1/interfaces/${h.boundB.metadata.id}/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "mcp.invoke" }),
  });
  expect(token.status).toBe(200);
  expect(token.body.access_token).toBe("tok_issued");
  // The token is minted for the Interface's own partition and the principal.
  expect(h.issued).toEqual([expect.objectContaining({ workspaceId: "ns_b", subjectId: RUNTIME_APP })]);
  expect((await h.call("runtime-app", `/api/v1/interfaces/${h.unbound.metadata.id}/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "mcp.invoke" }),
  })).status).toBe(404);
  // Runtime principals never mutate.
  expect((await h.call("runtime-app", "/api/v1/interfaces", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mcpInterface("ns_a", "x", "cap_a")),
  })).status).toBe(403);
  expect((await h.call("runtime-app", `/api/v1/interfaces/${h.boundA.metadata.id}/bindings`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subjectRef: { kind: "Principal", id: RUNTIME_APP }, permissions: ["mcp.invoke"], delivery: { type: "none" } }),
  })).status).toBe(403);
});

test("a Workspace-bound runtime principal keeps its partition fence", async () => {
  const h = await fixture();
  expect((await h.call("runtime-ws", `/api/v1/interfaces/${h.boundB.metadata.id}?permission=mcp.invoke`)).status).toBe(403);
  expect((await h.call("runtime-ws", "/api/v1/interfaces?permission=mcp.invoke&capsuleId=cap_b")).status).toBe(403);
  const own = await h.call("runtime-ws", "/api/v1/interfaces?permission=mcp.invoke&capsuleId=cap_a");
  expect(own.status).toBe(200);
  expect(h.ids(own.body)).toEqual([h.boundA.metadata.id]);
});

test("an account actor lists one app's Interfaces by the app decision", async () => {
  const decisions: string[] = [];
  const h = await fixture({
    app: ({ capsuleId, access }) => {
      decisions.push(`${capsuleId}:${access}`);
      return capsuleId === "cap_a" ? true : capsuleId === "cap_a2" ? false : undefined;
    },
    workspace: ({ workspaceId }) => workspaceId === "ns_b",
  });
  const listed = await h.call("account", "/api/v1/interfaces?capsuleId=cap_a");
  expect(listed.status).toBe(200);
  // Only that app's Interfaces, never its neighbours in the same partition.
  expect(h.ids(listed.body)).toEqual([h.boundA.metadata.id, h.unbound.metadata.id].sort());
  expect((await h.call("account", "/api/v1/interfaces?capsuleId=cap_a2")).status).toBe(403);
  // No ownership row: the Workspace decision applies.
  expect((await h.call("account", "/api/v1/interfaces?capsuleId=cap_b")).status).toBe(200);
  expect((await h.call("account", "/api/v1/interfaces?capsuleId=cap_missing")).status).toBe(404);
  expect(decisions).toEqual(["cap_a:read", "cap_a2:read", "cap_b:read"]);
  expect((await h.call("account", "/api/v1/interfaces?capsuleId=cap_a&workspaceId=ns_a")).status).toBe(400);
  expect((await h.call("account", "/api/v1/interfaces")).status).toBe(400);
  expect((await h.call("account", "/api/v1/interfaces?capsuleId=cap_a&ownerKind=Workspace")).status).toBe(400);
});

test("an account actor reads and changes a Capsule-owned Interface by the app decision", async () => {
  const h = await fixture({
    app: ({ capsuleId, access }) => capsuleId === "cap_a" ? access === "read" || access === "write" : false,
    workspace: () => true,
  });
  expect((await h.call("account", `/api/v1/interfaces/${h.boundA.metadata.id}`)).status).toBe(200);
  expect((await h.call("account", `/api/v1/interfaces/${h.boundA.metadata.id}/bindings`)).status).toBe(200);
  const created = await h.call("account", `/api/v1/interfaces/${h.boundA.metadata.id}/bindings`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subjectRef: { kind: "Principal", id: "pairwise_new" }, permissions: ["mcp.invoke"], delivery: { type: "none" } }),
  });
  expect(created.status).toBe(201);
  // The app decision refuses even though the Workspace decision would allow.
  expect((await h.call("account", `/api/v1/interfaces/${h.otherApp.metadata.id}`)).status).toBe(403);
  // Workspace-owned Interfaces keep the Workspace decision.
  expect((await h.call("account", `/api/v1/interfaces/${h.workspaceOwned.metadata.id}`)).status).toBe(200);
});
