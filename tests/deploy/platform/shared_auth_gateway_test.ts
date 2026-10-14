import { expect, test } from "bun:test";
import {
  authenticateSharedAuthRequest,
  handleSharedAuthRouteRequest,
  handleSharedAuthAccountBoundaryRequest,
  resolveSharedAuthWorkspace,
  type SharedAuthEnvironment,
  type SharedAuthRpc,
} from "../../../worker/src/shared_auth_rpc.ts";
import {
  handlePlatformExtensionRouteRequest,
  handlePlatformSharedAuthControlRequest,
  handlePlatformSharedAuthSessionRequest,
  verifyPlatformExtensionBearerToken,
  type CloudflareWorkerEnv,
} from "../../../deploy/platform/worker.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { canAccessWorkspace } from "../../../accounts/service/src/control/shared.ts";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";

const origin = "https://hosted.staging.example.test";
const cookie = "__Host-takosumi_hosted_session=opaque-rp-session";
function configured(rpc: SharedAuthRpc): SharedAuthEnvironment {
  return {
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
    TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    TAKOSUMI_ENVIRONMENT: "staging",
    HOSTED: rpc,
  };
}
const rpc: SharedAuthRpc = {
  fetchSharedAuth: async () => new Response(null, { status: 204 }),
  authenticateSharedAuth: async () => ({ kind: "authenticated", accountId: "tsub_canonical" }),
  resolveSharedAuthWorkspace: async (_request, workspaceId) => ({
    kind: "authorized", accountId: "tsub_canonical", workspaceId, role: "viewer",
  }),
};
function request(path = "/extensions/hosted?workspaceId=ws_live", init: RequestInit = {}): Request {
  return new Request(`${origin}${path}`, { headers: { cookie }, ...init });
}

test("stock OSS never invokes an available private authentication service", async () => {
  let calls = 0;
  const env = { HOSTED: { ...rpc, authenticateSharedAuth: async () => { calls++; return { kind: "unauthenticated" as const }; } } };
  expect(await authenticateSharedAuthRequest(request(), env)).toBeUndefined();
  expect(await handleSharedAuthRouteRequest(request("/auth/oidc/login"), env)).toBeUndefined();
  expect(calls).toBe(0);
});

test("local account management is absent only on the opted-in product origin; issuer and self-host keep their account routes", async () => {
  const env = configured(rpc);
  for (const path of ["/api/v1/account/tokens", "/api/v1/account/shared-workspaces/bootstrap", "/api/v1/account/session/forged"]) {
    expect((await handleSharedAuthAccountBoundaryRequest(request(path), env))?.status).toBe(404);
    expect(await handleSharedAuthAccountBoundaryRequest(new Request("https://issuer.staging.example.test" + path), env)).toBeUndefined();
    expect(await handleSharedAuthAccountBoundaryRequest(request(path), { HOSTED: rpc })).toBeUndefined();
  }
  const signIn = await handleSharedAuthAccountBoundaryRequest(request("/sign-in?return=https://evil.example.test"), env);
  expect(signIn?.headers.get("location")).toBe(origin + "/auth/oidc/login");
  expect(await handleSharedAuthAccountBoundaryRequest(request("/oauth/token"), env)).toBeUndefined();
  expect(await handleSharedAuthAccountBoundaryRequest(request("/api/v1/account/session/me"), env)).toBeUndefined();
  expect(await handleSharedAuthAccountBoundaryRequest(request("/sign-in"), {})).toBeUndefined();
});

test("shared authentication is an exact HTTPS staging-only operator opt-in", async () => {
  for (const change of [
    { TAKOSUMI_ENVIRONMENT: "production" },
    { TAKOSUMI_SHARED_AUTH_PROFILE: "unknown" },
    { TAKOSUMI_SHARED_AUTH_ORIGIN: `${origin}/` },
    { TAKOSUMI_SHARED_AUTH_ORIGIN: "http://hosted.staging.example.test" },
    { HOSTED: undefined },
  ]) {
    expect(await authenticateSharedAuthRequest(request(), { ...configured(rpc), ...change })).toEqual({ kind: "unavailable" });
  }
  expect(await authenticateSharedAuthRequest(new Request("https://other.example.test/"), configured(rpc))).toEqual({ kind: "unauthenticated" });
});

test("a pending private identity RPC reaches a bounded unavailable result without retrying", async () => {
  let calls = 0;
  const env = configured({ ...rpc, authenticateSharedAuth: async () => {
    calls++;
    return await new Promise<never>(() => {});
  } });
  const startedAt = performance.now();
  expect(await authenticateSharedAuthRequest(request(), env)).toEqual({ kind: "unavailable" });
  expect(performance.now() - startedAt).toBeLessThan(7_000);
  expect(calls).toBe(1);
}, 10_000);

test("explicit bearer and issuer session headers cannot fall back to an RP cookie", async () => {
  for (const headers of [
    { cookie, authorization: "Bearer forged-id-token" },
    { cookie, "x-takosumi-account-session": "sess_forged" },
  ]) {
    expect(await authenticateSharedAuthRequest(request("/", { headers }), configured(rpc))).toEqual({ kind: "unauthenticated" });
    expect((await handleSharedAuthRouteRequest(request("/auth/oidc/login", { headers }), configured(rpc)))?.status).toBe(401);
  }
});

test("an active identity-only issuer grant cannot authorize an extension with no required scopes", async () => {
  const introspection = async () => Response.json({
    active: true, token_use: "oauth_access",
    sub: "tsub_canonical", aud: "private-rp", scope: "openid profile email",
  });
  const client = {
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "private-rp", TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "test-only-client-secret",
  };
  const result = await verifyPlatformExtensionBearerToken(request(), {
    ...configured(rpc), ...client,
  } as CloudflareWorkerEnv, "test-only-user-access-token", undefined, introspection);
  expect(result).toEqual({ authenticated: false });
  const stock = await verifyPlatformExtensionBearerToken(request(),
    client as CloudflareWorkerEnv, "test-only-user-access-token", undefined, introspection);
  expect(stock).toMatchObject({ authenticated: true, authKind: "oauth-access-token", subject: "tsub_canonical" });
});

test("the private RPC receives credentials only in the RP cookie, with no forged context", async () => {
  let forwarded: Request | undefined;
  const env = configured({ ...rpc, authenticateSharedAuth: async (value) => {
    forwarded = value;
    return { kind: "authenticated", accountId: "tsub_canonical" };
  } });
  const identity = await authenticateSharedAuthRequest(request("/", {
    method: "POST", headers: {
      cookie, origin, "content-type": "application/json",
      "x-takosumi-platform-subject": "tsub_attacker",
      "x-takosumi-actor-context": "owner", "x-auth-user-service-key": "forged",
    }, body: JSON.stringify({ accountId: "tsub_attacker", role: "owner" }),
  }), env);
  expect(identity).toEqual({ kind: "authenticated", accountId: "tsub_canonical" });
  expect(forwarded?.headers.get("cookie")).toBe(cookie);
  expect(forwarded?.headers.get("x-takosumi-platform-subject")).toBeNull();
  expect(forwarded?.headers.get("x-takosumi-actor-context")).toBeNull();
  expect(forwarded?.headers.get("x-auth-user-service-key")).toBeNull();
  expect(await forwarded?.text()).toBe("");
});

test("auth routes and logout alias retain exact-origin CSRF and no-store", async () => {
  const env = configured(rpc);
  for (const suppliedOrigin of [undefined, "https://evil.example.test"]) {
    const response = await handleSharedAuthRouteRequest(request("/auth/oidc/logout", {
      method: "POST", headers: { cookie, ...(suppliedOrigin ? { origin: suppliedOrigin } : {}) },
    }), env);
    expect(response?.status).toBe(403);
  }
  expect((await handlePlatformSharedAuthSessionRequest(request("/api/v1/account/session/me", {
    method: "DELETE", headers: { cookie, origin },
  }), env))?.status).toBe(204);
  const mirror = await handlePlatformSharedAuthSessionRequest(request("/api/v1/account/session/me"), env);
  expect(await mirror?.json()).toEqual({ subject: "tsub_canonical", primaryAccountId: "tsub_canonical", expiresAt: 0 });
  expect(mirror?.headers.get("cache-control")).toBe("no-store");
  expect(await handleSharedAuthRouteRequest(request("/auth/oidc/session/extra"), env)).toBeUndefined();
});

test("workspace RPC must return the same account and requested Workspace, with a valid live role", async () => {
  for (const result of [
    { kind: "authorized", accountId: "tsub_attacker", workspaceId: "ws_live", role: "owner" },
    { kind: "authorized", accountId: "tsub_canonical", workspaceId: "ws_attacker", role: "owner" },
    { kind: "authorized", accountId: "tsub_canonical", workspaceId: "ws_live", role: "superadmin" },
  ]) {
    const env = configured({ ...rpc, resolveSharedAuthWorkspace: async () => result as never });
    expect(await resolveSharedAuthWorkspace(request(), env, "tsub_canonical", "ws_live")).toEqual({ kind: "unavailable" });
  }
});

test("extension context carries only the live common membership, and rejects viewer mutation or revoked membership", async () => {
  let calls = 0;
  let role: "viewer" | "admin" | "forbidden" = "viewer";
  const env = { ...configured({ ...rpc, resolveSharedAuthWorkspace: async (_request, workspaceId) => role === "forbidden"
    ? { kind: "forbidden" }
    : { kind: "authorized", accountId: "tsub_canonical", workspaceId, role } }),
    HOSTED_EXTENSION: { fetchAuthenticated: async (value: Request, context: unknown) => {
      calls++;
      expect(value.headers.get("cookie")).toBeNull();
      return Response.json(context);
    } },
  } as CloudflareWorkerEnv;
  const route = { basePath: "/extensions/hosted", handlerKey: "HOSTED_EXTENSION", authDelivery: "context" as const, workspaceContext: "query-required" as const };
  const read = await handlePlatformExtensionRouteRequest(request(), env, route);
  expect(await read.json()).toEqual({ authKind: "session", subject: "tsub_canonical", workspaceId: "ws_live", workspaceRole: "viewer" });
  expect((await handlePlatformExtensionRouteRequest(request(undefined, { method: "POST", headers: { cookie, origin } }), env, route)).status).toBe(403);
  role = "admin";
  expect((await handlePlatformExtensionRouteRequest(request(undefined, { method: "POST", headers: { cookie, origin } }), env, route)).status).toBe(200);
  role = "forbidden";
  expect((await handlePlatformExtensionRouteRequest(request(), env, route)).status).toBe(403);
  expect(calls).toBe(2);
});

test("shared current-membership policy denies a suspended owner and mismatched membership; OSS owner behavior remains", async () => {
  let status: "active" | "suspended" = "suspended";
  const workspace = { id: "ws_live", ownerUserId: "tsub_canonical" };
  const operations = { workspaces: { getWorkspace: async () => workspace }, members: {
    getMember: async () => ({ workspaceId: "ws_live", accountId: "tsub_canonical", status, roles: ["owner"] }),
  } } as unknown as ControlPlaneOperations;
  const base = { operations, store: new InMemoryAccountsStore(), workspaceId: "ws_live" };
  expect(await canAccessWorkspace({ ...base, session: { subject: "tsub_canonical" } })).toBe(true);
  expect(await canAccessWorkspace({ ...base, session: { subject: "tsub_canonical", requireCurrentMembership: true } })).toBe(false);
  status = "active";
  expect(await canAccessWorkspace({ ...base, session: { subject: "tsub_canonical", requireCurrentMembership: true } })).toBe(true);
});

test("public shared Control gate never initializes Control for invalid identity, CSRF, or issuer-header impersonation", async () => {
  let calls = 0;
  const dependencies = { resolveOperations: async () => { calls++; throw new Error("unexpected Control initialization"); } };
  const env = configured({ ...rpc, authenticateSharedAuth: async () => ({ kind: "unauthenticated" }) }) as CloudflareWorkerEnv;
  expect((await handlePlatformSharedAuthControlRequest(request("/api/v1/workspaces/ws_live"), env, dependencies))?.status).toBe(401);
  expect((await handlePlatformSharedAuthControlRequest(request("/api/v1/workspaces/ws_live", { method: "PATCH", headers: { cookie, origin: "https://evil.example.test" } }), configured(rpc) as CloudflareWorkerEnv, dependencies))?.status).toBe(403);
  expect((await handlePlatformSharedAuthControlRequest(request("/api/v1/workspaces/ws_live", { headers: { cookie, "x-takosumi-account-session": "sess_forged" } }), configured(rpc) as CloudflareWorkerEnv, dependencies))?.status).toBe(401);
  expect((await handlePlatformSharedAuthControlRequest(request("/api/v1/workspaces/ws_live", { headers: { cookie, authorization: "Basic forged" } }), configured(rpc) as CloudflareWorkerEnv, dependencies))?.status).toBe(401);
  expect(calls).toBe(0);
});

test("shared Workspace menu never pins or repairs a suspended recorded owner", async () => {
  let repairs = 0;
  const workspace = { id: "ws_live", handle: "owned", displayName: "Owned", type: "personal",
    ownerUserId: "tsub_canonical", createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z" };
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => ({ items: [], total: 0 }),
      getWorkspaceForAccount: async () => workspace,
      getWorkspace: async () => workspace,
      ensurePersonalWorkspace: async () => { repairs++; return workspace; },
    },
    members: { getMember: async () => ({ workspaceId: "ws_live", accountId: "tsub_canonical", status: "suspended", roles: ["owner"] }) },
  } as unknown as ControlPlaneOperations;
  const deps = { store: new InMemoryAccountsStore(), resolveOperations: async () => operations };
  const env = configured(rpc) as CloudflareWorkerEnv;
  const list = await handlePlatformSharedAuthControlRequest(request("/api/v1/workspaces?selectedWorkspaceId=ws_live"), env, deps);
  expect(list?.status).toBe(200);
  expect(await list?.json()).toMatchObject({ workspaces: [] });
  const bootstrap = await handlePlatformSharedAuthControlRequest(request("/api/v1/dashboard/bootstrap?workspaceId=ws_live"), env, deps);
  expect(bootstrap?.status).toBe(200);
  expect(await bootstrap?.json()).toMatchObject({ session: { subject: "tsub_canonical" }, workspaces: [] });
  expect(repairs).toBe(0);
});

test.each(["grant", "account", "membership"] as const)(
  "shared Run stream stops before another snapshot after current %s changes",
  async (change) => {
    let active = true;
    let accountId = "tsub_canonical";
    let memberActive = true;
    let now = 0;
    let tick: (() => void) | undefined;
    let reads = 0;
    const env = configured({ ...rpc, authenticateSharedAuth: async () => active
      ? { kind: "authenticated", accountId }
      : { kind: "unauthenticated" } }) as CloudflareWorkerEnv;
    const workspace = { id: "ws_live", ownerUserId: "tsub_canonical" };
    const operations = {
      workspaces: { getWorkspace: async () => workspace },
      members: { getMember: async () => memberActive
        ? { workspaceId: "ws_live", accountId: "tsub_canonical", status: "active", roles: ["owner"] }
        : undefined },
      getRun: async () => {
        reads++;
        return { id: "run_shared", workspaceId: "ws_live", type: "plan", status: "running",
          createdBy: "tsub_canonical", createdAt: "2026-10-14T00:00:00.000Z", heartbeatAt: now };
      },
    } as unknown as ControlPlaneOperations;
    const response = await handlePlatformSharedAuthControlRequest(request("/api/v1/runs/run_shared/stream"), env, {
      store: new InMemoryAccountsStore(), resolveOperations: async () => operations,
      runStreamTiming: { now: () => now, wait: () => new Promise<void>((resolve) => { tick = resolve; }) },
    });
    expect(response?.status).toBe(200);
    const reader = response!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("run_shared");
    if (change === "grant") active = false;
    if (change === "account") accountId = "tsub_successor";
    if (change === "membership") memberActive = false;
    now = 60_000;
    if (!tick) throw new Error("shared stream polling timer missing");
    tick();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(reads).toBe(1);
  },
);
