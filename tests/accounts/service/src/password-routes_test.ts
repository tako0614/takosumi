import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { createEphemeralAccountsHandler, type AccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";

const issuer = "http://localhost:8787";
const login = "/api/v1/auth/password/login";
const methods = "/api/v1/account/sign-in-methods";
const password = "stapled green mountains in winter";
const replacement = "a blue telescope in the courtyard";

function client(handler: AccountsHandler, base = issuer) {
  return (path: string, json?: Record<string, unknown>, cookie?: string, origin = base) =>
    handler(new Request(base + path, {
      headers: { ...(cookie ? { cookie } : {}), ...(json ? { origin, "content-type": "application/json" } : {}) },
      ...(json ? { method: "POST", body: JSON.stringify(json) } : {}),
    }));
}

const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;

function seed(store: InMemoryAccountsStore, options: { age?: number; verified?: boolean; email?: string } = {}) {
  const subject = "tsub_existing_oauth";
  const now = Date.now();
  const account = {
    subject, email: options.email ?? "allowed@example.test", emailVerified: options.verified ?? true,
    displayName: "Existing", createdAt: now, updatedAt: now,
  } as const;
  store.saveAccount(account);
  store.linkUpstreamIdentity({
    providerId: "google", upstreamIssuer: "https://accounts.google.com", upstreamSubject: "fixture-user",
    subject, createdAt: now, updatedAt: now,
  });
  store.saveAccountSession({
    subject, sessionId: "sess_from_oauth", createdAt: now - (options.age ?? 0),
    expiresAt: now + 60_000,
  });
  return { account, subject, cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_from_oauth` };
}

test("password login is opt-in; no public sign-up or recovery is exposed", async () => {
  const store = new InMemoryAccountsStore();
  const disabled = client(await createEphemeralAccountsHandler({ issuer, store }));
  expect((await disabled(login, { email: "user@example.test", password })).status).toBe(404);
  expect(await (await disabled("/api/v1/auth/providers")).json()).not.toHaveProperty("password");
  const enabled = client(await createEphemeralAccountsHandler({ issuer, store, passwordAuthMode: "login" }));
  expect(await (await enabled("/api/v1/auth/providers")).json()).toMatchObject({ password: { enabled: true } });
  for (const path of ["/api/v1/auth/password/register", "/api/v1/auth/password/recover", methods + "/oauth"]) {
    expect((await enabled(path, {})).ok).toBe(false);
  }
  const insecure = "http://example.test";
  const other = client(await createEphemeralAccountsHandler({ issuer: insecure, store, passwordAuthMode: "login" }), insecure);
  expect(await (await other("/api/v1/auth/providers")).json()).not.toHaveProperty("password");
  expect((await other(login, { email: "user@example.test", password })).status).toBe(404);
});

test("OAuth and password sign in to the same account; a change revokes prior sessions", async () => {
  const store = new InMemoryAccountsStore();
  const request = client(await createEphemeralAccountsHandler({
    issuer, store, passwordAuthMode: "login",
    loginEmailAllowlist: { emails: ["allowed@example.test"], requireVerifiedEmail: true },
  }));
  const { account, subject, cookie } = seed(store);
  expect(await (await request(methods, undefined, cookie)).json()).toEqual({
    passwordEnabled: true, email: account.email, hasPassword: false, canSetPassword: true,
  });
  expect((await request(methods + "/password", { password }, cookie, "https://other.example.test")).status).toBe(403);
  expect((await request(methods + "/password", { password })).status).toBe(401);
  const added = await request(methods + "/password", { password, email: "other@example.test" }, cookie);
  expect(added.status).toBe(200);
  expect(await added.json()).toEqual({ subject });
  expect(await store.findAccount(subject)).toEqual(account);
  expect((await store.passwordAuth.findBySubject(subject))?.passwordHash).toMatch(/^argon2id:v19:m19456:t2:p1:[a-f0-9]{32}:[a-f0-9]{64}$/u);
  expect((await request(login, { email: "other@example.test", password })).status).toBe(401);
  const signedIn = await request(login, { email: "ALLOWED@example.test", password });
  expect(signedIn.status).toBe(200);
  expect(signedIn.headers.get("set-cookie")).toContain("HttpOnly");
  expect(signedIn.headers.get("cache-control")).toBe("no-store");
  expect(await (await request("/api/v1/account/session/me", undefined, cookieOf(signedIn))).json()).toMatchObject({ subject });
  const changed = await request(methods + "/password", { currentPassword: password, password: replacement }, cookieOf(added));
  expect(changed.status).toBe(200);
  expect((await request(methods, undefined, cookieOf(signedIn))).status).toBe(401);
  expect((await request(login, { email: account.email, password })).status).toBe(401);
  expect(await (await request(login, { email: account.email, password: replacement })).json()).toEqual({ subject });
  expect((await request(methods + "/password", { currentPassword: replacement, password }, cookieOf(changed))).status).toBe(200);
});

test("an old OAuth session or an unverified or ambiguous address cannot add a password", async () => {
  for (const mode of ["stale", "unverified", "duplicate"] as const) {
    const store = new InMemoryAccountsStore();
    const request = client(await createEphemeralAccountsHandler({ issuer, store, passwordAuthMode: "login" }));
    const { account, cookie, subject } = seed(store, {
      age: mode === "stale" ? 600_000 : 0,
      verified: mode !== "unverified",
    });
    if (mode === "duplicate") store.saveAccount({ ...account, subject: "tsub_ambiguous" });
    expect((await request(methods + "/password", { password }, cookie)).status).toBe(403);
    expect(await store.passwordAuth.findBySubject(subject)).toBeUndefined();
    expect((await request(login, { email: account.email, password })).status).toBe(401);
  }
});

test("password attempts share a durable case-insensitive email limit across handler instances", async () => {
  const store = new InMemoryAccountsStore();
  const a = client(await createEphemeralAccountsHandler({ issuer, store, passwordAuthMode: "login" }));
  const b = client(await createEphemeralAccountsHandler({ issuer, store, passwordAuthMode: "login" }));
  for (let i = 0; i < 12; i++) {
    const input = { email: i % 2 ? "UNKNOWN@EXAMPLE.TEST" : "unknown@example.test", password: "short" };
    expect((await (i % 2 ? a : b)(login, input)).status).toBe(401);
  }
  const denied = await b(login, { email: "unknown@example.test", password });
  expect(denied.status).toBe(429);
  expect(denied.headers.has("retry-after")).toBe(true);
});

test("the Worker browser bundle can set and verify a password natively", async () => {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../../fixtures/password-auth-workerd.ts", import.meta.url))],
    target: "browser", format: "esm",
  });
  expect(built.success).toBe(true);
  const worker = new Miniflare({
    compatibilityDate: "2026-04-01", compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "password-auth-workerd.mjs", contents: await built.outputs[0]!.text() }],
  });
  const call = (path: string, data: object, cookie?: string) => worker.dispatchFetch("http://localhost" + path, {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(data),
  });
  try {
    const set = await call(methods + "/password", { password }, "takosumi_session=sess_worker_fixture");
    expect(set.status).toBe(200);
    const signed = await call(login, { email: "worker-fixture@example.test", password });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ subject: "tsub_worker_password_fixture" });
  } finally {
    await worker.dispose();
  }
}, 20_000);
