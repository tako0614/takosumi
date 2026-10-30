/**
 * Platform Interface ingress without a Workspace (TASK-0118 9.1): an installed
 * app's own OAuth token acts as a runtime principal bound to its app, and an
 * account session may list one app's Interfaces after Accounts' per-app view
 * decision. Everything else still needs a Workspace.
 */
import { expect, test } from "bun:test";
import { handlePlatformInterfaceApiRequest } from "../../../deploy/platform/worker.ts";
import type { PlatformExtensionSessionContext } from "../../../deploy/platform/worker.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import { D1AppOwnershipStore } from "../../../core/domains/app-ownership/store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";

async function environment() {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await seedCapsuleModel(store, { workspaceId: "ws_platform_iface", capsuleId: "cap_platform_iface" });
  return {
    TAKOSUMI_CONTROL_DB: db,
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
  } as never;
}

const runtimeApp = async (): Promise<PlatformExtensionSessionContext> => ({
  authenticated: true,
  authKind: "oauth-access-token",
  subject: "pairwise_runtime",
  capsuleId: "cap_platform_iface",
  scopes: ["openid", "capsules:read"],
});
const runtimeUnbound = async (): Promise<PlatformExtensionSessionContext> => ({
  authenticated: true,
  authKind: "oauth-access-token",
  subject: "pairwise_runtime",
  scopes: ["openid", "capsules:read"],
});
const accountSession = async (): Promise<PlatformExtensionSessionContext> => ({
  authenticated: true,
  authKind: "session",
  subject: "tsub_account",
});
const noWorkspaceAccess = async () => false;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.takosumi.com${path}`, {
    ...init,
    headers: { authorization: "Bearer opaque", ...(init.headers ?? {}) },
  });
}

test("an app-bound OAuth token discovers and requests tokens without a Workspace", async () => {
  const env = await environment();
  const listed = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?type=mcp.server&permission=mcp.invoke"), env, runtimeApp, noWorkspaceAccess,
  );
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ interfaces: [] });
  // Token issuance reaches Core's non-enumerating missing-Interface answer.
  const token = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces/if_missing/token", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "mcp.invoke" }),
    }),
    env, runtimeApp, noWorkspaceAccess,
  );
  expect(token.status).toBe(404);
  // Runtime tokens still never mutate.
  const mutation = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    env, runtimeApp, noWorkspaceAccess,
  );
  expect(mutation.status).toBe(403);
  // The token's app reaches Core on the actor: an app Core cannot find is
  // refused there instead of being treated as Workspace-free authority.
  const missingApp = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?permission=mcp.invoke"), env,
    async () => ({ ...(await runtimeApp()), capsuleId: "cap_missing" }), noWorkspaceAccess,
  );
  expect(missingApp.status).toBe(404);
  // A Workspace never widens an app-bound token's discovery.
  const withWorkspace = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?permission=mcp.invoke&workspaceId=ws_platform_iface"), env, runtimeApp, noWorkspaceAccess,
  );
  expect([400, 403]).toContain(withWorkspace.status);
  // Discovery pages like every list read.
  const paged = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?permission=mcp.invoke&limit=1"), env, runtimeApp, noWorkspaceAccess,
  );
  expect(paged.status).toBe(200);
  expect(await paged.json()).toEqual({ interfaces: [] });
  // An OAuth token bound to neither an app nor a Workspace is refused.
  const unbound = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?permission=mcp.invoke"), env, runtimeUnbound, noWorkspaceAccess,
  );
  expect(unbound.status).toBe(400);
});

test("an account session lists one app's Interfaces after the per-app view decision", async () => {
  const env = await environment();
  const asked: string[] = [];
  const allowed = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?capsuleId=cap_platform_iface"), env, accountSession, noWorkspaceAccess, undefined,
    async (_request, _env, capsuleId) => {
      asked.push(capsuleId);
      return "ws_platform_iface";
    },
  );
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ interfaces: [] });
  expect(asked).toEqual(["cap_platform_iface"]);
  const refused = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?capsuleId=cap_platform_iface"), env, accountSession, noWorkspaceAccess, undefined,
    async () => undefined,
  );
  expect(refused.status).toBe(403);
  // A partition that is not the app's own lists nothing.
  const mismatched = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?capsuleId=cap_platform_iface"), env, accountSession, noWorkspaceAccess, undefined,
    async () => "ws_somewhere_else",
  );
  expect(mismatched.status).toBe(403);
  // Interface-addressed routes still need a Workspace for account callers.
  const byId = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces/if_any"), env, accountSession, noWorkspaceAccess, undefined,
    async () => "ws_platform_iface",
  );
  expect(byId.status).toBe(400);
  const noApp = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces"), env, accountSession, noWorkspaceAccess,
  );
  expect(noApp.status).toBe(400);
});

test("a shared-account session's app decision goes through the shared-auth control dispatch", async () => {
  const env = await environment();
  const seen: unknown[] = [];
  const response = await handlePlatformInterfaceApiRequest(
    request("/api/v1/interfaces?capsuleId=cap_platform_iface"), env,
    async () => ({ ...(await accountSession()), sharedAccount: true }), noWorkspaceAccess, undefined,
    async (_request, _env, _capsuleId, options) => {
      seen.push(options?.sharedAccount);
      return "ws_platform_iface";
    },
  );
  expect(response.status).toBe(200);
  expect(seen).toEqual([true]);
});

test("a Workspace session's write to a Capsule-owned Interface needs the app's owner or member", async () => {
  const env = await environment() as { TAKOSUMI_CONTROL_DB: SqliteFakeD1 };
  const control = new CloudflareD1OpenTofuControlStore(env.TAKOSUMI_CONTROL_DB);
  const workspaceMember = async () => "owner" as const;
  const create = (session: () => Promise<PlatformExtensionSessionContext>, name: string, ownerRef: { kind: string; id: string }) =>
    handlePlatformInterfaceApiRequest(
      request("/api/v1/interfaces", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.takosumi.com" },
        body: JSON.stringify({
          workspaceId: "ws_platform_iface", name, ownerRef,
          spec: { type: "mcp.server", version: "2025-11-25", document: {}, access: { visibility: "private" } },
        }),
      }),
      env as never, session, workspaceMember,
    );
  // Before the app has an ownership row, the Workspace decision applies.
  expect((await create(accountSession, "before-backfill", { kind: "Capsule", id: "cap_platform_iface" })).status).toBe(201);
  // Once another account owns the app, a Workspace member cannot create its
  // Interfaces; the app's owner can, and Workspace-owned ones are unchanged.
  expect(await new D1AppOwnershipStore(env.TAKOSUMI_CONTROL_DB as never, control).initializeOwnershipIfMissing({
    capsuleId: "cap_platform_iface", ownerAccountId: "tsub_app_owner", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: "apps/cap_platform_iface",
  })).toBe(true);
  const refused = await create(accountSession, "cotenant-made", { kind: "Capsule", id: "cap_platform_iface" });
  expect(refused.status).toBe(403);
  const appOwner = async (): Promise<PlatformExtensionSessionContext> => ({ ...(await accountSession()), subject: "tsub_app_owner" });
  expect((await create(appOwner, "owner-made", { kind: "Capsule", id: "cap_platform_iface" })).status).toBe(201);
  expect((await create(accountSession, "workspace-made", { kind: "Workspace", id: "ws_platform_iface" })).status).toBe(201);
});

test("an app-scoped personal access token reaches only its apps and holds no Workspace authority", async () => {
  const env = await environment() as { TAKOSUMI_CONTROL_DB: SqliteFakeD1 };
  const control = new CloudflareD1OpenTofuControlStore(env.TAKOSUMI_CONTROL_DB);
  expect(await new D1AppOwnershipStore(env.TAKOSUMI_CONTROL_DB as never, control).initializeOwnershipIfMissing({
    capsuleId: "cap_platform_iface", ownerAccountId: "tsub_app_owner", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: "apps/cap_platform_iface",
  })).toBe(true);
  const pat = (appIds: readonly string[]) => async (): Promise<PlatformExtensionSessionContext> => ({
    authenticated: true, authKind: "personal-access-token", subject: "tsub_app_owner", scopes: ["read", "write"], appIds,
  });
  const create = (session: () => Promise<PlatformExtensionSessionContext>, name: string, ownerRef: { kind: string; id: string }) =>
    handlePlatformInterfaceApiRequest(
      request("/api/v1/interfaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws_platform_iface", name, ownerRef,
          spec: { type: "mcp.server", version: "2025-11-25", document: {}, access: { visibility: "private" } },
        }),
      }),
      env as never, session, async () => "owner" as const,
    );
  // The owner's PAT limited to another app cannot change this app's Interfaces.
  expect((await create(pat(["cap_somewhere_else"]), "other-scope", { kind: "Capsule", id: "cap_platform_iface" })).status).toBe(403);
  // Limited to this app, it can; it still never holds Workspace authority.
  const made = await create(pat(["cap_platform_iface"]), "own-scope", { kind: "Capsule", id: "cap_platform_iface" });
  expect(made.status).toBe(201);
  expect((await made.json()).metadata.createdUnder).toBe("app");
  expect((await create(pat(["cap_platform_iface"]), "workspace-scope", { kind: "Workspace", id: "ws_platform_iface" })).status).toBe(403);
});

test("an app-scoped personal access token issuing an Interface token keeps its app limit", async () => {
  const env = await environment() as { TAKOSUMI_CONTROL_DB: SqliteFakeD1 };
  // The app is live, so its Interface resolves.
  const control = new CloudflareD1OpenTofuControlStore(env.TAKOSUMI_CONTROL_DB);
  const capsule = (await control.getCapsule("cap_platform_iface"))!;
  await control.putCapsule({ ...capsule, status: "active", currentStateGeneration: 1 });
  const workspaceMember = async () => "owner" as const;
  const call = (session: () => Promise<PlatformExtensionSessionContext>, path: string, body: unknown) =>
    handlePlatformInterfaceApiRequest(
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.takosumi.com" },
        body: JSON.stringify(body),
      }),
      env as never, session, workspaceMember,
    );
  const spec = {
    type: "mcp.server", version: "2025-11-25", document: {},
    inputs: { endpoint: { source: "literal", value: "https://pat-issued.example.test/mcp" } },
    access: { visibility: "private" },
  };
  // Before the app has an ownership record, a Workspace session writes one
  // Capsule-owned and one Workspace-owned Interface, both bound to the PAT's subject.
  const ids: Record<string, string> = {};
  for (const [name, ownerRef] of [["app-owned", { kind: "Capsule", id: "cap_platform_iface" }], ["workspace-owned", { kind: "Workspace", id: "ws_platform_iface" }]] as const) {
    const created = await call(accountSession, "/api/v1/interfaces", { workspaceId: "ws_platform_iface", name, ownerRef, spec });
    expect(created.status).toBe(201);
    ids[name] = (await created.json()).metadata.id;
    const bound = await call(accountSession, `/api/v1/interfaces/${ids[name]}/bindings?workspaceId=ws_platform_iface`, {
      subjectRef: { kind: "Principal", id: "tsub_pat_user" }, permissions: ["mcp.invoke"], delivery: { type: "none" },
    });
    expect(bound.status).toBe(201);
  }
  const pat = (appIds: readonly string[]) => async (): Promise<PlatformExtensionSessionContext> => ({
    authenticated: true, authKind: "personal-access-token", subject: "tsub_pat_user", scopes: ["read", "write"], appIds,
  });
  const issue = (session: () => Promise<PlatformExtensionSessionContext>, interfaceId: string) =>
    call(session, `/api/v1/interfaces/${interfaceId}/token?workspaceId=ws_platform_iface`, { permission: "mcp.invoke" });
  // Limited to another app, it issues nothing; it never reaches a
  // Workspace-owned Interface either.
  expect((await issue(pat(["cap_somewhere_else"]), ids["app-owned"]!)).status).toBe(403);
  expect((await issue(pat(["cap_platform_iface"]), ids["workspace-owned"]!)).status).toBe(403);
  // Its own app's Interface is not refused by the app limit.
  expect((await issue(pat(["cap_platform_iface"]), ids["app-owned"]!)).status).not.toBe(403);
});
