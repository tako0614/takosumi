import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readOrdinaryAccountAuthenticationGeneration } from "../../../../accounts/service/src/account-authentication-generation.ts";
import { requireAccountsBearer, rotateAccountSession } from "../../../../accounts/service/src/account-session.ts";
import { base64UrlEncodeBytes } from "../../../../accounts/service/src/encoding.ts";
import { createEphemeralAccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { InMemoryAccountsStore, type AccountsStore, type TokenRecord } from "../../../../accounts/service/src/store.ts";

const issuer = "http://localhost:8787";
const clientId = "legacy-password-fixture";
const redirectUri = "app://callback";
const verifier = "v".repeat(43);
const basic = `Basic ${btoa(`${clientId}:isolated-client-credential`)}`;
const subject = "tsub_existing_verified_oidc";
const oldPassword = "violet planets cross a quiet orchard";
const newPassword = "northern rain falls on an old garden";

async function fixture(backend: InMemoryAccountsStore) {
  let atRefreshWrite: ((token: string) => Promise<void>) | undefined;
  const store: AccountsStore = new Proxy(backend, {
    get(target, field) {
      if (field === "saveRefreshToken") return async (id: string, record: TokenRecord) => {
        if (atRefreshWrite) {
          const callback = atRefreshWrite;
          atRefreshWrite = undefined;
          await callback(id);
        }
        target.saveRefreshToken(id, record);
      };
      const value = Reflect.get(target, field);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const handler = await createEphemeralAccountsHandler({ issuer, store, passwordAuthMode: "login", clients: [{
    clientId, clientSecret: "isolated-client-credential", redirectUris: [redirectUri], allowedScopes: ["openid", "offline_access"], tokenEndpointAuthMethod: "client_secret_basic",
  }] });
  const post = (path: string, params: Record<string, string>) => handler(new Request(`${issuer}${path}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic }, body: new URLSearchParams(params),
  }));
  const now = Date.now();
  await store.saveAccount({ subject, email: "verified@example.test", emailVerified: true, createdAt: now, updatedAt: now });
  await store.linkUpstreamIdentity({ subject, providerId: "fixture-oidc", upstreamIssuer: "https://upstream.example.test", upstreamSubject: "verified-account", createdAt: now, updatedAt: now });
  const oauthSession = await rotateAccountSession({ store, subject, now, ttlMs: 60_000 });
  const changePassword = async (cookie: string, password: string, currentPassword?: string) => {
    const response = await handler(new Request(`${issuer}/api/v1/account/sign-in-methods/password`, {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: issuer },
      body: JSON.stringify({ username: "verified-user", password, currentPassword }),
    }));
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const initialCookie = await changePassword(`takosumi_session=${oauthSession.sessionId}`, oldPassword);
  const authorize = async (cookie = initialCookie) => {
    const challenge = base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const url = new URL("/oauth/authorize", issuer);
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid offline_access", code_challenge: challenge, code_challenge_method: "S256" }).toString();
    const response = await handler(new Request(url, { headers: { cookie } }));
    expect(response.status).toBe(302);
    const code = new URL(response.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
    return code!;
  };
  const advanceGeneration = async () => await changePassword(initialCookie, newPassword, oldPassword);
  const exchange = (code: string) => post("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
  const renew = (refresh_token: string) => post("/oauth/token", { grant_type: "refresh_token", refresh_token });
  const inspect = (token: string) => post("/oauth/introspect", { token });
  const userInfo = (token: string) => handler(new Request(`${issuer}/oauth/userinfo`, { headers: { authorization: `Bearer ${token}` } }));
  return { authorize, advanceGeneration, exchange, renew, inspect, userInfo,
    onNextRefreshWrite: (callback: (token: string) => Promise<void>) => { atRefreshWrite = callback; } };
}

test("a password change rejects older ordinary OIDC codes and tokens even if a late write survives the purge", async () => {
  const store = new InMemoryAccountsStore();
  const f = await fixture(store);
  const valid = await f.exchange(await f.authorize());
  expect(valid.status).toBe(200);
  const initial = await valid.json() as { access_token: string; refresh_token: string };
  const pending = await f.authorize();
  const code = store.consumeAuthorizationCode(pending)!;
  const access = store.findAccessToken(initial.access_token)!;
  const refresh = store.findRefreshToken(initial.refresh_token)!;
  for (const record of [code, access, refresh]) expect(record.identityGeneration).toBeUndefined();
  store.deleteToken(initial.access_token);
  store.deleteToken(initial.refresh_token);
  const freshCookie = await f.advanceGeneration();
  // These rows represent writes from older work that reached storage after the credential change's purge.
  store.saveAuthorizationCode(pending, code);
  store.saveAccessToken(initial.access_token, access);
  store.saveRefreshToken(initial.refresh_token, refresh);
  expect((await f.exchange(pending)).status).toBe(400);
  expect((await f.renew(initial.refresh_token)).status).toBe(400);
  expect(await (await f.inspect(initial.refresh_token)).json()).toEqual({ active: false });
  expect((await f.userInfo(initial.access_token)).status).toBe(401);
  const current = await f.exchange(await f.authorize(freshCookie));
  expect(current.status).toBe(200);
  const next = await current.json() as { access_token: string; refresh_token: string };
  expect(store.findAccessToken(next.access_token)?.identityGeneration).toBe(1);
  expect(store.findRefreshToken(next.refresh_token)?.identityGeneration).toBe(1);
  expect((await f.userInfo(next.access_token)).status).toBe(200);
  expect((await f.renew(next.refresh_token)).status).toBe(200);
});

test("an ordinary OIDC refresh already past its lookup cannot issue credentials after password change", async () => {
  const backend = new InMemoryAccountsStore();
  let child: string | undefined;
  const f = await fixture(backend);
  const issued = await f.exchange(await f.authorize());
  expect(issued.status).toBe(200);
  const initial = await issued.json() as { refresh_token: string };
  f.onNextRefreshWrite(async (id) => {
    child = id;
    backend.deleteToken(initial.refresh_token);
    await f.advanceGeneration();
  });
  const response = await f.renew(initial.refresh_token);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_grant" });
  expect(child).toBeTruthy();
  expect(backend.findRefreshToken(child!)).toBeUndefined();
});

test("ordinary PostgreSQL retains the authentication generation without requiring metadata at generation zero", async () => {
  const pg = new PGlite();
  const store = new PostgresAccountsStore({ queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({ rows: (await pg.query(sql, [...args])).rows as T[] }) });
  try {
    await pg.exec(`CREATE SCHEMA accounts_v1;
      CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY);
      CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY, subject text, created_at timestamptz, expires_at timestamptz);
      CREATE TABLE accounts_v1.personal_access_tokens(token_hash text PRIMARY KEY,token_id text,token_prefix text,subject text,name text,scopes jsonb,workspace_id text,app_ids jsonb,created_at timestamptz,expires_at timestamptz,revoked_at timestamptz,last_used_at timestamptz);
      CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text,capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
      CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text,capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
      CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);`);
    const record = { clientId, scope: "openid offline_access", subject, takosumiSubject: subject, expiresAt: Date.now() + 60_000 };
    expect(await readOrdinaryAccountAuthenticationGeneration(store, subject)).toBe(0);
    await store.saveAuthorizationCode("old-code", { ...record, redirectUri, identityGeneration: 0 });
    await store.saveAccessToken("old-access", record);
    await store.saveRefreshToken("old-refresh", record);
    expect((await store.consumeAuthorizationCode("old-code"))?.identityGeneration).toBeUndefined();
    expect((await store.findAccessToken("old-access"))?.identityGeneration).toBeUndefined();
    expect((await store.findRefreshToken("old-refresh"))?.identityGeneration).toBeUndefined();
    expect((await store.resolveAccountsBearerCandidates("old-access")).accessAuthenticationGeneration).toBe(0);
    await store.saveAccountSession({ sessionId: "sess_pre_generation", subject, createdAt: Date.now(), expiresAt: record.expiresAt });
    expect((await store.resolveAccountsBearerCandidates("sess_pre_generation")).sessionAuthenticationGeneration).toBe(0);
    await pg.exec(`ALTER TABLE accounts_v1.authorization_codes ADD COLUMN hosted_metadata jsonb;
      ALTER TABLE accounts_v1.oauth_access_tokens ADD COLUMN hosted_metadata jsonb;
      ALTER TABLE accounts_v1.oauth_refresh_tokens ADD COLUMN hosted_metadata jsonb;
      CREATE TABLE accounts_v1.hosted_identity_records(bucket text,key text,document jsonb,PRIMARY KEY(bucket,key));
      INSERT INTO accounts_v1.hosted_identity_records VALUES('authentication_generations','${subject}', '{"generation":1}');`);
    expect(await readOrdinaryAccountAuthenticationGeneration(store, subject)).toBe(1);
    const current = { ...record, identityGeneration: 1 };
    await store.saveAuthorizationCode("new-code", { ...current, redirectUri });
    await store.saveAccessToken("new-access", current);
    await store.saveRefreshToken("new-refresh", current);
    for (const row of [await store.consumeAuthorizationCode("new-code"), await store.findAccessToken("new-access"), await store.findRefreshToken("new-refresh")]) {
      expect(row?.identityGeneration).toBe(1);
      expect(row?.oidcProfile).toBeUndefined();
    }
    expect((await store.resolveAccountsBearerCandidates("sess_pre_generation")).sessionAuthenticationGeneration).toBe(1);
    expect((await store.resolveAccountsBearerCandidates("old-access")).accessAuthenticationGeneration).toBe(1);
    const stale = await requireAccountsBearer({ request: new Request(`${issuer}/protected`, { headers: { authorization: "Bearer old-access" } }), store, scope: "read" });
    expect(stale.ok).toBe(false);
  } finally { await pg.close(); }
});
