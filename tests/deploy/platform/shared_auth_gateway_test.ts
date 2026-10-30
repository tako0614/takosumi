import { expect, jest, spyOn, test } from "bun:test";
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
const absenceHeader = "x-takosumi-shared-auth-absent";
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

test("stock OSS reserves only the exact browser RP session GET as an absent route", async () => {
  const env = { HOSTED: rpc };
  const absent = await handleSharedAuthRouteRequest(request("/auth/oidc/session"), env);
  expect(absent?.status).toBe(404);
  expect(absent?.headers.get("cache-control")).toBe("no-store");
  expect(absent?.headers.get(absenceHeader)).toBe("1");
  expect(await absent?.json()).toEqual({ error: "not_found" });
  expect(await handleSharedAuthRouteRequest(request("/auth/oidc/session", { method: "HEAD" }), env)).toBeUndefined();
  expect(await handleSharedAuthRouteRequest(request("/auth/oidc/session?other=1"), env)).toBeUndefined();
  expect(await handleSharedAuthRouteRequest(request("/auth/oidc/login"), env)).toBeUndefined();
  const broken = await handleSharedAuthRouteRequest(request("/auth/oidc/session"), {
    ...configured(rpc),
    TAKOSUMI_SHARED_AUTH_ORIGIN: undefined,
  });
  expect(broken?.status).toBe(503);
});

test("configured RP response cannot forward the gateway's absence marker", async () => {
  const forwarded = await handleSharedAuthRouteRequest(request("/auth/oidc/session"),
    configured({
      ...rpc,
      fetchSharedAuth: async () => Response.json({ error: "not_found" }, {
        status: 404,
        headers: { [absenceHeader]: "1" },
      }),
    }));
  expect(forwarded?.status).toBe(404);
  expect(forwarded?.headers.get(absenceHeader)).toBeNull();
  expect(forwarded?.headers.get("cache-control")).toBe("no-store");
  expect(await forwarded?.json()).toEqual({ error: "not_found" });
});

test("local account management is absent on every opted-in product alias; separate issuer and self-host keep their account routes", async () => {
  const env = configured(rpc);
  for (const path of ["/api/v1/account/tokens", "/api/v1/account/shared-workspaces/bootstrap", "/api/v1/account/session/forged"]) {
    expect((await handleSharedAuthAccountBoundaryRequest(request(path), env))?.status).toBe(404);
    expect((await handleSharedAuthAccountBoundaryRequest(new Request("https://alias.staging.example.test" + path), env))?.status).toBe(404);
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

test("shared Run GET reports its read and current Workspace/member phases", async () => {
  const phaseRows: Array<Record<string, unknown>> = [];
  const info = spyOn(console, "info").mockImplementation((value: unknown) => {
    if (typeof value !== "string") return;
    try {
      const row = JSON.parse(value) as Record<string, unknown>;
      if (row.event === "request_phase") phaseRows.push(row);
    } catch {
      // Other diagnostic output is not part of this route's oracle.
    }
  });
  const operations = {
    getRun: async () => ({
      id: "run_shared", workspaceId: "ws_live", type: "plan", status: "succeeded",
      createdBy: "tsub_canonical", createdAt: "2026-10-14T00:00:00.000Z",
    }),
    workspaces: { getWorkspace: async () => ({ id: "ws_live", ownerUserId: "tsub_canonical" }) },
    members: { getMember: async () => ({
      workspaceId: "ws_live", accountId: "tsub_canonical", status: "active", roles: ["owner"],
    }) },
  } as unknown as ControlPlaneOperations;
  try {
    const response = await handlePlatformSharedAuthControlRequest(
      request("/api/v1/runs/run_shared", {
        headers: { cookie, "x-takosumi-request-probe-id": "a444000000000013" },
      }),
      { ...configured(rpc), TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: "true" } as CloudflareWorkerEnv,
      { store: new InMemoryAccountsStore(), resolveOperations: async () => operations },
    );
    expect(response?.status).toBe(200);
    expect((await response?.json()).run.id).toBe("run_shared");
    const phases = phaseRows.filter((row) => row.probeId === "a444000000000013");
    for (const phase of ["run_get_read", "run_get_access", "run_get_workspace", "run_get_member"]) {
      expect(phases.filter((row) => row.phase === phase).map((row) => row.outcome)).toEqual([
        "started", "fulfilled",
      ]);
    }
    expect(JSON.stringify(phases)).not.toContain("run_shared");
    expect(JSON.stringify(phases)).not.toContain(cookie);
  } finally {
    info.mockRestore();
  }
});

test("shared Run GET retains one five-second budget across RP auth and Run read", async () => {
  let releaseAuth = () => {};
  let enteredAuth = () => {};
  const authHeld = new Promise<void>((resolve) => { releaseAuth = resolve; });
  const authEntered = new Promise<void>((resolve) => { enteredAuth = resolve; });
  let releaseRun = () => {};
  let enteredRun = () => {};
  const runHeld = new Promise<void>((resolve) => { releaseRun = resolve; });
  const runEntered = new Promise<void>((resolve) => { enteredRun = resolve; });
  let workspaceReads = 0;
  let memberReads = 0;
  const env = configured({
    ...rpc,
    authenticateSharedAuth: async () => {
      enteredAuth();
      await authHeld;
      return { kind: "authenticated", accountId: "tsub_canonical" };
    },
  }) as CloudflareWorkerEnv;
  const operations = {
    getRun: async () => {
      enteredRun();
      await runHeld;
      return {
        id: "run_shared", workspaceId: "ws_live", type: "plan", status: "succeeded",
        createdBy: "tsub_canonical", createdAt: "2026-10-14T00:00:00.000Z",
      };
    },
    workspaces: { getWorkspace: async () => {
      workspaceReads++;
      return { id: "ws_live", ownerUserId: "tsub_canonical" };
    } },
    members: { getMember: async () => {
      memberReads++;
      return { workspaceId: "ws_live", accountId: "tsub_canonical", status: "active", roles: ["owner"] };
    } },
  } as unknown as ControlPlaneOperations;
  let pending: Promise<Response | undefined> | undefined;
  jest.useFakeTimers();
  try {
    pending = handlePlatformSharedAuthControlRequest(
      request("/api/v1/runs/run_shared"), env,
      { store: new InMemoryAccountsStore(), resolveOperations: async () => operations },
    );
    await authEntered;
    jest.advanceTimersByTime(3_000);
    releaseAuth();
    await runEntered;
    let settled = false;
    const observed = pending.then(() => { settled = true; }, () => { settled = true; });
    jest.advanceTimersByTime(1_999);
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(settled).toBe(true);
    const response = await pending;
    await observed;
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect((await response?.json()).error.code).toBe("feature_unavailable");
    releaseRun();
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(workspaceReads).toBe(0);
    expect(memberReads).toBe(0);
  } finally {
    releaseAuth();
    releaseRun();
    jest.useRealTimers();
    await pending?.catch(() => undefined);
  }
});

test("shared Run GET expires during a pending RP response without Control work", async () => {
  let releaseAuth = () => {};
  const authHeld = new Promise<void>((resolve) => { releaseAuth = resolve; });
  let authCalls = 0;
  let controlCalls = 0;
  const env = configured({
    ...rpc,
    authenticateSharedAuth: async () => {
      authCalls++;
      await authHeld;
      return { kind: "authenticated", accountId: "tsub_canonical" };
    },
  }) as CloudflareWorkerEnv;
  jest.useFakeTimers();
  try {
    const pending = handlePlatformSharedAuthControlRequest(
      request("/api/v1/runs/run_shared"), env,
      { resolveOperations: async () => {
        controlCalls++;
        throw new Error("Control must not start after RP timeout");
      } },
    );
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(authCalls).toBe(1);
    jest.advanceTimersByTime(5_000);
    for (let index = 0; index < 12; index++) await Promise.resolve();
    const response = await pending;
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect((await response?.json()).error.code).toBe("feature_unavailable");
    releaseAuth();
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(authCalls).toBe(1);
    expect(controlCalls).toBe(0);
  } finally {
    releaseAuth();
    jest.useRealTimers();
  }
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
  // The Workspace inventory is opt-in on the bootstrap (TASK-0118 9.1).
  const bootstrap = await handlePlatformSharedAuthControlRequest(request("/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceId=ws_live"), env, deps);
  expect(bootstrap?.status).toBe(200);
  expect(await bootstrap?.json()).toMatchObject({ session: { subject: "tsub_canonical" }, workspaces: [] });
  const defaultBootstrap = await handlePlatformSharedAuthControlRequest(request("/api/v1/dashboard/bootstrap?workspaceId=ws_live"), env, deps);
  expect(defaultBootstrap?.status).toBe(200);
  expect(await defaultBootstrap?.json()).not.toHaveProperty("workspaces");
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

test("trusted shared-auth cookies retain first-party authority for app members and transfers", async () => {
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({ subject: "recipient" as never, createdAt: 1, updatedAt: 1 });
  const authorization = {
    resolveAppAccess: async () => ({ capsuleId: "cap_shared", role: "owner", ownerAccountId: "tsub_canonical", ownershipEpoch: 0 }),
    listMembers: async () => ({ ownerAccountId: "tsub_canonical", ownershipEpoch: 0, members: [] }),
    listTransfers: async () => [],
    createTransfer: async () => ({ transferId: "transfer_shared", state: "pending" }),
  };
  const operations = { appAccess: authorization, appAuthorization: authorization,
    capsules: { getCapsulesByIds: async () => [] } } as unknown as ControlPlaneOperations;
  const env = configured(rpc) as CloudflareWorkerEnv;
  const dependencies = { store: accounts, resolveOperations: async () => operations };
  for (const path of ["/api/v1/capsules/cap_shared/members", "/api/v1/ownership-transfers"]) {
    const response = await handlePlatformSharedAuthControlRequest(request(path), env, dependencies);
    expect(response?.status).toBe(200);
  }
  const transfer = await handlePlatformSharedAuthControlRequest(request("/api/v1/capsules/cap_shared/ownership-transfers", {
    method: "POST", headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ toAccountId: "recipient" }),
  }), env, dependencies);
  expect(transfer?.status).toBe(201);
  expect(await transfer?.json()).toEqual({ transferId: "transfer_shared", state: "pending" });

  // The operator kill switch reaches this direct Control dispatch too: reads stay, writes return 409.
  const frozen = { ...env, TAKOSUMI_APP_OWNERSHIP_MUTATIONS: "frozen" } as CloudflareWorkerEnv;
  expect((await handlePlatformSharedAuthControlRequest(request("/api/v1/capsules/cap_shared/members"), frozen, dependencies))?.status).toBe(200);
  const paused = await handlePlatformSharedAuthControlRequest(request("/api/v1/capsules/cap_shared/ownership-transfers", {
    method: "POST", headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ toAccountId: "recipient" }),
  }), frozen, dependencies);
  expect(paused?.status).toBe(409);
  expect((await paused?.json()).error).toMatchObject({ code: "failed_precondition", details: { reason: "app_ownership_mutations_frozen" } });

  // A malformed trusted native client list trusts none but never fails Control requests.
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const malformed = { ...env, TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS: "[{\"id\":\"platform-gateway-marker\"}]" } as CloudflareWorkerEnv;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await handlePlatformSharedAuthControlRequest(request("/api/v1/capsules/cap_shared/members"), malformed, dependencies))?.status).toBe(200);
    }
    const lines = logged.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("trusted_native_clients_config_invalid"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("platform-gateway-marker");
  } finally {
    logged.mockRestore();
  }
});
