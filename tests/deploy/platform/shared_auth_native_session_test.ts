import { expect, test } from "bun:test";

import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { createSharedAccountMobileExchangeRateLimiter } from "../../../accounts/service/src/mod.ts";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import platformWorker, {
  type CloudflareWorkerEnv,
  handlePlatformExtensionRouteRequest,
  handlePlatformSharedAuthControlRequest,
  handlePlatformSharedAuthNotificationPushersRequest,
} from "../../../deploy/platform/worker.ts";
import {
  handleSharedAuthNativeCallbackRequest,
  handleSharedAuthNativeExchangeRequest,
  sharedAuthNativeLane,
  sharedAuthRequestFailure,
  SHARED_AUTH_NATIVE_SESSION_HEADER,
  type SharedAuthNativeExchange,
  type SharedAuthRpc,
} from "../../../worker/src/shared_auth_rpc.ts";
import { base64UrlEncode } from "../../../core/domains/notifications/web_push/bytes.ts";
import { createTestUserAgent } from "../../helpers/web_push_receiver.ts";

// Takosumi Mobile on the shared-account product host (Hosted, ADR 0025/0026):
// the app signs in at the private RP's issuer as the Takosumi Mobile client,
// the RP redeems the code and creates a session of the browser's kind, and
// the app presents it in its own header. These tests drive the gateway with a
// fake private RP; the RP's own ID-token verification is tested where it lives.

const origin = "https://hosted.staging.example.test";
const issuer = "https://auth.staging.example.test";
const clientId = "takosumi-mobile-staging-v1";
const relay = "https://relay.example.test";
const browserCookie = "__Host-takosumi_hosted_session=opaque-rp-session";
const nativeAccount = "tsub_native";
const browserAccount = "tsub_browser";
const header = SHARED_AUTH_NATIVE_SESSION_HEADER;
const tauriOrigin = "tauri://localhost";
const verifier = "v".repeat(64);
const nonce = "n".repeat(43);

interface FakeRp extends SharedAuthRpc {
  readonly exchanged: Request[];
  readonly exchangedBodies: unknown[];
  readonly authenticated: Request[];
  readonly revoked: Request[];
  readonly sessions: Map<string, string>;
}

let tokenSequence = 0;
function nextToken(): string {
  tokenSequence += 1;
  return `tns_${String(tokenSequence).padStart(4, "0")}${"A".repeat(40)}`;
}

/**
 * A stand-in for the private RP. It accepts exactly one code ("code-ok"),
 * once; every other code, a reused code or a mismatched nonce is refused, as
 * the real RP refuses a wrong issuer, audience, signature, expiry or nonce.
 */
function fakeRp(overrides: Partial<SharedAuthRpc> = {}): FakeRp {
  const used = new Set<string>();
  const exchanged: Request[] = [];
  const exchangedBodies: unknown[] = [];
  const authenticated: Request[] = [];
  const revoked: Request[] = [];
  const sessions = new Map<string, string>();
  return {
    exchanged, exchangedBodies, authenticated, revoked, sessions,
    fetchSharedAuth: async () => new Response(null, { status: 204 }),
    authenticateSharedAuth: async (request) => {
      authenticated.push(request);
      const presented = request.headers.get(header);
      if (presented !== null) {
        const account = sessions.get(presented);
        return account ? { kind: "authenticated", accountId: account } : { kind: "unauthenticated" };
      }
      return request.headers.get("cookie") === browserCookie
        ? { kind: "authenticated", accountId: browserAccount }
        : { kind: "unauthenticated" };
    },
    resolveSharedAuthWorkspace: async () => ({ kind: "forbidden" }),
    exchangeSharedAuthNativeSession: async (request): Promise<SharedAuthNativeExchange> => {
      exchanged.push(request);
      const body = await request.json() as { code: string; code_verifier: string; nonce: string };
      exchangedBodies.push(body);
      if (body.code !== "code-ok" || used.has(body.code) || body.nonce !== nonce) return { kind: "refused" };
      used.add(body.code);
      const token = nextToken();
      sessions.set(token, nativeAccount);
      return { kind: "established", sessionToken: token, accountId: nativeAccount, expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 };
    },
    revokeSharedAuthNativeSession: async (request) => {
      revoked.push(request);
      const presented = request.headers.get(header);
      return presented !== null && sessions.delete(presented) ? { kind: "revoked" } : { kind: "unauthenticated" };
    },
    ...overrides,
  };
}

function sharedEnv(rpc: SharedAuthRpc, extra: Record<string, unknown> = {}): CloudflareWorkerEnv {
  return {
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
    TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_SHARED_AUTH_ISSUER: issuer,
    TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID: clientId,
    TAKOSUMI_ACCOUNTS_ISSUER: origin,
    TAKOSUMI_SECRET_STORE_PASSPHRASE: "fixture-only-secret-store-passphrase-0123456789",
    TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: JSON.stringify([relay]),
    HOSTED: rpc,
    ...extra,
  } as unknown as CloudflareWorkerEnv;
}

function source(): string {
  return `198.51.100.${Math.floor(Math.random() * 250) + 1}-${crypto.randomUUID()}`;
}

function exchangeRequest(body: unknown, init: { headers?: Record<string, string>; base?: string; raw?: string } = {}): Request {
  return new Request(`${init.base ?? origin}/api/v1/account/session/mobile-exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: tauriOrigin,
      "cf-connecting-ip": source(),
      ...init.headers,
    },
    body: init.raw ?? JSON.stringify(body),
  });
}

async function signIn(env: CloudflareWorkerEnv): Promise<string> {
  const response = await platformWorker.fetch(exchangeRequest({ code: "code-ok", code_verifier: verifier, nonce }), env);
  expect(response.status).toBe(200);
  return ((await response.json()) as { session_token: string }).session_token;
}

function nativeRequest(path: string, token: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: { [header]: token, origin: tauriOrigin, "cf-connecting-ip": source(), ...init.headers },
  });
}

// --- discovery ---------------------------------------------------------------

test("discovery on a shared-account host offers Takosumi Mobile the RP's issuer and client, and never this Worker's own client", async () => {
  const response = await platformWorker.fetch(new Request(`${origin}/.well-known/takosumi`), sharedEnv(fakeRp()));
  const document = await response.json() as Record<string, unknown>;
  expect(document.oidcClientId).toBeUndefined();
  expect(document.shared_account_sign_in).toEqual({
    issuer,
    client_id: clientId,
    redirect_uri: `${origin}/auth/oidc/native/callback`,
    session_exchange: `${origin}/api/v1/account/session/mobile-exchange`,
    session_header: "x-takosumi-native-session",
    scope: "openid email offline_access",
  });

  // Not configured, or configured badly: no sign-in is offered at all.
  for (const extra of [
    { TAKOSUMI_SHARED_AUTH_ISSUER: undefined, TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID: undefined },
    { TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID: undefined },
    { TAKOSUMI_SHARED_AUTH_ISSUER: undefined },
    { TAKOSUMI_SHARED_AUTH_ISSUER: "http://auth.staging.example.test" },
    { TAKOSUMI_SHARED_AUTH_ISSUER: `${issuer}/` },
    { TAKOSUMI_SHARED_AUTH_ISSUER: origin },
    { TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID: "bad client" },
  ]) {
    const other = await (await platformWorker.fetch(new Request(`${origin}/.well-known/takosumi`), sharedEnv(fakeRp(), extra))).json() as Record<string, unknown>;
    expect(other.oidcClientId).toBeUndefined();
    expect(other.shared_account_sign_in).toBeUndefined();
  }
});

test("self-hosted discovery keeps the built-in Takosumi Mobile client and has no shared-account sign-in", async () => {
  const document = await (await platformWorker.fetch(new Request("https://self.example.test/.well-known/takosumi"), {} as CloudflareWorkerEnv)).json() as Record<string, unknown>;
  expect(document.oidcClientId).toBe("takosumi-mobile");
  expect(document.shared_account_sign_in).toBeUndefined();
  // The new pieces are inert without the profile.
  const stock = {} as CloudflareWorkerEnv;
  expect(handleSharedAuthNativeCallbackRequest(new Request("https://self.example.test/auth/oidc/native/callback?code=c&state=s"), stock)).toBeUndefined();
  expect(await handleSharedAuthNativeExchangeRequest(exchangeRequest({}, { base: "https://self.example.test" }), stock)).toBeUndefined();
  expect(sharedAuthRequestFailure(nativeRequest("/api/v1/apps", "not a token"), stock)).toBeUndefined();
});

// --- the HTTPS redirect page ---------------------------------------------------

test("the native callback hands exactly the authorization response to the app's fixed URI", async () => {
  const env = sharedEnv(fakeRp());
  const page = await platformWorker.fetch(new Request(`${origin}/auth/oidc/native/callback?code=abc.DEF-123&state=st_1&iss=${encodeURIComponent(issuer)}`), env);
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(page.headers.get("set-cookie")).toBeNull();
  const html = await page.text();
  const target = `takosumi://oauth/callback?code=abc.DEF-123&amp;state=st_1&amp;iss=${encodeURIComponent(issuer)}`;
  expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${target}">`);
  expect(html).toContain(`<a href="${target}">`);

  const denied = await (await platformWorker.fetch(new Request(`${origin}/auth/oidc/native/callback?error=access_denied&error_description=${encodeURIComponent("The user said no")}&state=st_2`), env)).text();
  expect(denied).toContain("takosumi://oauth/callback?error=access_denied&amp;error_description=The+user+said+no&amp;state=st_2");

  // Markup in a value stays text.
  const escaped = await (await platformWorker.fetch(new Request(`${origin}/auth/oidc/native/callback?code=x&state=${encodeURIComponent('"><script>')}`), env)).text();
  expect(escaped).not.toContain("<script>");
});

test("the native callback refuses anything but one well-formed response, and exists only on the configured product origin", async () => {
  const env = sharedEnv(fakeRp());
  for (const query of [
    "code=c", // no state
    "code=c&state=s&extra=1",
    "code=c&code=d&state=s",
    "code=c&state=s&state=t",
    "code=c&error=e&state=s",
    "state=s", // neither code nor error
    `code=c&state=s&iss=${encodeURIComponent("https://other-issuer.example.test")}`,
    `code=${encodeURIComponent("with space")}&state=s`,
  ]) {
    const response = await platformWorker.fetch(new Request(`${origin}/auth/oidc/native/callback?${query}`), env);
    expect(response.status, query).toBe(400);
  }
  expect((await platformWorker.fetch(new Request(`${origin}/auth/oidc/native/callback?code=c&state=s`, { method: "POST" }), env)).status).toBe(405);
  expect((await platformWorker.fetch(new Request("https://alias.example.workers.dev/auth/oidc/native/callback?code=c&state=s"), env)).status).toBe(404);
  const unconfigured = sharedEnv(fakeRp(), { TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID: undefined });
  expect((await platformWorker.fetch(new Request(`${origin}/auth/oidc/native/callback?code=c&state=s`), unconfigured)).status).toBe(404);
});

// --- the code exchange -----------------------------------------------------------

test("the exchange relays only the code, verifier and nonce to the RP and returns a session of the browser's kind", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const response = await platformWorker.fetch(exchangeRequest({ code: "code-ok", code_verifier: verifier, nonce }, {
    headers: { cookie: "__cf_bm=edge-cookie", "x-takosumi-platform-subject": "tsub_forged" },
  }), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  const body = await response.json() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["account_id", "expires_at", "session_header", "session_token", "token_type"]);
  expect(body).toMatchObject({ token_type: "takosumi-native-session", session_header: header, account_id: nativeAccount });
  expect(rp.sessions.get(body.session_token as string)).toBe(nativeAccount);

  expect(rp.exchanged).toHaveLength(1);
  const relayed = rp.exchanged[0]!;
  expect(new URL(relayed.url).href).toBe(`${origin}/api/v1/account/session/mobile-exchange`);
  expect([...relayed.headers.keys()].sort()).toEqual(["accept", "content-type"]);
  expect(rp.exchangedBodies[0]).toEqual({ code: "code-ok", code_verifier: verifier, nonce });
});

test("every refusal by the RP is one 401, and a replayed code never yields a second session", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  await signIn(env);
  // The same code again (replay), a code the RP's checks refuse, a nonce that
  // does not match the ID token's: the app learns only that it must start over.
  for (const body of [
    { code: "code-ok", code_verifier: verifier, nonce },
    { code: "code-wrong-audience", code_verifier: verifier, nonce },
    { code: "code-ok", code_verifier: verifier, nonce: "m".repeat(43) },
  ]) {
    const response = await platformWorker.fetch(exchangeRequest(body), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "sign_in_refused" });
  }
  expect(rp.sessions.size).toBe(1);
});

test("an unavailable, missing or malformed RP answer is 503, never a session", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const answers: Array<SharedAuthRpc["exchangeSharedAuthNativeSession"] | null> = [
    async () => ({ kind: "unavailable" }),
    async () => { throw new Error("issuer down"); },
    async () => ({ kind: "established", sessionToken: "short", accountId: nativeAccount, expiresAt: future }),
    async () => ({ kind: "established", sessionToken: "tns_" + "B".repeat(40), accountId: "acct_not_canonical", expiresAt: future }),
    async () => ({ kind: "established", sessionToken: "tns_" + "B".repeat(40), accountId: nativeAccount, expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    async () => ({ kind: "established", sessionToken: "tns_" + "B".repeat(40), accountId: nativeAccount, expiresAt: future + 30 * 24 * 3600 }),
    async () => ({ kind: "maybe" } as never),
    null,
  ];
  for (const answer of answers) {
    const rp = answer === null
      ? (({ exchangeSharedAuthNativeSession: _omit, ...rest }) => rest)(fakeRp()) as SharedAuthRpc
      : fakeRp({ exchangeSharedAuthNativeSession: answer });
    const response = await platformWorker.fetch(exchangeRequest({ code: "code-ok", code_verifier: verifier, nonce }), sharedEnv(rp));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "authentication_unavailable" });
  }
});

test("a malformed exchange body is 400 and never reaches the RP", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const good = { code: "code-ok", code_verifier: verifier, nonce };
  const cases: Array<{ body?: unknown; raw?: string; headers?: Record<string, string> }> = [
    { body: { ...good, extra: 1 } },
    { body: { code: "code-ok", code_verifier: verifier } },
    { body: { ...good, code_verifier: "short" } },
    { body: { ...good, nonce: "too-short" } },
    { body: { ...good, code: "" } },
    { body: { ...good, code: 7 } },
    { body: [good] },
    { raw: "not json" },
    { raw: JSON.stringify({ ...good, code: "c".repeat(9000) }) },
    { body: good, headers: { "content-type": "text/plain" } },
    { body: good, headers: { "content-type": "application/x-www-form-urlencoded" } },
  ];
  for (const entry of cases) {
    const response = await platformWorker.fetch(exchangeRequest(entry.body, { raw: entry.raw, headers: entry.headers }), env);
    expect(response.status, JSON.stringify(entry).slice(0, 80)).toBe(400);
  }
  expect(rp.exchanged).toHaveLength(0);
});

test("the exchange takes no credential, refuses browsers, and exists only on the configured origin", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const good = { code: "code-ok", code_verifier: verifier, nonce };
  for (const headers of [
    { authorization: "Bearer pat_forged" },
    { "x-takosumi-account-session": "sess_forged" },
    { [header]: "tns_" + "C".repeat(40) },
  ]) {
    expect((await platformWorker.fetch(exchangeRequest(good, { headers }), env)).status).toBe(401);
  }
  for (const headers of [
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-mode": "cors" },
    { origin: "https://evil.example.test" },
    { origin },
  ]) {
    const response = await platformWorker.fetch(exchangeRequest(good, { headers }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "native_client_required" });
  }
  expect(rp.exchanged).toHaveLength(0);
  expect((await platformWorker.fetch(new Request(`${origin}/api/v1/account/session/mobile-exchange`), env)).status).toBe(405);
  expect((await platformWorker.fetch(exchangeRequest(good, { base: "https://alias.example.workers.dev" }), env)).status).toBe(404);
  expect((await platformWorker.fetch(exchangeRequest(good), sharedEnv(rp, { TAKOSUMI_SHARED_AUTH_ISSUER: undefined }))).status).toBe(404);
  // No Origin at all is a native client too.
  const withoutOrigin = new Request(`${origin}/api/v1/account/session/mobile-exchange`, {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": source() }, body: JSON.stringify(good),
  });
  expect((await platformWorker.fetch(withoutOrigin, env)).status).toBe(200);
});

test("the exchange is rate limited per source", async () => {
  const env = sharedEnv(fakeRp());
  const limiter = createSharedAccountMobileExchangeRateLimiter();
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await handleSharedAuthNativeExchangeRequest(exchangeRequest({ code: `code-${attempt}`, code_verifier: verifier, nonce }, {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    }), env, { limiter });
    statuses.push(response!.status);
  }
  expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
  expect(statuses[10]).toBe(429);
});

// --- the native session on the management APIs -----------------------------------

test("the native session reaches the RP alone: no cookie, Origin or fetch metadata travel with it", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const token = await signIn(env);
  const mirror = await platformWorker.fetch(nativeRequest("/api/v1/account/session/me", token, { headers: { cookie: browserCookie } }), env);
  expect(await mirror.json()).toEqual({ subject: nativeAccount, primaryAccountId: nativeAccount, expiresAt: 0 });
  const forwarded = rp.authenticated.at(-1)!;
  expect([...forwarded.headers.keys()].sort()).toEqual([header]);
  expect(forwarded.headers.get(header)).toBe(token);
});

test("pushers register from Takosumi Mobile with the native session; a cookie still needs the product origin", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const token = await signIn(env);
  const store = new InMemoryAccountsStore();
  const agent = await createTestUserAgent();
  const body = {
    kind: "webpush", app_id: "com.takosumi", pushkey: base64UrlEncode(agent.p256dh),
    data: { url: `${relay}/push/${crypto.randomUUID()}`, auth: base64UrlEncode(agent.auth) },
    device_display_name: "Pixel 9", lang: "ja-JP",
  };
  const created = await handlePlatformSharedAuthNotificationPushersRequest(nativeRequest("/api/v1/account/notification-pushers", token, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, { store });
  expect(created?.status).toBe(201);
  const listed = await handlePlatformSharedAuthNotificationPushersRequest(nativeRequest("/api/v1/account/notification-pushers", token), env, { store });
  expect(((await listed!.json()) as { pushers: unknown[] }).pushers).toHaveLength(1);

  // The browser's cookie from a non-product Origin is still a forged write.
  const crossSite = await handlePlatformSharedAuthNotificationPushersRequest(new Request(`${origin}/api/v1/account/notification-pushers`, {
    method: "POST",
    headers: { cookie: browserCookie, origin: tauriOrigin, "content-type": "application/json", "cf-connecting-ip": source() },
    body: JSON.stringify(body),
  }), env, { store });
  expect(crossSite?.status).toBe(403);
});

function controlOperations(approvals: Array<{ runId: string; approvedBy: string }>): ControlPlaneOperations {
  const run = {
    id: "run_native", workspaceId: "ws_live", capsuleId: "cap_native", environment: "production", type: "plan",
    status: "waiting_approval", origin: { kind: "update" }, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
  };
  const ownership = {
    capsuleId: "cap_native", ownerAccountId: nativeAccount, ownershipEpoch: 0, managementState: "active", managementEpoch: 0,
    storageRoot: "apps/cap_native",
  };
  const access = { capsuleId: "cap_native", role: "owner", ownerAccountId: nativeAccount, ownershipEpoch: 0 };
  return {
    appOwnership: { getOwnership: async (capsuleId: string) => capsuleId === "cap_native" ? ownership : undefined },
    appAccess: {
      resolveAppAccess: async (subject: string, capsuleId: string) => subject === nativeAccount && capsuleId === "cap_native" ? access : undefined,
      listAccessibleApps: async (subject: string) => ({ apps: subject === nativeAccount ? [access] : [] }),
    },
    listCapsuleRunsPage: async () => ({ runs: [] }),
    capsules: {
      getCapsulesByIds: async () => [],
      getCapsule: async () => ({ id: "cap_native", workspaceId: "ws_live", status: "active" }),
    },
    // The shared-account profile also requires current Workspace membership.
    workspaces: { getWorkspace: async () => ({ id: "ws_live", ownerUserId: nativeAccount }) },
    members: {
      getMember: async (_workspaceId: string, accountId: string) => accountId === nativeAccount
        ? { workspaceId: "ws_live", accountId, status: "active", roles: ["owner"] }
        : undefined,
    },
    getRun: async () => run,
    approveRun: async (runId: string, input: { approvedBy: string }) => {
      approvals.push({ runId, approvedBy: input.approvedBy });
      return { ...run, status: "approved" };
    },
  } as unknown as ControlPlaneOperations;
}

test("the app list and Run approval work with the native session, which needs no product Origin", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const token = await signIn(env);
  const approvals: Array<{ runId: string; approvedBy: string }> = [];
  const dependencies = { store: new InMemoryAccountsStore(), resolveOperations: async () => controlOperations(approvals) };

  const apps = await handlePlatformSharedAuthControlRequest(nativeRequest("/api/v1/apps", token), env, dependencies);
  expect(apps?.status).toBe(200);
  expect(await apps?.json()).toMatchObject({ apps: [] });

  const approved = await handlePlatformSharedAuthControlRequest(nativeRequest("/api/v1/runs/run_native/approve", token, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), env, dependencies);
  expect(approved?.status).toBe(200);
  expect(approvals).toEqual([{ runId: "run_native", approvedBy: nativeAccount }]);

  // Without any Origin (a native client that sends none) it works the same.
  const bare = new Request(`${origin}/api/v1/runs/run_native/approve`, {
    method: "POST", headers: { [header]: token, "content-type": "application/json" }, body: "{}",
  });
  expect((await handlePlatformSharedAuthControlRequest(bare, env, dependencies))?.status).toBe(200);

  // The browser cookie keeps its exact-Origin rule.
  const cookieFromApp = new Request(`${origin}/api/v1/runs/run_native/approve`, {
    method: "POST", headers: { cookie: browserCookie, origin: tauriOrigin, "content-type": "application/json" }, body: "{}",
  });
  expect((await handlePlatformSharedAuthControlRequest(cookieFromApp, env, dependencies))?.status).toBe(403);
  expect(approvals).toHaveLength(2);
});

test("a native session mixed with another credential, sent by a browser or malformed is refused everywhere", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const token = await signIn(env);
  const before = rp.authenticated.length;
  for (const [label, headers] of [
    ["with Authorization", { authorization: `Bearer ${token}` }],
    ["with an issuer session", { "x-takosumi-account-session": "sess_forged" }],
    ["with fetch metadata", { "sec-fetch-site": "same-origin" }],
    ["from a web origin", { origin: "https://evil.example.test" }],
    ["from the product origin", { origin }],
  ] as const) {
    for (const path of ["/api/v1/apps", "/api/v1/account/notification-pushers", "/api/v1/account/session/me"]) {
      const response = await platformWorker.fetch(nativeRequest(path, token, { headers }), env);
      expect(response.status, `${label} ${path}`).toBe(401);
    }
  }
  for (const malformed of ["short", `${token}, ${token}`, "tns_has space_" + "D".repeat(30)]) {
    expect((await platformWorker.fetch(nativeRequest("/api/v1/apps", malformed), env)).status).toBe(401);
  }
  expect(rp.authenticated.length).toBe(before);
  expect(sharedAuthNativeLane(nativeRequest("/api/v1/apps", token))).toBe("accepted");
  expect(sharedAuthNativeLane(new Request(`${origin}/api/v1/apps`))).toBe("absent");
});

test("general bearers stay refused on the product host, and the browser's login routes take no native session", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const token = await signIn(env);
  for (const path of ["/api/v1/apps", "/api/v1/account/notification-pushers"]) {
    const response = await platformWorker.fetch(new Request(`${origin}${path}`, {
      headers: { authorization: "Bearer tak_pat_or_oauth_token", "cf-connecting-ip": source() },
    }), env);
    expect(response.status, path).toBe(401);
  }
  for (const path of ["/auth/oidc/login", "/auth/oidc/session", "/auth/oidc/logout"]) {
    expect((await platformWorker.fetch(nativeRequest(path, token), env)).status, path).toBe(401);
  }
});

test("an extension never receives the native session header", async () => {
  const rp = fakeRp();
  let forwarded: Request | undefined;
  const env = {
    ...sharedEnv(rp),
    HOSTED_EXTENSION: { fetchAuthenticated: async (value: Request, context: unknown) => {
      forwarded = value;
      return Response.json(context);
    } },
  } as CloudflareWorkerEnv;
  const token = await signIn(env);
  const route = { basePath: "/extensions/hosted", handlerKey: "HOSTED_EXTENSION", authDelivery: "context" as const };
  const response = await handlePlatformExtensionRouteRequest(nativeRequest("/extensions/hosted", token), env, route);
  expect(await response.json()).toMatchObject({ authKind: "session", subject: nativeAccount });
  expect(forwarded?.headers.get(header)).toBeNull();
});

// --- sign-out ----------------------------------------------------------------------

test("signing out revokes the native session at the RP, after which it no longer works", async () => {
  const rp = fakeRp();
  const env = sharedEnv(rp);
  const token = await signIn(env);
  const out = await platformWorker.fetch(nativeRequest("/api/v1/account/session/me", token, { method: "DELETE" }), env);
  expect(out.status).toBe(204);
  expect([...rp.revoked[0]!.headers.keys()].sort()).toEqual([header]);
  expect(rp.sessions.size).toBe(0);
  const after = await platformWorker.fetch(nativeRequest("/api/v1/account/session/me", token), env);
  expect(await after.json()).toEqual({ session: null });
  expect((await platformWorker.fetch(nativeRequest("/api/v1/account/session/me", token, { method: "DELETE" }), env)).status).toBe(401);

  const withoutRevoke = (({ revokeSharedAuthNativeSession: _omit, ...rest }) => rest)(fakeRp()) as SharedAuthRpc;
  expect((await platformWorker.fetch(nativeRequest("/api/v1/account/session/me", token, { method: "DELETE" }), sharedEnv(withoutRevoke))).status).toBe(503);

  // The browser's logout keeps its exact-Origin rule and never calls the native revoke.
  const browserOut = await platformWorker.fetch(new Request(`${origin}/api/v1/account/session/me`, {
    method: "DELETE", headers: { cookie: browserCookie },
  }), env);
  expect(browserOut.status).toBe(403);
  expect(rp.revoked).toHaveLength(2);
});
