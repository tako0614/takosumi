import { expect, test } from "bun:test";
import { handleConnections, completeConnectionOAuth } from "../../../../accounts/service/src/control/connections.ts";
import { handleInstallPlans } from "../../../../accounts/service/src/control/install-plans.ts";
import { personalResourceNamespace } from "../../../../accounts/service/src/control/personal-resources.ts";
import { handleSourceRefResolutions } from "../../../../accounts/service/src/control/source-ref-resolutions.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import type { ProviderConnection } from "takosumi-contract/connections";

const store = new InMemoryAccountsStore();
function context(path: string, operations: ControlPlaneOperations, subject = "member", method = "GET", body?: unknown): ControlDispatchContext {
  const request = new Request(`https://app.example.test/api/v1/${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { request, url: new URL(request.url), operations, store, session: { subject } };
}

function labelConnection(id: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return { id, ownerAccountId: "owner", scope: "personal", status: "verified", provider: "registry.example/cloud", providerSource: "registry.example/cloud", materialization: "provider", displayName: `Label ${id}`, credentialRecipe: { id: "recipe", authMode: "token", secretPartition: "secret", envNames: ["SECRET"] }, envNames: ["SECRET"], scopeHints: { accountId: "private" }, createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides };
}

function connectionLabelFixture(boundIds: readonly string[], rows: readonly ProviderConnection[] = []) {
  const connectionReads: string[] = [];
  const capsule = { id: "cap_ok", workspaceId: "ws_app", environment: "production" };
  let bindingSet: unknown = { ...capsule, id: "bindings_app", capsuleId: capsule.id, bindings: boundIds.map((connectionId) => ({ provider: "registry.example/cloud", connectionId })) };
  const operations = {
    appAccess: { resolveAppAccess: async (_subject: string, capsuleId: string) => capsuleId === "cap_ok" ? { capsuleId, role: "member", ownerAccountId: "owner", ownershipEpoch: 4 } : undefined },
    capsules: { getCapsule: async () => capsule, getProviderBindingSetByCapsule: async (capsuleId: string, environment: string) => { expect([capsuleId, environment]).toEqual([capsule.id, capsule.environment]); return bindingSet; } },
    accountResources: { listConnections: async () => { throw new Error("Must not enumerate the owner's 10,001 unrelated connections"); } },
    listOperatorConnections: async () => { throw new Error("Must not enumerate unbound operator connections"); },
    connections: {
      listReleaseOwnedProviderConnections: async () => { throw new Error("Must not enumerate unbound release connections"); },
      getProviderConnection: async (id: string) => {
        connectionReads.push(id);
        const connection = rows.find((row) => row.id === id);
        if (!connection) throw new OpenTofuControllerError("not_found", "missing");
        return connection;
      },
    },
  } as unknown as ControlPlaneOperations;
  return { operations, connectionReads, setBindingSet: (value: unknown) => { bindingSet = value; } };
}

test("member reads only bound Connection labels, independently of the owner's catalog size", async () => {
  const operator = labelConnection("conn_operator", { scope: "operator", ownerAccountId: undefined, credentialRecipe: {
    id: "operator-run", authMode: "capsule-run", runIssuance: { context: "capsule-run.v1", operatorConnection: "workspace-bindable", storedMaterial: "none", audience: "extension.example.v1", scopes: ["extension:invoke"] },
  } });
  const ids = ["conn_good", "conn_legacy", "conn_other", "conn_revoked", "conn_operator", "conn_not_bindable", "conn_missing", "conn_good"];
  const { operations, connectionReads } = connectionLabelFixture(ids, [
    labelConnection("conn_good"), labelConnection("conn_legacy", { scope: "workspace", workspaceId: "ws_legacy" }),
    labelConnection("conn_other", { ownerAccountId: "other" }), labelConnection("conn_revoked", { status: "revoked" }),
    operator, labelConnection("conn_not_bindable", { scope: "operator" }), labelConnection("conn_unbound"),
  ]);
  const response = await handleConnections(context("connections?capsuleId=cap_ok&projection=labels", operations), ["connections"], "GET");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ connections: [
    { id: "conn_good", provider: "registry.example/cloud", displayName: "Label conn_good" },
    { id: "conn_legacy", provider: "registry.example/cloud", displayName: "Label conn_legacy" },
    { id: "conn_operator", provider: "registry.example/cloud", displayName: "Label conn_operator" },
  ] });
  expect(connectionReads).toEqual([...new Set(ids)]);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect((await handleConnections(context("connections?capsuleId=cap_other&projection=labels", operations), ["connections"], "GET"))?.status).toBe(403);
});

test("Connection labels fail closed if app ownership changes during the read", async () => {
  let reads = 0;
  const { operations } = connectionLabelFixture(["conn_good"], [labelConnection("conn_good")]);
  operations.appAccess!.resolveAppAccess = async () => ({ capsuleId: "cap_ok", role: "member", ownerAccountId: ++reads === 1 ? "owner" : "new_owner", ownershipEpoch: reads });
  const response = await handleConnections(context("connections?capsuleId=cap_ok&projection=labels", operations), ["connections"], "GET");
  expect(response?.status).toBe(403);
  expect(reads).toBe(2);
});

test("Connection labels read no credentials without an app binding set", async () => {
  const { operations, connectionReads, setBindingSet } = connectionLabelFixture([]);
  setBindingSet(undefined);
  const response = await handleConnections(context("connections?capsuleId=cap_ok&projection=labels", operations), ["connections"], "GET");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ connections: [] });
  expect(connectionReads).toEqual([]);
});

test("Connection label point reads retain bearer and Workspace attenuation", async () => {
  const { operations, connectionReads } = connectionLabelFixture(["conn_good"], [labelConnection("conn_good")]);
  const ctx = context("connections?capsuleId=cap_ok&projection=labels", operations);
  for (const session of [
    { subject: "member", appIds: ["cap_other"] },
    { subject: "member", workspaceId: "ws_other" },
  ]) {
    expect((await handleConnections({ ...ctx, session }, ["connections"], "GET"))?.status).toBe(403);
  }
  expect(connectionReads).toEqual([]);
  expect((await handleConnections({ ...ctx, session: { subject: "member", reauthorizeBearer: async () => false } }, ["connections"], "GET"))?.status).toBe(403);
  expect(connectionReads).toEqual(["conn_good"]);
});

test("Connection labels refuse a binding set for another app before looking up its connections", async () => {
  const { operations, connectionReads, setBindingSet } = connectionLabelFixture([]);
  setBindingSet({ id: "bindings_other", capsuleId: "cap_other", workspaceId: "ws_app", environment: "production", bindings: [{ connectionId: "conn_private" }] });
  const response = await handleConnections(context("connections?capsuleId=cap_ok&projection=labels", operations), ["connections"], "GET");
  expect(response?.status).toBe(503);
  expect(connectionReads).toEqual([]);
});

test("Connection labels reject a point lookup returning a different connection identity", async () => {
  const { operations } = connectionLabelFixture(["conn_bound"]);
  operations.connections.getProviderConnection = async () => labelConnection("conn_unbound");
  const response = await handleConnections(context("connections?capsuleId=cap_ok&projection=labels", operations), ["connections"], "GET");
  expect(response?.status).toBe(503);
});

test("Connection labels retain the exact point lookup on the legacy connection facade", async () => {
  const fixture = connectionLabelFixture(["conn_bound"]);
  const reads: string[] = [];
  const operations = { ...fixture.operations,
    connections: { ...fixture.operations.connections, getProviderConnection: undefined },
    getConnection: async (id: string) => { reads.push(id); return labelConnection(id); },
  } as unknown as ControlPlaneOperations;
  const response = await handleConnections(context("connections?capsuleId=cap_ok&projection=labels", operations), ["connections"], "GET");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ connections: [{ id: "conn_bound", provider: "registry.example/cloud", displayName: "Label conn_bound" }] });
  expect(reads).toEqual(["conn_bound"]);
});

test("personal OAuth start and callback bind the signed owner without Workspace authority", async () => {
  store.saveAccount({ subject: "owner" as never, createdAt: Date.now(), updatedAt: Date.now() });
  let started: unknown;
  let minted: unknown;
  const operations = {
    connectionOAuth: { helper: {
      start: async (input: unknown) => { started = input; return { authorizationUrl: "https://provider.test/auth", state: "signed" }; },
      complete: async () => ({ subject: "owner", request: { scope: "personal", ownerAccountId: "owner", provider: "registry.example/cloud", values: { TOKEN: "secret" } } }),
    } },
    createConnection: async (request: unknown, authority: unknown, actor: unknown) => { minted = { request, authority, actor }; return { connection: { id: "conn_personal" } }; },
    testConnection: async () => ({ status: "verified" }),
  } as unknown as ControlPlaneOperations;
  const ctx = context("connections/oauth/helper/start", operations, "owner", "POST", {});
  expect((await handleConnections(ctx, ["connections", "oauth", "helper", "start"], "POST"))?.status).toBe(200);
  expect(started).toMatchObject({ subject: "owner", scope: "personal", ownerAccountId: "owner" });
  expect((started as Record<string, unknown>).workspaceId).toBeUndefined();
  const callback = await completeConnectionOAuth(operations, store, new URL("https://app.example.test/api/v1/connections/oauth/helper/callback?state=signed&code=code"), "helper");
  expect(callback.status).toBe(303);
  expect(minted).toMatchObject({ request: { scope: "personal", ownerAccountId: "owner" }, actor: "owner" });
  expect((minted as Record<string, unknown>).authority).toBeUndefined();
});

test("workspace-less source ref GET requires account scope and delegates resolution", async () => {
  let resolved: string | undefined;
  const operations = { resolveStableSourceTag: async (url: string) => { resolved = url; return { tag: "v1.2.3" }; } } as unknown as ControlPlaneOperations;
  const ctx = context("source-ref-resolutions?url=https%3A%2F%2Fgit.example%2Fa.git", operations);
  expect(await (await handleSourceRefResolutions(ctx, ["source-ref-resolutions"], "GET"))?.json()).toEqual({ tag: "v1.2.3" });
  expect(resolved).toBe("https://git.example/a.git");
  expect((await handleSourceRefResolutions({ ...ctx, session: { subject: "member", appIds: ["cap_1"] } }, ["source-ref-resolutions"], "GET"))?.status).toBe(403);
});

test("workspace-less install uses only canonical personal bootstrap during the freeze", async () => {
  let creates = 0;
  const personal = { id: "ws_bootstrap", type: "personal", ownerUserId: "owner", createdAt: "2026-01-01" };
  const operations = { workspaces: {
    listWorkspacesByOwner: async () => [],
    ensurePersonalWorkspace: async (subject: string) => { expect(subject).toBe("owner"); creates++; return personal; },
    createWorkspace: async () => { throw new Error("General Workspace creation stays frozen"); },
  } } as unknown as ControlPlaneOperations;
  const ctx = context("install-plans", operations, "owner", "POST", { mode: "attempt" });
  const response = await handleInstallPlans({ ...ctx, workspaceMutationsFrozen: true }, ["install-plans"], "POST");
  expect(response?.status).toBe(400);
  expect(await response?.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
  expect(creates).toBe(1);
});

test("read-only namespace lookup still reuses an existing owner-owned personal Workspace", async () => {
  let creates = 0;
  const existing = { id: "ws_existing", type: "personal", ownerUserId: "owner", createdAt: "2026-01-01" };
  const operations = { workspaces: { listWorkspacesByOwner: async () => [existing], ensurePersonalWorkspace: async () => { creates++; return {}; } } } as unknown as ControlPlaneOperations;
  expect(await personalResourceNamespace(operations, store, { subject: "owner" }, false)).toEqual(existing);
  expect(creates).toBe(0);
});
