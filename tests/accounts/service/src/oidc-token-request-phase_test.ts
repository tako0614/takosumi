import { expect, jest, spyOn, test } from "bun:test";
import { createAccountsHandler, type OidcClientRegistration } from "../../../../accounts/service/src/mod.ts";
import { handleToken } from "../../../../accounts/service/src/oidc-routes.ts";
import { base64UrlEncodeBytes } from "../../../../accounts/service/src/encoding.ts";
import { InMemoryAccountsStore, type AccountsStore } from "../../../../accounts/service/src/store.ts";
import { createRequestPhaseDiagnostics, type RequestPhaseObserver } from "../../../../accounts/service/src/request-phase-diagnostics.ts";

const issuer = "https://issuer.example.test";
const client: OidcClientRegistration = {
  clientId: "private-client-marker", redirectUris: ["https://app.example.test/callback"],
  tokenEndpointAuthMethod: "none", allowedScopes: ["openid", "offline_access"],
};
const phases = ["oidc_token_preconsume", "oidc_token_consume", "oidc_token_live_grant", "oidc_token_issue"] as const;
const flow = { subject: "unused", pairwiseSubjectSecret: "test-secret", issueIdToken: async () => "private-id-token-marker" };
const code = "private-code-marker";
const verifier = "private-verifier-marker";

class ObservedStore extends InMemoryAccountsStore {
  readonly calls: string[] = [];
  beforeConsume?: () => Promise<void>;
  async markAuthorizationCodeConsumed(value: string) {
    this.calls.push("mark");
    return await super.markAuthorizationCodeConsumed(value);
  }
  async saveRefreshToken(...args: Parameters<InMemoryAccountsStore["saveRefreshToken"]>) {
    this.calls.push("refresh");
    return await super.saveRefreshToken(...args);
  }
  async saveAccessToken(...args: Parameters<InMemoryAccountsStore["saveAccessToken"]>) {
    this.calls.push("access");
    return await super.saveAccessToken(...args);
  }
  async linkAccessTokenToAuthCode(...args: Parameters<InMemoryAccountsStore["linkAccessTokenToAuthCode"]>) {
    this.calls.push("link");
    return await super.linkAccessTokenToAuthCode(...args);
  }
}

async function fixture() {
  const store: AccountsStore & { readonly calls: string[]; beforeConsume?: () => Promise<void> } = new ObservedStore();
  const consume = store.consumeAuthorizationCode.bind(store);
  store.consumeAuthorizationCode = async value => {
    store.calls.push("consume");
    await store.beforeConsume?.();
    return await consume(value);
  };
  await store.saveAuthorizationCode(code, {
    clientId: client.clientId, redirectUri: client.redirectUris[0]!, scope: "openid offline_access",
    subject: "private-subject-marker", expiresAt: Date.now() + 60_000,
    codeChallenge: base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))),
    codeChallengeMethod: "S256",
  });
  return store;
}
function request(override: Record<string, string> = {}) {
  return new Request(`${issuer}/oauth/token?private-query-marker=1`, {
    method: "POST", headers: { "cf-ray": "0123456789abcdef-KIX", "x-takosumi-request-probe-id": "0123456789abcdef", cookie: "private-cookie-marker" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.clientId, redirect_uri: client.redirectUris[0]!, code_verifier: verifier, ...override }),
  });
}
function collect() {
  const rows: Record<string, unknown>[] = [];
  const spy = spyOn(console, "info").mockImplementation(value => { if (typeof value === "string") rows.push(JSON.parse(value)); });
  return { rows, spy };
}
async function flush() { for (let i = 0; i < 50; i += 1) await Promise.resolve(); }

// This uses the actual dispatcher, code consume, persistence and no-store response.
test("token dispatcher connects four private phase observations without changing issuance or reuse", async () => {
  const store = await fixture();
  const { rows, spy } = collect();
  const handler = createAccountsHandler({ issuer, store, clients: [client], oidcFlow: flow, requestPhaseDiagnostics: { environment: "staging", enabled: "true" } });
  try {
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { access_token: string; refresh_token: string; id_token: string };
    expect(body.id_token).toBe("private-id-token-marker");
    expect(await store.findAccessToken(body.access_token)).toMatchObject({ clientId: client.clientId, subject: "private-subject-marker" });
    expect(await store.findRefreshToken(body.refresh_token)).toMatchObject({ clientId: client.clientId });
    expect(store.calls).toEqual(["consume", "mark", "refresh", "access", "link"]);
    const tokenRows = rows.filter(row => phases.includes(row.phase as typeof phases[number]));
    expect(tokenRows.map(row => [row.phase, row.outcome])).toEqual(phases.flatMap(phase => [[phase, "started"], [phase, "fulfilled"]]));
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["elapsedMs", "event", "method", "outcome", "phase", "route"]);
      expect(row).toMatchObject({ event: "request_phase", route: "/oauth/token", method: "POST" });
      expect(typeof row.elapsedMs).toBe("number");
    }
    const serialized = JSON.stringify(rows);
    for (const marker of ["0123456789abcdef", "private-query-marker", "private-cookie-marker", "private-client-marker", code, verifier, "private-subject-marker", body.access_token, body.refresh_token, body.id_token]) expect(serialized).not.toContain(marker);
    rows.length = 0;
    const replay = await handler(request());
    expect(replay.status).toBe(400);
    expect(store.calls).toEqual(["consume", "mark", "refresh", "access", "link"]);
    expect(rows.filter(row => phases.includes(row.phase as typeof phases[number])).map(row => row.phase)).toEqual(["oidc_token_preconsume", "oidc_token_preconsume"]);
    expect(await store.findAccessToken(body.access_token)).toBeUndefined();
  } finally { spy.mockRestore(); }
});

test("token consume pending and unknown rejection observe one original operation without issuing or retrying", async () => {
  const store = await fixture();
  let reject!: (error: Error) => void;
  const unknown = new Error("private-unknown-marker");
  store.beforeConsume = () => new Promise((_resolve, fail) => { reject = fail; });
  const factory = createRequestPhaseDiagnostics({ environment: "staging", enabled: "true" });
  const req = request();
  const { rows, spy } = collect();
  jest.useFakeTimers();
  try {
    const result = handleToken({ issuer, request: req, store, flow, clients: new Map([[client.clientId, client]]), diagnostics: factory.forRequest(req) }).catch((error: unknown) => error);
    await flush();
    expect(store.calls).toEqual(["consume"]);
    jest.advanceTimersByTime(2000);
    await flush();
    expect(rows.filter(row => row.phase === "oidc_token_consume").map(row => row.outcome)).toEqual(["started", "pending"]);
    reject(unknown);
    expect(await result).toBe(unknown);
    await flush();
    expect(store.calls).toEqual(["consume"]);
    expect(rows.at(-1)).toMatchObject({ phase: "oidc_token_consume", outcome: "rejected" });
    expect(rows.some(row => row.phase === "oidc_token_issue")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("private-unknown-marker");
    expect(factory.activePendingNotifications).toBe(0);
  } finally { reject?.(unknown); jest.useRealTimers(); spy.mockRestore(); }
});

test("throwing, hanging, repeating or forged token observers cannot alter actual effects or responses", async () => {
  const observers: RequestPhaseObserver[] = [
    { measure: () => { throw new Error("diagnostic failure"); } },
    { measure: async () => { throw new Error("diagnostic failure"); } },
    { measure: () => new Promise<never>(() => {}) },
    { measure: async () => new Response("forged", { status: 201 }) } as unknown as RequestPhaseObserver,
    { measure: async (_phase, completion) => { await completion(); return await completion(); } },
  ];
  for (const diagnostics of observers) {
    const store = await fixture();
    const response = await handleToken({ issuer, request: request(), store, flow, clients: new Map([[client.clientId, client]]), diagnostics });
    expect(response.status).toBe(200);
    expect((await response.json() as { id_token: string }).id_token).toBe("private-id-token-marker");
    expect(store.calls).toEqual(["consume", "mark", "refresh", "access", "link"]);
  }
});

test("token diagnostics remain off outside exact opt-in staging POST route", async () => {
  const { rows, spy } = collect();
  try {
    for (const configuration of [{}, { environment: "staging", enabled: "false" }, { environment: "production", enabled: "true" }]) {
      const store = await fixture();
      const handler = createAccountsHandler({ issuer, store, clients: [client], oidcFlow: flow, requestPhaseDiagnostics: configuration });
      expect((await handler(request())).status).toBe(200);
    }
    const factory = createRequestPhaseDiagnostics({ environment: "staging", enabled: "true" });
    for (const [method, path] of [["GET", "/oauth/token"], ["POST", "/oauth/token/"], ["POST", "/oauth/token/extra"]]) {
      expect(await factory.forRequest(new Request(`${issuer}${path}`, { method })).measure("oidc_token_preconsume", () => "original")).toBe("original");
    }
    expect(rows).toHaveLength(0);
  } finally { spy.mockRestore(); }
});

test("post-consume client resolution pending stays inside live-grant observation and refuses issuance", async () => {
  const store = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  store.findOidcClient = async () => {
    store.calls.push("resolve-client");
    await gate;
    return undefined;
  };
  const req = request();
  const factory = createRequestPhaseDiagnostics({ environment: "staging", enabled: "true" });
  const { rows, spy } = collect();
  jest.useFakeTimers();
  try {
    const pending = handleToken({ issuer, request: req, store, flow, clients: new Map(), diagnostics: factory.forRequest(req) });
    await flush();
    expect(store.calls).toEqual(["consume", "resolve-client"]);
    jest.advanceTimersByTime(2000);
    await flush();
    expect(rows.filter(row => row.phase === "oidc_token_live_grant").map(row => row.outcome)).toEqual(["started", "pending"]);
    expect(rows.some(row => row.phase === "oidc_token_issue")).toBe(false);
    release();
    expect((await pending).status).toBe(400);
    await flush();
    expect(rows.at(-1)).toMatchObject({ phase: "oidc_token_live_grant", outcome: "fulfilled" });
    expect(store.calls).toEqual(["consume", "resolve-client"]);
    expect(factory.activePendingNotifications).toBe(0);
  } finally { release(); jest.useRealTimers(); spy.mockRestore(); }
});

test("refresh preserves its real rotation and is outside authorization-code phases", async () => {
  const store = await fixture();
  const first = await handleToken({ issuer, request: request(), store, flow, clients: new Map([[client.clientId, client]]) });
  const original = await first.json() as { refresh_token: string };
  const req = request({ grant_type: "refresh_token", refresh_token: original.refresh_token });
  const factory = createRequestPhaseDiagnostics({ environment: "staging", enabled: "true" });
  const { rows, spy } = collect();
  try {
    const refreshed = await handleToken({ issuer, request: req, store, flow, clients: new Map([[client.clientId, client]]), diagnostics: factory.forRequest(req) });
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json() as { refresh_token: string };
    expect(body.refresh_token).not.toBe(original.refresh_token);
    expect(await store.findRefreshToken(body.refresh_token)).toMatchObject({ clientId: client.clientId });
    expect(rows).toHaveLength(0);
  } finally { spy.mockRestore(); }
});
