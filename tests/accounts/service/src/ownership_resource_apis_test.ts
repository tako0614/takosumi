import { expect, test } from "bun:test";
import { handleConnections, completeConnectionOAuth } from "../../../../accounts/service/src/control/connections.ts";
import { handleInstallPlans } from "../../../../accounts/service/src/control/install-plans.ts";
import { personalResourceNamespace } from "../../../../accounts/service/src/control/personal-resources.ts";
import { handleSourceRefResolutions } from "../../../../accounts/service/src/control/source-ref-resolutions.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const store = new InMemoryAccountsStore();
function context(path: string, operations: ControlPlaneOperations, subject = "member", method = "GET", body?: unknown): ControlDispatchContext {
  const request = new Request(`https://app.example.test/api/v1/${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { request, url: new URL(request.url), operations, store, session: { subject } };
}

test("member sees only current app owner's bindable Connection labels", async () => {
  const personal = (id: string, owner: string, status = "verified") => ({ id, ownerAccountId: owner, scope: "personal", status, provider: "registry.example/cloud", displayName: `Label ${id}`, credentialRecipe: { id: "recipe", authMode: "token", secretPartition: "secret", envNames: ["SECRET"] }, envNames: ["SECRET"], scopeHints: { accountId: "private" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  const operations = {
    appAccess: { resolveAppAccess: async (_subject: string, capsuleId: string) => capsuleId === "cap_ok" ? { capsuleId, role: "member", ownerAccountId: "owner", ownershipEpoch: 4 } : undefined },
    accountResources: { listConnections: async (owner: string) => ({ items: [personal("conn_good", owner), { ...personal("conn_legacy", owner), scope: "workspace", workspaceId: "ws_legacy" }, personal("conn_other", "other"), personal("conn_revoked", owner, "revoked")], nextCursor: undefined }) },
    listOperatorConnections: async () => ({ connections: [] }),
    connections: { listReleaseOwnedProviderConnections: async () => [] },
  } as unknown as ControlPlaneOperations;
  const response = await handleConnections(context("connections?capsuleId=cap_ok&projection=labels", operations), ["connections"], "GET");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ connections: [
    { id: "conn_good", provider: "registry.example/cloud", displayName: "Label conn_good" },
    { id: "conn_legacy", provider: "registry.example/cloud", displayName: "Label conn_legacy" },
  ] });
  expect((await handleConnections(context("connections?capsuleId=cap_other&projection=labels", operations), ["connections"], "GET"))?.status).toBe(403);
});

test("Connection labels fail closed if app ownership changes during the read", async () => {
  let reads = 0;
  const operations = {
    appAccess: { resolveAppAccess: async () => ({ capsuleId: "cap_ok", role: "member", ownerAccountId: ++reads === 1 ? "old_owner" : "new_owner", ownershipEpoch: reads }) },
    accountResources: { listConnections: async () => ({ items: [], nextCursor: undefined }) },
    listOperatorConnections: async () => ({ connections: [] }),
    connections: { listReleaseOwnedProviderConnections: async () => [] },
  } as unknown as ControlPlaneOperations;
  const response = await handleConnections(context("connections?capsuleId=cap_ok&projection=labels", operations), ["connections"], "GET");
  expect(response?.status).toBe(403);
  expect(reads).toBe(2);
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

test("workspace-less install cannot create a hidden personal Workspace during freeze", async () => {
  let creates = 0;
  const operations = { workspaces: { listWorkspacesByOwner: async () => [], ensurePersonalWorkspace: async () => { creates++; return {}; } } } as unknown as ControlPlaneOperations;
  const ctx = context("install-plans", operations, "owner", "POST", { mode: "attempt" });
  expect((await handleInstallPlans({ ...ctx, workspaceMutationsFrozen: true }, ["install-plans"], "POST"))?.status).toBe(409);
  expect(creates).toBe(0);
});

test("frozen namespace lookup still reuses an existing owner-owned personal Workspace", async () => {
  let creates = 0;
  const existing = { id: "ws_existing", type: "personal", ownerUserId: "owner", createdAt: "2026-01-01" };
  const operations = { workspaces: { listWorkspacesByOwner: async () => [existing], ensurePersonalWorkspace: async () => { creates++; return {}; } } } as unknown as ControlPlaneOperations;
  expect(await personalResourceNamespace(operations, store, { subject: "owner" }, false)).toEqual(existing);
  expect(creates).toBe(0);
});
