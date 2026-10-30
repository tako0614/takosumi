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
