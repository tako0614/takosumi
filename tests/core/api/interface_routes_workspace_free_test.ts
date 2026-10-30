/**
 * Interface discovery, bindings and token issuance without a Workspace
 * (TASK-0118 9.1). An app-bound runtime principal is authorized by its exact
 * current Principal Bindings, accepted only as evidence of its own app (a
 * Binding on an Interface the app owns, or one materialized from its own
 * active link); it never takes a Workspace as scope. An account actor without
 * a Workspace is decided per app for Capsule-owned Interfaces.
 */
import { expect, test } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import type { Capsule } from "takosumi-contract/install-configs";
import { createApiApp } from "../../../core/api/app.ts";
import {
  bindingServesRuntimeConsumer,
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
  const boundA = await service.create(mcpInterface("ns_a", "bound-a", "cap_a"), undefined, undefined, undefined, "operator");
  // ns_b belongs to another owner who learned app cap_a's pairwise subject
  // (an introspection `sub`) and bound it manually to their own Interface.
  const boundB = await service.create(mcpInterface("ns_b", "bound-b", "cap_b"), undefined, undefined, undefined, "operator");
  const unbound = await service.create(mcpInterface("ns_a", "unbound", "cap_a"), undefined, undefined, undefined, "operator");
  const otherApp = await service.create(mcpInterface("ns_a", "other-app", "cap_a2"), undefined, undefined, undefined, "operator");
  const workspaceOwned = await service.create(mcpInterface("ns_a", "workspace-owned"), undefined, undefined, undefined, "operator");
  // A co-tenant of the shared legacy partition ns_a (app cap_a2's owner, and
  // a Workspace-owned Interface) also bound app cap_a's subject manually.
  for (const iface of [boundA, boundB, otherApp, workspaceOwned]) {
    await service.createBinding(iface.metadata.id, {
      subjectRef: { kind: "Principal", id: RUNTIME_APP },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    }, undefined, undefined, undefined, "operator");
  }
  await service.createBinding(unbound.metadata.id, {
    subjectRef: { kind: "Principal", id: "pairwise_someone_else" },
    permissions: ["mcp.invoke"],
    delivery: { type: "none" },
  }, undefined, undefined, undefined, "operator");
  const actors: Record<string, ActorContext> = {
    "runtime-app": { actorAccountId: RUNTIME_APP, roles: ["runtime-principal"], requestId: "r1", principalKind: "account", capsuleId: "cap_a" },
    "runtime-b": { actorAccountId: RUNTIME_APP, roles: ["runtime-principal"], requestId: "r4", principalKind: "account", capsuleId: "cap_b" },
    "runtime-noapp": { actorAccountId: RUNTIME_APP, roles: ["runtime-principal"], requestId: "r5", principalKind: "account" },
    "runtime-missing": { actorAccountId: RUNTIME_APP, roles: ["runtime-principal"], requestId: "r6", principalKind: "account", capsuleId: "cap_missing" },
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

test("an app-bound runtime principal discovers only evidence of its own app", async () => {
  const h = await fixture();
  const listed = await h.call("runtime-app", "/api/v1/interfaces?type=mcp.server&permission=mcp.invoke");
  expect(listed.status).toBe(200);
  // The manual Binding another partition's owner created for this subject
  // is not evidence for app cap_a.
  expect(h.ids(listed.body)).toEqual([h.boundA.metadata.id]);
  const narrowed = await h.call("runtime-app", "/api/v1/interfaces?permission=mcp.invoke&capsuleId=cap_b");
  expect(h.ids(narrowed.body)).toEqual([]);
  // The same subject presented by app cap_b's own token is its own partition.
  expect(h.ids((await h.call("runtime-b", "/api/v1/interfaces?permission=mcp.invoke")).body)).toEqual([h.boundB.metadata.id]);
  // The permission is still required for runtime discovery.
  expect((await h.call("runtime-app", "/api/v1/interfaces?type=mcp.server")).status).toBe(400);
  // A Workspace-free runtime principal without an app has no authority.
  expect((await h.call("runtime-noapp", "/api/v1/interfaces?permission=mcp.invoke")).status).toBe(403);
  expect((await h.call("runtime-noapp", `/api/v1/interfaces/${h.boundA.metadata.id}?permission=mcp.invoke`)).status).toBe(403);
});

test("a manual Binding for the app's subject on an Interface it does not own yields no read, bindings or token", async () => {
  const h = await fixture();
  // Another partition's owner, and a co-tenant of the app's own partition.
  for (const iface of [h.boundB, h.otherApp, h.workspaceOwned]) {
    expect((await h.call("runtime-app", `/api/v1/interfaces/${iface.metadata.id}?permission=mcp.invoke`)).status).toBe(404);
    expect((await h.call("runtime-app", `/api/v1/interfaces/${iface.metadata.id}/bindings?permission=mcp.invoke`)).status).toBe(404);
    const bindingId = (await h.service.listBindings(iface.metadata.id))[0]!.metadata.id;
    expect((await h.call("runtime-app", `/api/v1/interfaces/${iface.metadata.id}/bindings/${bindingId}?permission=mcp.invoke`)).status).toBe(404);
    const token = await h.call("runtime-app", `/api/v1/interfaces/${iface.metadata.id}/token`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "mcp.invoke" }),
    });
    expect(token.status).toBe(404);
  }
  expect(h.issued).toEqual([]);
});

test("an app-bound runtime principal cannot widen discovery with workspaceId or capsuleId", async () => {
  const h = await fixture();
  // Review repro: an explicit workspaceId used to skip the evidence rule.
  for (const workspaceId of ["ns_b", "ns_a"]) {
    const listed = await h.call("runtime-app", `/api/v1/interfaces?permission=mcp.invoke&workspaceId=${workspaceId}`);
    expect(listed.status).toBe(400);
    expect(h.ids(listed.body)).toEqual([]);
  }
  // capsuleId only narrows the same restricted discovery.
  for (const capsuleId of ["cap_a2", "cap_b"]) {
    const narrowed = await h.call("runtime-app", `/api/v1/interfaces?permission=mcp.invoke&capsuleId=${capsuleId}`);
    expect(narrowed.status).toBe(200);
    expect(h.ids(narrowed.body)).toEqual([]);
  }
  expect(h.ids((await h.call("runtime-app", "/api/v1/interfaces?permission=mcp.invoke&capsuleId=cap_a")).body))
    .toEqual([h.boundA.metadata.id]);
  expect((await h.call("runtime-app", "/api/v1/interfaces?permission=mcp.invoke&workspaceId=ns_a&capsuleId=cap_a")).status).toBe(400);
  // A token of an app that does not exist is not found.
  expect((await h.call("runtime-missing", "/api/v1/interfaces?permission=mcp.invoke")).status).toBe(404);
});

test("Workspace-free discovery pages with limit, cursor and nextCursor", async () => {
  const h = await fixture();
  const more = [];
  for (const name of ["bound-a-2", "bound-a-3"]) {
    const iface = await h.service.create(mcpInterface("ns_a", name, "cap_a"), undefined, undefined, undefined, "operator");
    await h.service.createBinding(iface.metadata.id, {
      subjectRef: { kind: "Principal", id: RUNTIME_APP }, permissions: ["mcp.invoke"], delivery: { type: "oauth2" },
    }, undefined, undefined, undefined, "operator");
    more.push(iface.metadata.id);
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const listed = await h.call("runtime-app", `/api/v1/interfaces?permission=mcp.invoke&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    expect(listed.status).toBe(200);
    expect((listed.body.interfaces as unknown[]).length).toBeLessThanOrEqual(1);
    seen.push(...h.ids(listed.body));
    cursor = listed.body.nextCursor as string | undefined;
    if (!cursor) break;
  }
  expect(seen.sort()).toEqual([h.boundA.metadata.id, ...more].sort());
  expect((await h.call("runtime-app", "/api/v1/interfaces?permission=mcp.invoke&cursor=not-a-cursor")).status).toBe(400);
  expect((await h.call("runtime-app", "/api/v1/interfaces?permission=mcp.invoke&limit=0")).status).toBe(400);
});

test("evidence is a Binding from the app's own link, or the app's own records on an Interface it owns", () => {
  const ownedByB = { metadata: { workspaceId: "ns_b", ownerRef: { kind: "Capsule", id: "cap_b" }, createdUnder: "app" } } as never;
  const workspaceOwned = { metadata: { workspaceId: "ns_a", ownerRef: { kind: "Workspace", id: "ns_a" } } } as never;
  const linked = { metadata: { workspaceId: "ns_b", materializedFrom: {
    source: "capsule_required_interface", capsuleId: "cap_a", requirementKey: "mcp",
    interfaceType: "mcp.server", interfaceVersion: "2025-11-25", linkId: "link_1",
  } } } as never;
  const otherConsumer = { metadata: { workspaceId: "ns_b", materializedFrom: {
    source: "capsule_required_interface", capsuleId: "cap_b", requirementKey: "mcp",
    interfaceType: "mcp.server", interfaceVersion: "2025-11-25", linkId: "link_2",
  } } } as never;
  const manual = { metadata: { workspaceId: "ns_b", createdUnder: "app" } } as never;
  const manualInOwnPartition = { metadata: { workspaceId: "ns_a", createdUnder: "app" } } as never;
  const consumer = { capsuleId: "cap_a" };
  expect(bindingServesRuntimeConsumer(linked, ownedByB, consumer)).toBe(true);
  expect(bindingServesRuntimeConsumer(otherConsumer, ownedByB, consumer)).toBe(false);
  expect(bindingServesRuntimeConsumer(manual, ownedByB, consumer)).toBe(false);
  // The partition the app records into is not evidence by itself.
  expect(bindingServesRuntimeConsumer(manualInOwnPartition, workspaceOwned, consumer)).toBe(false);
  expect(bindingServesRuntimeConsumer(manual, ownedByB, { capsuleId: "cap_b" })).toBe(true);
  // Only the app's own records count on an Interface it owns: written under
  // Workspace authority, or unrecorded and not materialized, they wait for
  // the owner's review (on either the Interface or the Binding).
  const ownedByBUnderWorkspace = { metadata: { workspaceId: "ns_b", ownerRef: { kind: "Capsule", id: "cap_b" }, createdUnder: "workspace" } } as never;
  const ownedByBUnrecorded = { metadata: { workspaceId: "ns_b", ownerRef: { kind: "Capsule", id: "cap_b" } } } as never;
  const ownedByBMaterialized = { metadata: { workspaceId: "ns_b", ownerRef: { kind: "Capsule", id: "cap_b" }, materializedFrom: { source: "capsule_blueprint", key: "mcp" } } } as never;
  const manualUnderWorkspace = { metadata: { workspaceId: "ns_b", createdUnder: "workspace" } } as never;
  const unrecorded = { metadata: { workspaceId: "ns_b" } } as never;
  const operator = { metadata: { workspaceId: "ns_b", createdUnder: "operator" } } as never;
  const appB = { capsuleId: "cap_b" };
  expect(bindingServesRuntimeConsumer(manual, ownedByBUnderWorkspace, appB)).toBe(false);
  expect(bindingServesRuntimeConsumer(manual, ownedByBUnrecorded, appB)).toBe(false);
  expect(bindingServesRuntimeConsumer(manualUnderWorkspace, ownedByB, appB)).toBe(false);
  expect(bindingServesRuntimeConsumer(unrecorded, ownedByB, appB)).toBe(false);
  expect(bindingServesRuntimeConsumer(operator, ownedByBMaterialized, appB)).toBe(true);
});

test("an app-bound runtime principal reads, lists bindings and gets tokens only through its bindings", async () => {
  const h = await fixture();
  expect((await h.call("runtime-app", `/api/v1/interfaces/${h.boundA.metadata.id}?permission=mcp.invoke`)).status).toBe(200);
  expect((await h.call("runtime-app", `/api/v1/interfaces/${h.unbound.metadata.id}?permission=mcp.invoke`)).status).toBe(404);
  const bindings = await h.call("runtime-app", `/api/v1/interfaces/${h.boundA.metadata.id}/bindings?permission=mcp.invoke`);
  expect(bindings.status).toBe(200);
  expect((bindings.body.bindings as unknown[]).length).toBe(1);
  expect((await h.call("runtime-app", `/api/v1/interfaces/${h.unbound.metadata.id}/bindings?permission=mcp.invoke`)).status).toBe(404);
  const token = await h.call("runtime-app", `/api/v1/interfaces/${h.boundA.metadata.id}/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "mcp.invoke" }),
  });
  expect(token.status).toBe(200);
  expect(token.body.access_token).toBe("tok_issued");
  // The token is minted for the Interface's own partition and the principal.
  expect(h.issued).toEqual([expect.objectContaining({ workspaceId: "ns_a", subjectId: RUNTIME_APP })]);
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
