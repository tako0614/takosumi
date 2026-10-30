/**
 * Writes to Capsule-owned Interfaces are decided per app (TASK-0118 9.1), in
 * the in-memory, Postgres (PGlite) and SQLite-D1 Interface stores alike.
 *
 * In a shared legacy partition, Workspace membership used to be enough to
 * create an Interface owned by another person's app, repoint it, retire it,
 * or bind that app's (learned) subject to it, which a Workspace-free runtime
 * token of the app would then accept as evidence. Now every write to a
 * Capsule-owned Interface needs the app's owner or member, even with a
 * Workspace-bound credential; Workspace-owned Interfaces, service principals
 * and apps without an ownership row keep the Workspace decision.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import { createApiApp } from "../../../core/api/app.ts";
import {
  createD1InterfaceStores,
  createInMemoryInterfaceStores,
  createSqlInterfaceStores,
  InterfaceService,
  type InterfaceStores,
} from "../../../core/domains/interfaces/mod.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../helpers/deploy-control/pglite_sql_client.ts";

setDefaultTimeout(60_000);

const OWNER_A = "tsub_owner_a";
const COTENANT_B = "tsub_cotenant_b";
const RUNTIME_A = "pairwise_app_a";
/** App ownership rows: cap_legacy has none yet (pre-backfill). */
const APP_OWNERS: Record<string, string> = { cap_a: OWNER_A, cap_b: COTENANT_B };

async function storeSets(): Promise<{ readonly sets: readonly [string, InterfaceStores][]; readonly close: () => Promise<void> }> {
  const pg = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  return {
    sets: [
      ["memory", createInMemoryInterfaceStores()],
      ["postgres", createSqlInterfaceStores(pg)],
      ["d1", createD1InterfaceStores(d1)],
    ],
    close: () => pg.close(),
  };
}

function interfaceBody(name: string, ownerRef: { kind: "Capsule" | "Workspace"; id: string }, workspaceId = "ns_shared") {
  return {
    workspaceId,
    name,
    ownerRef,
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      inputs: { endpoint: { source: "literal", value: `https://${name}.example.test/mcp` } },
      access: { visibility: "private" },
    },
  };
}

async function harness(label: string, stores: InterfaceStores) {
  let sequence = 0;
  const service = new InterfaceService({
    stores,
    now: () => "2026-10-30T00:00:00.000Z",
    newId: (prefix) => `${prefix}_${label}_${String(++sequence).padStart(4, "0")}`,
  });
  const account = (subject: string, workspaceId?: string): ActorContext => ({
    actorAccountId: subject, roles: [], requestId: `r_${subject}`, principalKind: "account",
    ...(workspaceId ? { workspaceId } : {}),
  });
  const actors: Record<string, ActorContext> = {
    // Workspace-bound credentials of two members of the shared partition.
    "owner-ws": account(OWNER_A, "ns_shared"),
    "cotenant-ws": account(COTENANT_B, "ns_shared"),
    // The app owner's credential bound to another Workspace.
    "owner-elsewhere": account(OWNER_A, "ns_other"),
    // Account credentials without a Workspace.
    owner: account(OWNER_A),
    cotenant: account(COTENANT_B),
    "service-ws": {
      actorAccountId: "svc_probe", roles: [], requestId: "r_svc", principalKind: "service",
      serviceId: "svc_probe", workspaceId: "ns_shared",
    } as ActorContext,
    // The app owner's personal access tokens limited to apps.
    "owner-pat-b": { ...account(OWNER_A, "ns_shared"), appIds: ["cap_b"] },
    "owner-pat-a": { ...account(OWNER_A), appIds: ["cap_a"] },
    "runtime-a": {
      actorAccountId: RUNTIME_A, roles: ["runtime-principal"], requestId: "r_rt", principalKind: "account", capsuleId: "cap_a",
    },
  };
  const appDecisions: string[] = [];
  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      authorizeInterfaceBearer: ({ token }) => actors[token],
      // Both people are writing members of the shared legacy partition.
      authorizeInterfaceWorkspace: ({ actor, workspaceId }) =>
        workspaceId === "ns_shared" && (actor.workspaceId === undefined || actor.workspaceId === workspaceId),
      authorizeInterfaceApp: ({ actor, capsuleId, action }) => {
        appDecisions.push(`${actor.actorAccountId}:${capsuleId}:${action}`);
        const owner = APP_OWNERS[capsuleId];
        return owner === undefined ? undefined : owner === actor.actorAccountId;
      },
    },
    requestCorrelation: false,
  });
  const call = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await api.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text); } catch { /* empty */ }
    return { status: response.status, body: parsed, etag: response.headers.get("etag") ?? "" };
  };
  return { service, call, appDecisions };
}

test("Capsule-owned Interface writes need the app's owner or member, with parity", async () => {
  const { sets, close } = await storeSets();
  try {
    for (const [label, stores] of sets) {
      const h = await harness(label, stores);
      // A co-tenant's Workspace credential cannot create an Interface owned by
      // app cap_a, nor can their account credential without a Workspace.
      for (const token of ["cotenant-ws", "cotenant"]) {
        const made = await h.call(token, "POST", "/api/v1/interfaces", interfaceBody(`forged-${token}`, { kind: "Capsule", id: "cap_a" }));
        expect(made.status, `${label} ${token}`).toBe(403);
      }
      expect((await h.service.list({ workspaceId: "ns_shared" })).map((iface) => iface.metadata.name), label).toEqual([]);
      // The app's owner creates it, Workspace-bound or not; a credential bound
      // to another Workspace still cannot name this partition.
      const created = await h.call("owner-ws", "POST", "/api/v1/interfaces", interfaceBody("app-a", { kind: "Capsule", id: "cap_a" }));
      expect(created.status, label).toBe(201);
      const appA = created.body as { metadata: { id: string; createdUnder?: string } };
      // Written under the app's authority, recorded in every store.
      expect(appA.metadata.createdUnder, label).toBe("app");
      expect((await h.service.get(appA.metadata.id)).metadata.createdUnder, label).toBe("app");
      expect((await h.call("owner", "POST", "/api/v1/interfaces", interfaceBody("app-a-2", { kind: "Capsule", id: "cap_a" }))).status, label).toBe(201);
      expect((await h.call("owner-elsewhere", "POST", "/api/v1/interfaces", interfaceBody("app-a-3", { kind: "Capsule", id: "cap_a" }))).status, label).toBe(403);
      // The co-tenant still manages their own app and the Workspace's own
      // Interfaces through the Workspace decision.
      expect((await h.call("cotenant-ws", "POST", "/api/v1/interfaces", interfaceBody("app-b", { kind: "Capsule", id: "cap_b" }))).status, label).toBe(201);
      expect((await h.call("cotenant-ws", "POST", "/api/v1/interfaces", interfaceBody("shared", { kind: "Workspace", id: "ns_shared" }))).status, label).toBe(201);
      // An app without an ownership row keeps the Workspace decision, and
      // the record says so: it is not the app's own once the app has an owner.
      const legacy = await h.call("cotenant-ws", "POST", "/api/v1/interfaces", interfaceBody("legacy", { kind: "Capsule", id: "cap_legacy" }));
      expect(legacy.status, label).toBe(201);
      expect((legacy.body as { metadata: { createdUnder?: string } }).metadata.createdUnder, label).toBe("workspace");
      // Workspace-owned Interfaces record nothing.
      const shared = (await h.service.list({ workspaceId: "ns_shared", ownerKind: "Workspace" }))[0]!;
      expect(shared.metadata.createdUnder, label).toBeUndefined();
      // Service principals keep the Workspace decision.
      const probe = await h.call("service-ws", "POST", "/api/v1/interfaces", interfaceBody("probe", { kind: "Capsule", id: "cap_a" }));
      expect(probe.status, label).toBe(201);
      // A host service token is the operator's authority.
      expect((probe.body as { metadata: { createdUnder?: string } }).metadata.createdUnder, label).toBe("operator");
      // A PAT limited to apps reaches only those apps, and never the Workspace.
      expect((await h.call("owner-pat-b", "POST", "/api/v1/interfaces", interfaceBody("pat-b", { kind: "Capsule", id: "cap_a" }))).status, label).toBe(403);
      expect((await h.call("owner-pat-a", "POST", "/api/v1/interfaces", interfaceBody("pat-a", { kind: "Capsule", id: "cap_a" }))).status, label).toBe(201);
      expect((await h.call("owner-pat-a", "POST", "/api/v1/interfaces", interfaceBody("pat-shared", { kind: "Workspace", id: "ns_shared" }))).status, label).toBe(403);

      // Every write to app cap_a's Interface by the co-tenant is refused.
      const id = appA.metadata.id;
      const current = await h.call("owner-ws", "GET", `/api/v1/interfaces/${id}`);
      expect(current.status, label).toBe(200);
      const patch = { spec: { ...interfaceBody("app-a", { kind: "Capsule", id: "cap_a" }).spec, inputs: { endpoint: { source: "literal", value: "https://cotenant.example.test/mcp" } } } };
      const ifMatch = { "if-match": current.etag };
      expect((await h.call("cotenant-ws", "PATCH", `/api/v1/interfaces/${id}`, patch, ifMatch)).status, label).toBe(403);
      expect((await h.call("cotenant-ws", "DELETE", `/api/v1/interfaces/${id}`, undefined, ifMatch)).status, label).toBe(403);
      expect((await h.call("cotenant-ws", "POST", `/api/v1/interfaces/${id}/status`, { conditions: [] })).status, label).toBe(403);
      const forgedBinding = await h.call("cotenant-ws", "POST", `/api/v1/interfaces/${id}/bindings`, {
        subjectRef: { kind: "Principal", id: RUNTIME_A }, permissions: ["mcp.invoke"], delivery: { type: "none" },
      });
      expect(forgedBinding.status, label).toBe(403);
      expect(await h.service.listBindings(id), label).toEqual([]);
      // The owner binds; the co-tenant cannot revoke it.
      const binding = await h.call("owner-ws", "POST", `/api/v1/interfaces/${id}/bindings`, {
        subjectRef: { kind: "Principal", id: RUNTIME_A }, permissions: ["mcp.invoke"], delivery: { type: "none" },
      });
      expect(binding.status, label).toBe(201);
      expect((binding.body as { metadata: { createdUnder?: string } }).metadata.createdUnder, label).toBe("app");
      const bindingId = (binding.body as { metadata: { id: string } }).metadata.id;
      expect((await h.call("cotenant-ws", "DELETE", `/api/v1/interfaces/${id}/bindings/${bindingId}`)).status, label).toBe(403);
      expect((await h.service.listBindings(id)).map((entry) => entry.metadata.id), label).toEqual([bindingId]);
      // The co-tenant's Workspace credential still reads it (reads with a
      // Workspace keep the Workspace decision), and the owner still changes it.
      expect((await h.call("cotenant-ws", "GET", `/api/v1/interfaces/${id}`)).status, label).toBe(200);
      const owned = await h.call("owner-ws", "GET", `/api/v1/interfaces/${id}`);
      expect((await h.call("owner-ws", "PATCH", `/api/v1/interfaces/${id}`, patch, { "if-match": owned.etag })).status, label).toBe(200);
      const afterPatch = await h.call("owner", "GET", `/api/v1/interfaces/${id}`);
      expect((await h.call("owner", "DELETE", `/api/v1/interfaces/${id}`, undefined, { "if-match": afterPatch.etag })).status, label).toBe(200);
      // Writes asked the app for the action they need; Workspace-bound reads
      // did not ask. Binding create and revoke are link changes.
      const cotenantAsked = h.appDecisions.filter((entry) => entry.startsWith(`${COTENANT_B}:cap_a:`));
      expect(cotenantAsked.includes(`${COTENANT_B}:cap_a:view`), label).toBe(false);
      expect(cotenantAsked.filter((entry) => entry.endsWith(":change_interface_link")).length, label).toBe(2);
      expect(cotenantAsked.filter((entry) => entry.endsWith(":change_settings")).length, label).toBe(5);
    }
  } finally {
    await close();
  }
});
