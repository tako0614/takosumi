// takos-secret-scan: synthetic — local OAuth descriptors, accounts and token responses only.
import { expect, spyOn, test } from "bun:test";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { createConnectionOAuthHelpers } from "../../../../core/api/connection_oauth_helpers.ts";
import { connectionOAuthDescriptorsFromEnv } from "../../../../providers/registry.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";

async function fixture(provider: "gcp" | "cloudflare" = "gcp", beforeExchange?: () => Promise<void>) {
  const subject = "tsub_oauth_fixture";
  const sessionId = "session_oauth_fixture";
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({ subject, createdAt: now, updatedAt: now });
  store.saveAccountSession({ sessionId, subject, createdAt: now, expiresAt: now + 60_000 });
  const exchanges: URLSearchParams[] = [];
  const creates: { subject?: string; owner?: string }[] = [];
  const helpers = createConnectionOAuthHelpers({
    stateSecret: "isolated-connection-oauth-state-secret",
    descriptors: connectionOAuthDescriptorsFromEnv({
      TAKOSUMI_GCP_OAUTH_CLIENT_ID: "fixture-gcp",
      TAKOSUMI_GCP_OAUTH_REDIRECT_URI: "https://app.example.test/api/v1/connections/oauth/gcp/callback",
      TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID: "fixture-cloudflare",
      TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI: "https://app.example.test/api/v1/connections/oauth/cloudflare/callback",
    }),
  }, (async (_input, init) => {
    exchanges.push(new URLSearchParams(String(init?.body ?? "")));
    await beforeExchange?.();
    return Response.json({ refresh_token: "SYNTHETIC_REFRESH", access_token: "SYNTHETIC_ACCESS", expires_in: 3600 });
  }) as typeof fetch);
  const service = await createTakosumiService({
    authorizeInterfaceBearer: () => undefined,
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test" },
    connectionOAuthHelpers: helpers,
  });
  const operations: ControlPlaneOperations = {
    ...service.operations,
    createConnection: async (body, _authority, actor) => {
      creates.push({ subject: actor ?? undefined, owner: body.ownerAccountId });
      return { connection: { id: "conn_oauth_fixture", provider: "fixture", providerSource: "registry.opentofu.org/fixture/provider", scope: body.scope ?? "personal", status: "pending", materialization: "env", envNames: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } };
    },
    testConnection: async () => ({ status: "verified" }),
  };
  const dispatch = async (path: string, init?: RequestInit) => {
    const request = new Request(`https://app.example.test${path}`, init);
    const response = await handleControlRoute({ request, url: new URL(request.url), store, operations });
    if (!response) throw new Error("OAuth fixture route is missing");
    return response;
  };
  const start = async (workspaceScoped = false) => {
    const response = await dispatch(`/api/v1/connections/oauth/${provider}/start`, {
      method: "POST", headers: { cookie: `takosumi_session=${sessionId}`, origin: "https://app.example.test", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Fixture connection", ...(workspaceScoped ? { workspaceId: "ignored-legacy-workspace" } : {}) }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { state: string; authorizationUrl: string; expiresAt: string };
    return { response, result, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const callback = (state: string, cookie?: string, helperId = provider) => dispatch(
    `/api/v1/connections/oauth/${helperId}/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
    cookie ? { headers: { cookie } } : undefined,
  );
  return { start, callback, dispatch, exchanges, creates, subject, store, operations };
}

test("GCP Connection OAuth start binds the browser and supplies S256 PKCE", async () => {
  const f = await fixture();
  const started = await f.start();
  expect(started.cookie).toMatch(/^__Host-takosumi_oauth_[a-f0-9]+=.+$/u);
  expect(started.response.headers.get("set-cookie")).toContain("Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure");
  expect(started.response.headers.get("cache-control")).toBe("no-store");
  expect(new URL(started.result.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
  expect(f.exchanges).toHaveLength(0);
  expect(f.creates).toHaveLength(0);
});

for (const browser of ["missing", "different"] as const) {
  test(`GCP Connection OAuth ${browser} browser refuses before exchange and creation`, async () => {
    const f = await fixture();
    const started = await f.start();
    const response = await f.callback(started.result.state,
      browser === "different" ? "__Host-takosumi_oauth_unrelated=1" : undefined);
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.get("connection_error")).toBe("oauth_failed");
    expect(f.exchanges).toHaveLength(0);
    expect(f.creates).toHaveLength(0);
  });
}

test("GCP Connection OAuth same browser exchanges the matching verifier and signed owner", async () => {
  const f = await fixture();
  const started = await f.start();
  const response = await f.callback(started.result.state, started.cookie);
  expect(response.status).toBe(303);
  expect(new URL(response.headers.get("location")!).searchParams.get("connected")).toBe("1");
  expect(f.exchanges).toHaveLength(1);
  const verifier = f.exchanges[0]!.get("code_verifier");
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier!))).toString("base64url");
  expect(new URL(started.result.authorizationUrl).searchParams.get("code_challenge")).toBe(challenge);
  expect(f.creates).toEqual([{ subject: f.subject, owner: f.subject }]);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("location")).not.toContain("SYNTHETIC");
});

test("Cloudflare Connection OAuth retains missing-browser refusal", async () => {
  const f = await fixture("cloudflare");
  const started = await f.start();
  const response = await f.callback(started.result.state);
  expect(new URL(response.headers.get("location")!).searchParams.get("connection_error")).toBe("oauth_failed");
  expect(f.exchanges).toHaveLength(0);
  expect(f.creates).toHaveLength(0);
});


test("Connection OAuth same-input same-tick starts have independent signed states", async () => {
  const f = await fixture();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    const [first, second] = await Promise.all([f.start(), f.start()]);
    expect(first.result.state).not.toBe(second.result.state);
    expect(first.cookie).not.toBe(second.cookie);
  } finally {
    clock.mockRestore();
  }
});

test("Connection OAuth sequential and concurrent callbacks consume one server attempt", async () => {
  for (const concurrent of [false, true]) {
    const f = await fixture();
    const started = await f.start();
    const first = f.callback(started.result.state, started.cookie);
    const responses = concurrent
      ? await Promise.all([first, f.callback(started.result.state, started.cookie)])
      : [await first, await f.callback(started.result.state, started.cookie)];
    expect(responses.map((r) => new URL(r.headers.get("location")!).searchParams.get("connected"))).toContain("1");
    expect(responses.filter((r) => new URL(r.headers.get("location")!).searchParams.get("connection_error") === "oauth_failed")).toHaveLength(1);
    expect(f.exchanges).toHaveLength(1);
    expect(f.creates).toHaveLength(1);
  }
});


for (const rejection of ["forged", "expired", "helper", "account", "store"] as const) {
  test(`Connection OAuth ${rejection} callback refuses before exchange`, async () => {
    const f = await fixture();
    const started = await f.start();
    let clock: { mockRestore(): unknown } | undefined;
    try {
      if (rejection === "expired") clock = spyOn(Date, "now").mockReturnValue(Date.parse(started.result.expiresAt));
      if (rejection === "account") f.store.findAccount = () => undefined;
      if (rejection === "store") Object.defineProperty(f.store, "consumeConnectionOAuthAttempt", { value: undefined });
      const response = await f.callback(
        rejection === "forged" ? `${started.result.state}x` : started.result.state,
        started.cookie, rejection === "helper" ? "cloudflare" : "gcp",
      );
      expect(new URL(response.headers.get("location")!).searchParams.get("connection_error")).toBe("oauth_failed");
      expect(f.exchanges).toHaveLength(0);
      expect(f.creates).toHaveLength(0);
    } finally {
      clock?.mockRestore();
    }
  });
}

test("Connection OAuth missing browser does not burn the legitimate browser attempt", async () => {
  const f = await fixture();
  const started = await f.start();
  await f.callback(started.result.state);
  expect(f.exchanges).toHaveLength(0);
  const response = await f.callback(started.result.state, started.cookie);
  expect(new URL(response.headers.get("location")!).searchParams.get("connected")).toBe("1");
  expect(f.exchanges).toHaveLength(1);
  expect(f.creates).toHaveLength(1);
});

test("Connection OAuth consume and exchange failures cannot resurrect an attempt", async () => {
  for (const failure of ["exchange", "create", "completion"] as const) {
    const f = await fixture("gcp", failure === "exchange" ? async () => { throw new Error("synthetic exchange failure"); } : undefined);
    const started = await f.start();
    if (failure === "create") f.operations.createConnection = async () => { throw new Error("synthetic create failure"); };
    if (failure === "completion") {
      const helper = f.operations.connectionOAuth!.gcp!;
      const complete = helper.complete;
      helper.complete = async (input) => ({ ...await complete(input), subject: "tsub_other" });
    }
    for (let i = 0; i < 2; i++) {
      const response = await f.callback(started.result.state, started.cookie);
      expect(new URL(response.headers.get("location")!).searchParams.get("connection_error")).toBe("oauth_failed");
    }
    expect(f.exchanges).toHaveLength(1);
    expect(f.creates).toHaveLength(0);
  }
});

test("Connection OAuth start refuses missing or failed attempt persistence", async () => {
  for (const failure of ["missing", "conflict", "exception"] as const) {
    const f = await fixture();
    if (failure === "missing") Object.defineProperty(f.store, "createConnectionOAuthAttempt", { value: undefined });
    else f.store.createConnectionOAuthAttempt = failure === "conflict" ? async () => false : async () => { throw new Error("synthetic store failure"); };
    const response = await f.dispatch("/api/v1/connections/oauth/gcp/start", {
      method: "POST", headers: { cookie: "takosumi_session=session_oauth_fixture", origin: "https://app.example.test", "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toContain("authorizationUrl");
    expect(f.exchanges).toHaveLength(0);
    expect(f.creates).toHaveLength(0);
  }
});

test("Connection OAuth Workspace admission is current before exchange and fenced again after exchange", async () => {
  for (const denied of ["none", "before", "after"] as const) {
    let captures = 0;
    let unavailable = false;
    const f = await fixture("gcp", async () => { unavailable = true; });
    const originalCapture = f.operations.workspaces.captureManagementAuthority;
    f.operations.workspaces.captureManagementAuthority = async (...args) => {
      captures++;
      if (denied !== "none" && unavailable) throw new Error("synthetic namespace unavailable");
      return originalCapture.call(f.operations.workspaces, ...args);
    };
    const started = await f.start(true);
    if (denied === "before") unavailable = true;
    const decoded = JSON.parse(Buffer.from(started.result.state.split(".")[0]!, "base64url").toString());
    expect(decoded.body.workspaceId).toBeUndefined();
    expect(decoded.expectedWorkspaceManagementAuthority).toBeUndefined();
    const response = await f.callback(started.result.state, started.cookie);
    expect(new URL(response.headers.get("location")!).searchParams.get(denied !== "none" ? "connection_error" : "connected")).toBe(denied !== "none" ? "oauth_failed" : "1");
    expect(f.exchanges).toHaveLength(denied === "before" ? 0 : 1);
    expect(f.creates).toHaveLength(denied === "none" ? 1 : 0);
    expect(captures).toBe(denied === "before" ? 1 : 2);
    const repeated = await f.callback(started.result.state, started.cookie);
    expect(new URL(repeated.headers.get("location")!).searchParams.get("connection_error")).toBe("oauth_failed");
  }
});
