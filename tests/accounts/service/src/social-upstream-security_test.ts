import { acceptIsolatedIdentityContexts, isolatedContextReconciler } from "../fixtures/identity-context-fixture.ts";
import { expect, test } from "bun:test";
import { exchangeUpstreamAuthorizationCode } from "../../../../accounts/service/src/upstream.ts";
import { verifiedSocialOAuthProvider } from "../../../../accounts/service/src/upstream-verification.ts";
import { base64UrlEncodeBytes, base64UrlEncodeJson, sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { resolveUpstreamAccount } from "../../../../accounts/service/src/identity.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { handleUpstreamAuthorizeRequest, handleUpstreamCallbackRequest } from "../../../../accounts/service/src/upstream-oauth-routes.ts";
import { upstreamOAuthOptionsFromEnvironment, UPSTREAM_PROVIDER_DESCRIPTORS_ENV, UPSTREAM_SUBJECT_SECRET_ENV } from "../../../../accounts/service/src/upstream-config.ts";
import { handleUpstreamOperationProofBeginRequest } from "../../../../accounts/service/src/upstream-operation-proof.ts";
import { handleCredentialUnlinkIntentRequest } from "../../../../accounts/service/src/identity-unlink.ts";
import { handleUpstreamUnlinkProofBeginRequest } from "../../../../accounts/service/src/upstream-unlink-proof.ts";
import { handleIdentityMergeRequest } from "../../../../accounts/service/src/identity-merge.ts";
import { rotateAccountSession, handleHostedGlobalLogout } from "../../../../accounts/service/src/account-session.ts";
import { createEphemeralAccountsHandler, type AccountsHandler, type UpstreamOAuthOptions } from "../../../../accounts/service/src/mod.ts";

const now = Date.now();
const google = verifiedSocialOAuthProvider({ id: "social-google", profile: "google-oidc" });
const github = verifiedSocialOAuthProvider({ id: "social-github", profile: "github-oauth" });
const keys = crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

async function signedGoogleToken(overrides: Record<string, unknown> = {}, nonce = "server-nonce") {
  const pair = await keys;
  const claims = {
    iss: "https://accounts.google.com",
    sub: "google-stable-subject",
    aud: "social-client",
    nonce,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 300,
    email: "person@gmail.com",
    email_verified: true,
    ...overrides,
  };
  const input = `${base64UrlEncodeJson({ alg: "RS256", kid: "fixture-key" })}.${base64UrlEncodeJson(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function googleFetch(token: string, user: Record<string, unknown> = { sub: "google-stable-subject" }): Promise<typeof fetch> {
  const pair = await keys;
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "fixture-key", alg: "RS256", use: "sig" };
  return (async (input, init) => {
    const request = new Request(input, init);
    if (request.url === google.tokenEndpoint) return Response.json({ access_token: "fixture-upstream-access", token_type: "Bearer", id_token: token });
    if (request.url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    if (request.url === google.userInfoEndpoint) return Response.json(user);
    throw new Error("unexpected fixture URL");
  }) as typeof fetch;
}

async function googleExchange(token: string, user?: Record<string, unknown>) {
  return exchangeUpstreamAuthorizationCode({ provider: google, clientId: "social-client", redirectUri: "https://auth.example.test/callback", code: "fixture-code", codeVerifier: "v".repeat(43), nonce: "server-nonce", subjectSecret: "fixture-subject-secret", now, fetch: await googleFetch(token, user) });
}

test("Google signed ID token binds immutable identity and proof address", async () => {
  const result = await googleExchange(await signedGoogleToken());
  expect(result.upstreamSubject).toBe("google-stable-subject");
  expect(result.upstreamIssuer).toBe("https://accounts.google.com");
  expect(result.profile?.emailProof).toMatchObject({ address: "person@gmail.com", authoritative: true, upstreamSubject: "google-stable-subject", observedAt: now, validUntil: now + 300_000 });
});

for (const [label, claims] of [
  ["audience", { aud: "attacker-client" }],
  ["issuer", { iss: "https://attacker.example.test" }],
  ["authorized presenter", { azp: "other-client" }],
  ["nonce", { nonce: "other-browser" }],
  ["expiry", { exp: Math.floor(now / 1000) - 61 }],
  ["future issuance", { iat: Math.floor(now / 1000) + 61 }],
  ["missing subject", { sub: undefined }],
  ["numeric subject", { sub: 123 }],
  ["empty subject", { sub: "" }],
] as const) {
  test(`Google rejects ${label}`, async () => {
    await expect(googleExchange(await signedGoogleToken(claims))).rejects.toThrow();
  });
}

test("Google rejects a forged signature and subject-mismatched UserInfo", async () => {
  const token = await signedGoogleToken();
  const parts = token.split(".");
  const forged = `${parts[0]}.${base64UrlEncodeJson({ iss: "https://accounts.google.com", sub: "attacker" })}.${parts[2]}`;
  await expect(googleExchange(forged)).rejects.toThrow("signature");
  await expect(googleExchange(token, { sub: "other-subject" })).rejects.toThrow("subject");
});

test("Google non-hosted email proof is non-authoritative and unbound UserInfo cannot verify it", async () => {
  const result = await googleExchange(await signedGoogleToken({ email: "old-mailbox@third-party.test" }));
  expect(result.profile?.emailVerified).toBe(true);
  expect(result.profile?.emailProof?.authoritative).toBe(false);
  const absent = await googleExchange(await signedGoogleToken({ email: undefined, email_verified: undefined }), { sub: "google-stable-subject", email: "attacker@gmail.com", email_verified: true });
  expect(absent.profile?.email).toBeUndefined();
  expect(absent.profile?.emailProof).toBeUndefined();
});

function githubFetch(input: {
  user?: Record<string, unknown>;
  pages: unknown[][];
  maliciousNext?: string;
  requests?: Request[];
}): typeof fetch {
  return (async (value, init) => {
    const request = new Request(value, init);
    input.requests?.push(request);
    if (request.url === github.tokenEndpoint) return Response.json({ access_token: "fixture-private-access", token_type: "bearer" });
    expect(request.headers.get("authorization")).toBe("Bearer fixture-private-access");
    if (request.url === github.userInfoEndpoint) return Response.json(input.user ?? { id: 4711, email: "public-unverified@example.test", login: "fixture" });
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe("https://api.github.com/user/emails");
    const page = Number(url.searchParams.get("page"));
    return Response.json(input.pages[page - 1], { headers: input.maliciousNext || page < input.pages.length
      ? { link: `<${input.maliciousNext ?? `https://api.github.com/user/emails?per_page=100&page=${page + 1}`}>; rel="next"` }
      : {} });
  }) as typeof fetch;
}

function githubExchange(fetch: typeof fetch) {
  return exchangeUpstreamAuthorizationCode({ provider: github, clientId: "social-client", redirectUri: "https://auth.example.test/callback", code: "fixture-code", codeVerifier: "v".repeat(43), subjectSecret: "fixture-subject-secret", now, fetch });
}

test("GitHub uses private verified primary email over public /user email across bounded pages", async () => {
  const requests: Request[] = [];
  const result = await githubExchange(githubFetch({ pages: [[{ email: "other@example.test", verified: true, primary: false, visibility: "public" }], [{ email: "private@example.test", verified: true, primary: true, visibility: null }]], requests }));
  expect(result.upstreamSubject).toBe("4711");
  expect(result.profile?.email).toBe("private@example.test");
  expect(result.profile?.emailVerified).toBe(true);
  expect(requests).toHaveLength(4);
});

test("GitHub unverified primary or non-primary email cannot become email proof", async () => {
  for (const emails of [[], [{ email: "public-unverified@example.test", verified: false, primary: true }], [{ email: "alternate@example.test", verified: true, primary: false }]]) {
    const result = await githubExchange(githubFetch({ pages: [emails] }));
    expect(result.profile?.email).toBeUndefined();
    expect(result.profile?.emailVerified).toBeUndefined();
    expect(result.profile?.emailProof).toBeUndefined();
  }
});

test("GitHub rejects non-numeric IDs, conflicting primary inventory and arbitrary pagination origins", async () => {
  await expect(githubExchange(githubFetch({ user: { id: "4711" }, pages: [[]] }))).rejects.toThrow();
  await expect(githubExchange(githubFetch({ pages: [[{ email: "a@test.example", primary: true, verified: true }, { email: "b@test.example", primary: true, verified: true }]] }))).rejects.toThrow();
  await expect(githubExchange(githubFetch({ pages: [[]], maliciousNext: "https://attacker.example.test/steal" }))).rejects.toThrow();
});

test("upstream responses and redirect attempts are bounded", async () => {
  const oversize = (async () => new Response("x".repeat(128 * 1024 + 1))) as typeof fetch;
  await expect(githubExchange(oversize)).rejects.toThrow("limit");
  const redirected = (async (_input, init) => {
    expect(init?.redirect).toBe("manual");
    return new Response(null, { status: 302, headers: { location: "https://attacker.example.test" } });
  }) as typeof fetch;
  await expect(githubExchange(redirected)).rejects.toThrow();
});

function hostedOptions(fetch: typeof fetch, provider = github): UpstreamOAuthOptions {
  return { subjectSecret: "fixture-subject-secret", hostedSessionPolicy: true, fetch, providers: [{ providerId: provider.id, clientId: "social-client", redirectUri: "https://auth.example.test/oauth/upstream/callback", provider }] };
}

async function startHostedFlow(store: InMemoryAccountsStore, options: UpstreamOAuthOptions, extra = "") {
  const response = await handleUpstreamAuthorizeRequest({ url: new URL(`https://auth.example.test/oauth/upstream/authorize?provider=${options.providers[0]!.providerId}${extra}`), store, upstreamOAuth: options, secureCookie: true });
  const location = response.headers.get("location");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return { response, authorization: location ? new URL(location) : undefined, cookie };
}

test("hosted upstream callback consumes browser-bound server PKCE transaction and rejects replay", async () => {
  const store = new InMemoryAccountsStore();
  const requests: Request[] = [];
  const options = hostedOptions(githubFetch({ pages: [[{ email: "private@example.test", primary: true, verified: true }]], requests }));
  const flow = await startHostedFlow(store, options, "&code_challenge=attacker&code_challenge_method=plain");
  expect(flow.response.status).toBe(302);
  expect(flow.authorization?.searchParams.get("code_challenge_method")).toBe("S256");
  expect(flow.authorization?.searchParams.get("code_challenge")).not.toBe("attacker");
  expect(flow.response.headers.get("set-cookie")).toContain("__Host-takosumi_upstream=");
  expect(flow.response.headers.get("set-cookie")).toContain("Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300");
  const callback = new URL(`https://auth.example.test/oauth/upstream/callback?provider=${github.id}&state=${flow.authorization!.searchParams.get("state")}&code=fixture-code&code_verifier=attacker`);
  const request = new Request(callback, { headers: { cookie: flow.cookie! } });
  const first = await handleUpstreamCallbackRequest({ request, url: callback, store, upstreamOAuth: options, secureCookie: true });
  expect(first.status).toBe(200);
  expect(first.headers.get("set-cookie")).toContain("__Host-takosumi_session=");
  expect(await first.clone().text()).not.toContain("sess_");
  const verifier = new URLSearchParams(await requests[0]!.text()).get("code_verifier");
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect((await sha256Text(verifier!)).slice(7)).toBe(flow.authorization!.searchParams.get("code_challenge"));
  const replay = await handleUpstreamCallbackRequest({ request, url: callback, store, upstreamOAuth: options, secureCookie: true });
  expect(replay.status).toBe(400);
  expect(requests).toHaveLength(3);
});

test("hosted upstream transaction rejects stolen state without browser binding and wrong provider", async () => {
  const store = new InMemoryAccountsStore();
  const options = hostedOptions(githubFetch({ pages: [[]] }));
  const flow = await startHostedFlow(store, options);
  const url = new URL(`https://auth.example.test/oauth/upstream/callback?provider=${github.id}&state=${flow.authorization!.searchParams.get("state")}&code=fixture-code`);
  const response = await handleUpstreamCallbackRequest({ request: new Request(url), url, store, upstreamOAuth: options, secureCookie: true });
  expect(response.status).toBe(400);
  const forged = new Request(url, { headers: { cookie: flow.cookie!.replace(/social-github/u, "other-provider") } });
  expect((await handleUpstreamCallbackRequest({ request: forged, url, store, upstreamOAuth: options, secureCookie: true })).status).toBe(400);
});

test("hosted Google callback verifies server nonce end-to-end", async () => {
  const store = new InMemoryAccountsStore();
  let options = hostedOptions(githubFetch({ pages: [[]] }), google);
  const flow = await startHostedFlow(store, options);
  const nonce = flow.authorization!.searchParams.get("nonce")!;
  options = { ...options, fetch: await googleFetch(await signedGoogleToken({}, nonce)) };
  const url = new URL(`https://auth.example.test/oauth/upstream/callback?provider=${google.id}&state=${flow.authorization!.searchParams.get("state")}&code=fixture-code`);
  const response = await handleUpstreamCallbackRequest({ request: new Request(url, { headers: { cookie: flow.cookie! } }), url, store, upstreamOAuth: options, secureCookie: true });
  expect(response.status).toBe(200);
});

test("hosted rejects unsafe callbacks, generic unchecked providers, offline scopes and false GitHub freshness", async () => {
  const store = new InMemoryAccountsStore();
  const options = hostedOptions(githubFetch({ pages: [[]] }));
  const external = { ...options, providers: [{ ...options.providers[0]!, redirectUri: "https://attacker.example.test/callback" }] };
  expect((await startHostedFlow(store, external)).response.status).toBe(503);
  const generic = { ...options, providers: [{ ...options.providers[0]!, provider: { ...github, verificationProfile: undefined } }] };
  expect((await startHostedFlow(store, generic)).response.status).toBe(503);
  const offline = { ...options, providers: [{ ...options.providers[0]!, scopes: ["user:email", "offline_access"] }] };
  expect((await startHostedFlow(store, offline)).response.status).toBe(503);
  expect((await startHostedFlow(store, options, "&prompt=login")).response.status).toBe(400);
});

test("explicit social descriptor selects verification while generic IDs preserve self-host policy", () => {
  const descriptor = { providerId: google.id, verificationProfile: "google-oidc", issuer: google.issuer, authorizationEndpoint: google.authorizationEndpoint, tokenEndpoint: google.tokenEndpoint, userInfoEndpoint: google.userInfoEndpoint, clientId: "social-client", redirectUri: "https://auth.example.test/callback" };
  const resolved = upstreamOAuthOptionsFromEnvironment({ [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([descriptor]), [UPSTREAM_SUBJECT_SECRET_ENV]: "fixture-secret" });
  expect(resolved?.providers[0]?.provider.verificationProfile).toBe("google-oidc");
  expect(resolved?.providers[0]?.provider.defaultScopes).toEqual(["openid", "email"]);
  expect(() => upstreamOAuthOptionsFromEnvironment({ [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([{ ...descriptor, tokenEndpoint: "https://attacker.example.test/token" }]), [UPSTREAM_SUBJECT_SECRET_ENV]: "fixture-secret" })).toThrow();
});

test("profile changes and missing verification erase old verified status without email-only linking", async () => {
  const store = new InMemoryAccountsStore();
  const base = { store, subjectSecret: "fixture-secret", providerId: "oidc", upstreamIssuer: "https://idp.example.test", upstreamSubject: "same-provider-subject", now };
  const first = await resolveUpstreamAccount({ ...base, profile: { email: "before@example.test", emailVerified: true } });
  const changed = await resolveUpstreamAccount({ ...base, profile: { email: "after@example.test" } });
  expect(changed.subject).toBe(first.subject);
  expect(changed.emailVerified).toBeUndefined();
  const other = await resolveUpstreamAccount({ ...base, upstreamSubject: "different-provider-subject", profile: { email: "after@example.test", emailVerified: true } });
  expect(other.subject).not.toBe(changed.subject);
  const absent = await resolveUpstreamAccount({ ...base, upstreamSubject: "different-provider-subject", profile: {} });
  expect(absent.email).toBe("after@example.test");
  expect(absent.emailVerified).toBeUndefined();
});


test("fresh Google proof fails closed when signed credential time is absent or old", async () => {
  for (const claims of [{}, { auth_time: Math.floor(now / 1000) - 61 }]) {
    await expect(exchangeUpstreamAuthorizationCode({ provider: google, clientId: "social-client", redirectUri: "https://auth.example.test/callback", code: "fixture-code", codeVerifier: "v".repeat(43), nonce: "server-nonce", subjectSecret: "fixture-secret", now, freshSince: now, fetch: await googleFetch(await signedGoogleToken(claims)) })).rejects.toThrow("fresh");
  }
  const fresh = await exchangeUpstreamAuthorizationCode({ provider: google, clientId: "social-client", redirectUri: "https://auth.example.test/callback", code: "fixture-code", codeVerifier: "v".repeat(43), nonce: "server-nonce", subjectSecret: "fixture-secret", now, freshSince: now, fetch: await googleFetch(await signedGoogleToken({ auth_time: Math.floor(now / 1000) })) });
  expect(fresh.freshlyAuthenticatedAt).toBe(Math.floor(now / 1000));
});

test("hosted callback continuation is server-bound to issuer authorize only", async () => {
  const store = new InMemoryAccountsStore();
  const options = hostedOptions(githubFetch({ pages: [[]] }));
  expect((await startHostedFlow(store, options, "&return_to=" + encodeURIComponent("https://attacker.example.test/oauth/authorize"))).response.status).toBe(503);
  expect((await startHostedFlow(store, options, "&return_to=" + encodeURIComponent("/api/v1/account/session/me"))).response.status).toBe(503);
  const returnTo = "/oauth/authorize?client_id=hosted-client&state=fixture-rp-state";
  const flow = await startHostedFlow(store, options, "&return_to=" + encodeURIComponent(returnTo));
  expect(flow.response.status).toBe(302);
  const url = new URL(`https://auth.example.test/oauth/upstream/callback?provider=${github.id}&state=${flow.authorization!.searchParams.get("state")}&code=fixture-code`);
  const response = await handleUpstreamCallbackRequest({ request: new Request(url, { headers: { cookie: flow.cookie! } }), url, store, upstreamOAuth: options, secureCookie: true });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(returnTo);
});

test("hosted canonical resolution follows immutable binding and leaves self-host legacy subject intact", async () => {
  const store = new InMemoryAccountsStore();
  const base = { store, subjectSecret: "fixture-secret", providerId: "social", upstreamIssuer: "https://idp.example.test", upstreamSubject: "stable-subject", now };
  const legacy = await resolveUpstreamAccount({ ...base, profile: { email: "same@example.test", emailVerified: true } });
  const root = { subject: "tsub_canonical-root" as const, email: "root@example.test", createdAt: now - 100, updatedAt: now };
  await store.saveAccount(root);
  store.findCanonicalAccount = () => root;
  store.findUpstreamIdentityStatus = () => undefined;
  store.isAccountAuthenticationFenced = () => false;
  const hosted = await resolveUpstreamAccount({ ...base, hostedPolicy: true, profile: { email: "same@example.test", emailVerified: true } });
  expect(hosted.subject).toBe(root.subject);
  expect((await store.findUpstreamIdentity(base))?.subject).toBe(legacy.subject);
  const selfHost = await resolveUpstreamAccount({ ...base, profile: { email: "same@example.test" } });
  expect(selfHost.subject).toBe(legacy.subject);
  expect(selfHost.emailVerified).toBeUndefined();
  store.findUpstreamIdentityStatus = () => ({ identityKey: "fixture", canonicalSubject: root.subject, disabledAt: now, operationId: "unlink" });
  await expect(resolveUpstreamAccount({ ...base, hostedPolicy: true })).rejects.toThrow("disabled");
  store.findUpstreamIdentityStatus = () => undefined;
  store.isAccountAuthenticationFenced = () => true;
  await expect(resolveUpstreamAccount({ ...base, hostedPolicy: true })).rejects.toThrow("fenced");
});

test("Google pinned issuer spellings resolve one identity and never normalize mailbox aliases", async () => {
  const https = await googleExchange(await signedGoogleToken({ email: "a.b+tag@gmail.com" }));
  const short = await googleExchange(await signedGoogleToken({ iss: "accounts.google.com", email: "a.b+tag@gmail.com" }));
  expect(short.upstreamIssuer).toBe(https.upstreamIssuer);
  expect(short.takosumiSubject).toBe(https.takosumiSubject);
  expect(short.profile?.emailProof?.address).toBe("a.b+tag@gmail.com");
});

test("Google rejects unsupported algorithm, unknown rotated kid and ambiguous keys without recursive retrieval", async () => {
  const token = await signedGoogleToken();
  const parts = token.split(".");
  await expect(googleExchange(`${base64UrlEncodeJson({ alg: "none", kid: "fixture-key" })}.${parts[1]}.${parts[2]}`)).rejects.toThrow("header");
  const fetch = await googleFetch(token);
  let keyFetches = 0;
  const ambiguous = (async (input, init) => {
    const request = new Request(input, init);
    const response = await fetch(input, init);
    if (request.url === "https://www.googleapis.com/oauth2/v3/certs") {
      keyFetches++;
      const body = await response.json() as {keys: unknown[]};
      return Response.json({ keys: [...body.keys, ...body.keys] });
    }
    return response;
  }) as typeof globalThis.fetch;
  await expect(exchangeUpstreamAuthorizationCode({ provider: google, clientId: "social-client", redirectUri: "https://auth.example.test/callback", code: "fixture-code", codeVerifier: "v".repeat(43), nonce: "server-nonce", subjectSecret: "fixture-secret", now, fetch: ambiguous })).rejects.toThrow("key");
  expect(keyFetches).toBe(1);
  await expect(googleExchange(`${base64UrlEncodeJson({ alg: "RS256", kid: "retired-key" })}.${parts[1]}.${parts[2]}`)).rejects.toThrow("key");
});

test("upstream HTTP deadline rejects a stalled provider without returning diagnostic detail", async () => {
  const stalled = (() => new Promise<Response>(() => {})) as typeof fetch;
  await expect(githubExchange(stalled)).rejects.toThrow("timed out");
}, 10_000);

test("profile update preserves existing canonical account consent metadata", async () => {
  const store = new InMemoryAccountsStore();
  const base = { store, subjectSecret: "fixture-secret", providerId: "oidc", upstreamIssuer: "https://idp.example.test", upstreamSubject: "terms-owner", now };
  const account = await resolveUpstreamAccount(base);
  await store.saveAccount({ ...account, termsVersion: "v1", termsAcceptedAt: now - 10, termsAcceptedSource: "account-signup" });
  const update = await resolveUpstreamAccount({ ...base, profile: { displayName: "Updated" } });
  expect(update.termsVersion).toBe("v1");
  expect(update.termsAcceptedAt).toBe(now - 10);
  expect(update.termsAcceptedSource).toBe("account-signup");
});

test("self-host can explicitly choose a verified social adapter without adopting shared canonical sessions", async () => {
  const store = new InMemoryAccountsStore();
  const options = { ...hostedOptions(githubFetch({ pages: [[]] })), hostedSessionPolicy: false };
  const flow = await startHostedFlow(store, options);
  expect(flow.response.status).toBe(302);
  const url = new URL(`https://auth.example.test/oauth/upstream/callback?provider=${github.id}&state=${flow.authorization!.searchParams.get("state")}&code=fixture-code`);
  const response = await handleUpstreamCallbackRequest({ request: new Request(url, { headers: { cookie: flow.cookie! } }), url, store, upstreamOAuth: options, secureCookie: true });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("takosumi_session=sess_");
  expect(response.headers.get("set-cookie")).not.toContain("__Host-takosumi_session=");
});


async function operationFixture(withOldLogin = false, fullHandler = false, withRetry = true) {
  let handler: AccountsHandler | undefined;
  let currentFetch = githubFetch({ pages: [[]] });
  const store = new InMemoryAccountsStore();
  const g = await googleExchange(await signedGoogleToken());
  const h = await githubExchange(githubFetch({ pages: [[{ email: "person@gmail.com", primary: true, verified: true, visibility: null }]] }));
  const a = await resolveUpstreamAccount({ store, subjectSecret: "fixture-subject-secret", providerId: g.providerId, upstreamIssuer: g.upstreamIssuer, upstreamSubject: g.upstreamSubject, profile: g.profile, hostedPolicy: true });
  const b = await resolveUpstreamAccount({ store, subjectSecret: "fixture-subject-secret", providerId: h.providerId, upstreamIssuer: h.upstreamIssuer, upstreamSubject: h.upstreamSubject, profile: h.profile, hostedPolicy: true });
  const first = await rotateAccountSession({ store, subject: a.subject, now: Date.now(), ttlMs: 300_000, hostedPolicy: true });
  const cookies = new Map<string, string>([["__Host-takosumi_session", first.sessionId]]);
  const updateCookies = (response: Response) => {
    for (const value of response.headers.getSetCookie()) {
      for (const part of value.split(/,\s*(?=(?:__Host-|takosumi_))/u)) {
        const entry = part.split(";")[0]!;
        const at = entry.indexOf("=");
        if (at > 0) {
          if (entry.slice(at + 1)) cookies.set(entry.slice(0, at), entry.slice(at + 1));
          else cookies.delete(entry.slice(0, at));
        }
      }
    }
  };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const request = (path: string, body: unknown) => new Request("https://auth.example.test" + path, { method: "POST", headers: { origin: "https://auth.example.test", "content-type": "application/json", cookie: cookieHeader() }, body: JSON.stringify(body) });
  const session = () => store.findAccountSession(cookies.get("__Host-takosumi_session")!);
  const reconciler = { ...isolatedContextReconciler(store, Date.now()), reconcile: async (operation: {operationId:string;sourceSubject:string;targetSubject:string}) => ({ operationId: operation.operationId, sourceSubject: operation.sourceSubject, targetSubject: operation.targetSubject, externalBindings: "binding-pin", workspaceMembership: "membership-pin", billingLedger: "ledger-pin", consumerIntentCustody: "custody-pin", rpSessions: "sessions-pin", personalWorkspaceId: "workspace-survivor", reconciledAt: Date.now() }) };
  // Test-only owner ports. The actual stage composition uses its mounted,
  // bounded scheduled service and independently configured readiness checker.
  const retryCapability = withRetry ? {pendingCapacity:100,assertAvailable:async()=>{}} : undefined;
  const merge = async (path: string, body: unknown) => {
    const response = handler ? await handler(request(path, body))
      : await handleIdentityMergeRequest({ request: request(path, body), store, session: await session(), issuerOrigin: "https://auth.example.test", reconciler: reconciler as never, retryCapability });
    if (!response) throw new Error("fixture merge route unavailable");
    updateCookies(response);
    return response;
  };
  const options: UpstreamOAuthOptions = { ...hostedOptions(githubFetch({ pages: [[]] })), providers: [...hostedOptions(githubFetch({ pages: [[]] }), google).providers, ...hostedOptions(githubFetch({ pages: [[]] }), github).providers] };
  if (fullHandler) {
    handler = await createEphemeralAccountsHandler({
      issuer: "https://auth.example.test",
      store,
      hostedSessionPolicy: true,
      allowEphemeralKeyOnHttpsIssuer: true,
      identityMergeReconciler: reconciler as never,
      identityMergeRetry: retryCapability,
      upstreamOAuth: { ...options, fetch: ((input, init) => currentFetch(input, init)) as typeof fetch },
    });
  }
  const oldLoginResponse = withOldLogin ? (await startHostedFlow(store, options)).response : undefined;
  if (oldLoginResponse) updateCookies(oldLoginResponse);
  const created = await merge("/api/v1/account/identity-merges", { sourceSubject: b.subject, targetSubject: a.subject });
  expect(created.status).toBe(201);
  const { operationId } = await created.json() as {operationId:string};

  const begin = async (role: "source" | "target", providerId: string, extra: Record<string, unknown> = {}) => {
    const beginRequest = request(`/api/v1/account/identity-merges/${operationId}/upstream-proof/begin`, { role, providerId, consent: true, ...extra });
    const response = handler ? await handler(beginRequest)
      : await handleUpstreamOperationProofBeginRequest({ request: beginRequest, store, upstreamOAuth: options, issuerOrigin: "https://auth.example.test", secureCookie: true });
    if (!response) throw new Error("fixture proof route unavailable");
    updateCookies(response);
    return response;
  };
  const complete = async (authorizationResponse: Response, overrides: {googleClaims?:Record<string, unknown>;googleUser?:Record<string, unknown>;githubUser?:Record<string, unknown>;githubEmails?:unknown[][];cookie?:string} = {}) => {
    const location = authorizationResponse.headers.get("location") ?? (await authorizationResponse.clone().json() as {authorization_url:string}).authorization_url;
    const authorization = new URL(location);
    const state = authorization.searchParams.get("state")!;
    const isGoogle = authorization.hostname === "accounts.google.com";
    const fetch = isGoogle ? await googleFetch(await signedGoogleToken(overrides.googleClaims ?? {}, authorization.searchParams.get("nonce")!), overrides.googleUser)
      : githubFetch({ user: overrides.githubUser, pages: overrides.githubEmails ?? [[{ email: "person@gmail.com", primary: true, verified: true, visibility: null }]] });
    const url = new URL(`https://auth.example.test/oauth/upstream/callback?state=${state}&code=operation-code`);
    currentFetch = fetch;
    const callbackRequest = new Request(url, { headers: { cookie: overrides.cookie ?? cookieHeader() } });
    const response = handler ? await handler(callbackRequest)
      : await handleUpstreamCallbackRequest({ request: callbackRequest, url, store, upstreamOAuth: {...options,fetch}, secureCookie:true });
    updateCookies(response);
    return response;
  };
  return {store,a,b,cookies,cookieHeader,request,session,merge,operationId,begin,complete,options,oldLoginResponse,updateCookies};
}

test("owning Accounts HTTP social-only merge completes GitHub private + Gmail proofs without auth_time or passkey", async () => {
  const f = await operationFixture(false, true);
  const first = await f.begin("source", github.id);
  expect(first.status).toBe(200);
  const firstCallback = await f.complete(first);
  expect(firstCallback.status).toBe(200);
  const firstResult = await firstCallback.json() as {proof_receipt:string};
  const sourceReceipt = await f.store.findIdentityOperationReceipt(firstResult.proof_receipt);
  expect(sourceReceipt?.method).toBe("upstream-oauth-operation");
  expect(sourceReceipt?.subject).toBe(f.b.subject);
  expect((await f.session())?.reauthenticatedAt).toBeUndefined();
  const source = await f.merge(`/api/v1/account/identity-merges/${f.operationId}/prove`, { receiptId: firstResult.proof_receipt });
  expect(source.status).toBe(200);
  const second = await f.begin("target", google.id);
  expect(second.status).toBe(200);
  const secondCallback = await f.complete(second);
  expect(secondCallback.status).toBe(200);
  const secondResult = await secondCallback.json() as {proof_receipt:string};
  const targetReceipt = await f.store.findIdentityOperationReceipt(secondResult.proof_receipt);
  expect(targetReceipt?.method).toBe("upstream-oauth-operation");
  expect(targetReceipt?.issuerSessionHash).toBe(sourceReceipt?.issuerSessionHash);
  expect((await f.session())?.reauthenticatedAt).toBeUndefined();
  expect((await f.merge(`/api/v1/account/identity-merges/${f.operationId}/prove`, { receiptId: secondResult.proof_receipt })).status).toBe(200);
  // Portable unit context owner; production/Core acceptance has separate integration coverage.
  await acceptIsolatedIdentityContexts(f.store, (await f.store.findIdentityMergeOperation(f.operationId))!, Date.now());
  const consent = await f.merge(`/api/v1/account/identity-merges/${f.operationId}/consent`, { consent: true });
  expect(consent.status).toBe(200);
  expect((await consent.json() as {status:string}).status).toBe("active");
  expect((await f.store.findCanonicalAccount(f.b.subject))?.subject).toBe(f.a.subject);
  expect(await f.store.findAccount(f.b.subject)).toBeDefined();
  expect((await f.store.findIdentityMergeOperation(f.operationId))?.acknowledgements).toMatchObject({ externalBindings: "binding-pin", workspaceMembership: "membership-pin", billingLedger: "ledger-pin", consumerIntentCustody: "custody-pin", personalWorkspaceId: "workspace-survivor" });
});

test("owning HTTP consent without an actual retry capability retains both usable accounts before any fence",async()=>{
  const f=await operationFixture(false,true,false);
  for(const [role,providerId] of [["source",github.id],["target",google.id]] as const){
    const begin=await f.begin(role,providerId);expect(begin.status).toBe(200);
    const callback=await f.complete(begin);expect(callback.status).toBe(200);
    const {proof_receipt:receiptId}=await callback.json() as {proof_receipt:string};
    expect((await f.merge(`/api/v1/account/identity-merges/${f.operationId}/prove`,{receiptId})).status).toBe(200);
  }
  const current=await f.session();expect(current).toBeDefined();
  expect((await f.merge(`/api/v1/account/identity-merges/${f.operationId}/consent`,{consent:true})).status).toBe(409);
  expect(await f.store.isAccountAuthenticationFenced(f.a.subject)).toBe(false);
  expect(await f.store.isAccountAuthenticationFenced(f.b.subject)).toBe(false);
  expect(await f.store.findAccountSession(current!.sessionId)).toBeDefined();
  expect((await f.store.findIdentityMergeOperation(f.operationId))?.consentAt).toBeUndefined();
});

test("operation proof begin refuses caller tuples, timestamps, missing consent and different browser/origin", async () => {
  const f = await operationFixture();
  for (const extra of [{consent:false}, {upstreamSubject:"attacker"}, {subject:f.b.subject}, {startedAt:0}, {identityGeneration:0}, {receiptId:"forged"}]) {
    expect((await f.begin("source",github.id,extra)).status).toBe(400);
  }
  const path = `/api/v1/account/identity-merges/${f.operationId}/upstream-proof/begin`;
  const original=f.request(path,{role:"source",providerId:github.id,consent:true});
  for (const headers of [ {...Object.fromEntries(original.headers),origin:"https://attacker.example.test"}, {...Object.fromEntries(original.headers),cookie:`__Host-takosumi_session=${f.cookies.get("__Host-takosumi_session")}`}]) {
    const response=await handleUpstreamOperationProofBeginRequest({request:new Request(original.url,{method:"POST",headers,body:JSON.stringify({role:"source",providerId:github.id,consent:true})}),store:f.store,upstreamOAuth:f.options,issuerOrigin:"https://auth.example.test",secureCookie:true});
    expect(response?.status).toBe(403);
  }
});

test("operation callback rejects unexpected immutable identity, nonce, old/stale address, non-authoritative mailbox, and code replay", async () => {
  for (const scenario of ["wrong-id", "wrong-nonce", "stale-address", "non-authoritative", "github-unverified"] as const) {
    const f=await operationFixture();
    const googleScenario=scenario!=="wrong-id"&&scenario!=="github-unverified";
    const begin=await f.begin(googleScenario?"target":"source",googleScenario?google.id:github.id);
    expect(begin.status).toBe(200);
    const callback=await f.complete(begin,scenario==="wrong-id"?{githubUser:{id:999999}}:scenario==="wrong-nonce"?{googleClaims:{nonce:"attacker-nonce"}}:scenario==="stale-address"?{googleClaims:{email:"changed@gmail.com"}}:scenario==="non-authoritative"?{googleClaims:{email:"person@external.test"}}:{githubEmails:[[{email:"person@gmail.com",primary:true,verified:false}]]});
    expect(callback.status).toBe(502);
    expect((await f.store.findIdentityMergeOperation(f.operationId))?.status).toBe("pending");
    const replay=await f.complete(begin);
    expect(replay.status).toBe(400);
  }
});


test("old ordinary OAuth transaction cannot become an operation receipt", async () => {
  const f=await operationFixture(true);
  const callback=await f.complete(f.oldLoginResponse!);
  expect(callback.status).toBe(200);
  const body=await callback.json() as {proof_receipt?:string};
  expect(body.proof_receipt).toBeUndefined();
  expect((await f.merge(`/api/v1/account/identity-merges/${f.operationId}/prove`, {receiptId:"iopr_"+crypto.randomUUID()})).status).toBeGreaterThanOrEqual(400);
  expect((await f.store.findIdentityMergeOperation(f.operationId))?.sourceProof).toBeUndefined();
});

test("operation callback fences changed generation, logout and another merge browser", async () => {
  for(const mode of ["generation","logout","browser"] as const){
    const f=await operationFixture();
    const begin=await f.begin("source",github.id);
    expect(begin.status).toBe(200);
    if(mode==="generation")f.store.getAccountAuthenticationGeneration=(subject)=>Promise.resolve(subject===f.b.subject?1:0);
    if(mode==="logout"){
      const logout=await handleHostedGlobalLogout({request:f.request("/api/v1/account/session/global-logout",{}),store:f.store,issuer:"https://auth.example.test"});
      expect(logout.status).toBe(204);
    }
    const cookie=mode==="browser"?f.cookieHeader().replace(/(__Host-takosumi-merge-browser=)[a-f0-9]{64}/u,"$1"+"a".repeat(64)):undefined;
    const response=await f.complete(begin,{cookie});
    expect(response.status).toBe(502);
    expect((await f.store.findIdentityMergeOperation(f.operationId))?.sourceProof).toBeUndefined();
  }
});

test("operation receipt cannot move to another operation or caller-supplied role and fails after real logout following rotation", async () => {
  const f=await operationFixture();
  const begin=await f.begin("source",github.id);
  const response=await f.complete(begin);
  expect(response.status).toBe(200);
  const {proof_receipt:receiptId}=await response.json() as {proof_receipt:string};
  const created=await f.merge("/api/v1/account/identity-merges",{sourceSubject:f.b.subject,targetSubject:f.a.subject});
  expect(created.status).toBe(201);
  const {operationId:otherId}=await created.json() as {operationId:string};
  expect((await f.merge(`/api/v1/account/identity-merges/${otherId}/prove`,{receiptId})).status).toBeGreaterThanOrEqual(400);
  expect((await f.merge(`/api/v1/account/identity-merges/${f.operationId}/prove`,{receiptId,role:"target"})).status).toBeGreaterThanOrEqual(400);
  const receipt=await f.store.findIdentityOperationReceipt(receiptId);
  const logout=await handleHostedGlobalLogout({request:f.request("/api/v1/account/session/global-logout",{}),store:f.store,issuer:"https://auth.example.test"});
  expect(logout.status).toBe(204);
  expect(await f.store.isHostedOidcSessionHashRevoked(receipt!.issuerSessionHash)).toBe(true);
});

test("operation proof refuses incomplete GitHub email pagination and new normalization collision", async () => {
  const f=await operationFixture();
  const begin=await f.begin("source",github.id);
  expect((await f.complete(begin,{githubEmails:Array.from({length:6},()=>[{email:"person@gmail.com",primary:true,verified:true}])})).status).toBe(502);
  const next=await f.begin("source",github.id);
  const callback=await f.complete(next);
  expect(callback.status).toBe(200);
  const {proof_receipt:receiptId}=await callback.json() as {proof_receipt:string};
  await resolveUpstreamAccount({store:f.store,subjectSecret:"fixture-subject-secret",providerId:"other",upstreamIssuer:"https://other.example.test",upstreamSubject:"third-owner",profile:{email:"person@gmail.com",emailVerified:true},hostedPolicy:true});
  expect((await f.merge(`/api/v1/account/identity-merges/${f.operationId}/prove`,{receiptId})).status).toBeGreaterThanOrEqual(400);
  expect((await f.store.findIdentityMergeOperation(f.operationId))?.status).toBe("pending");
});


test("hosted immutable binding race cannot overwrite another canonical owner", async () => {
  const store = new InMemoryAccountsStore();
  const existing = {subject:"tsub_existing-owner" as const,createdAt:now,updatedAt:now};
  await store.saveAccount(existing);
  store.linkUpstreamIdentityIfAbsent = (record) => {
    store.linkUpstreamIdentity({...record,subject:existing.subject});
    return false;
  };
  const input = {store,subjectSecret:"fixture-secret",providerId:"race-provider",upstreamIssuer:"https://idp.example.test",upstreamSubject:"immutable-subject",hostedPolicy:true};
  await expect(resolveUpstreamAccount(input)).rejects.toThrow("binding conflict");
  expect((await store.findUpstreamIdentity(input))?.subject).toBe(existing.subject);
  expect(await store.findAccount(existing.subject)).toEqual(existing);
});

test("parallel operation callbacks consume one transaction and identical proof retry is idempotent", async () => {
  const f=await operationFixture();
  const begin=await f.begin("source",github.id);
  const callbacks=await Promise.all([f.complete(begin),f.complete(begin)]);
  expect(callbacks.map(response=>response.status).sort()).toEqual([200,400]);
  const completed=callbacks.find(response=>response.status===200)!;
  const {proof_receipt:receiptId}=await completed.json() as {proof_receipt:string};
  const path=`/api/v1/account/identity-merges/${f.operationId}/prove`;
  expect((await f.merge(path,{receiptId})).status).toBe(200);
  const first=await f.store.findIdentityMergeOperation(f.operationId);
  expect((await f.merge(path,{receiptId})).status).toBe(200);
  const retried=await f.store.findIdentityMergeOperation(f.operationId);
  expect(retried?.revision).toBe(first?.revision);
  expect((await f.store.findIdentityOperationReceipt(receiptId))?.consumedByOperation).toBe(f.operationId);
});

test("expired operation transaction and changed immutable binding cannot mint receipts", async () => {
  for(const mode of ["expiry","binding"] as const){
    const f=await operationFixture();
    if(mode==="expiry"){
      const save=f.store.saveUpstreamLoginTransaction.bind(f.store);
      f.store.saveUpstreamLoginTransaction=record=>save({...record,expiresAt:Date.now()-1});
    }
    const begin=await f.begin("source",github.id);
    expect(begin.status).toBe(200);
    if(mode==="binding"){
      await f.store.linkUpstreamIdentity({providerId:github.id,upstreamIssuer:github.issuer,upstreamSubject:"4711",subject:f.a.subject,createdAt:now,updatedAt:now});
    }
    const response=await f.complete(begin);
    expect(response.status).toBe(mode==="expiry"?400:502);
    expect((await f.store.findIdentityMergeOperation(f.operationId))?.sourceProof).toBeUndefined();
  }
});

test("ambiguous merge and unlink transaction contexts are refused before provider exchange", async () => {
  const store = new InMemoryAccountsStore();
  const save = store.saveUpstreamLoginTransaction.bind(store);
  store.saveUpstreamLoginTransaction = record => save({ ...record, operationProof: {} as never, unlinkProof: {} as never });
  const requests: Request[] = [];
  const options = hostedOptions(githubFetch({ pages: [[]], requests }));
  const flow = await startHostedFlow(store, options);
  expect(flow.response.status).toBe(302);
  const url = new URL(`https://auth.example.test/oauth/upstream/callback?provider=${github.id}&state=${flow.authorization!.searchParams.get("state")}&code=fixture-code`);
  const response = await handleUpstreamCallbackRequest({ request: new Request(url, { headers: { cookie: flow.cookie! } }), url, store, upstreamOAuth: options, secureCookie: true });
  expect(response.status).toBe(400);
  expect(requests).toHaveLength(0);
});


test("exact registered callback without provider selector resolves Google and GitHub from browser transaction", async () => {
  for (const provider of [google, github]) {
    const store = new InMemoryAccountsStore();
    const requests: Request[] = [];
    const options = {...hostedOptions(githubFetch({pages:[[]]}),provider),providers:[...hostedOptions(githubFetch({pages:[[]]}),provider).providers,...hostedOptions(githubFetch({pages:[[]]}),provider===google?github:google).providers]};
    const flow = await startHostedFlow(store, options);
    expect(flow.response.status).toBe(302);
    expect(flow.authorization!.searchParams.get("redirect_uri")).toBe("https://auth.example.test/oauth/upstream/callback");
    const baseFetch = provider === google ? await googleFetch(await signedGoogleToken({},flow.authorization!.searchParams.get("nonce")!))
      : githubFetch({pages:[[{email:"person@gmail.com",primary:true,verified:true}]]});
    const transport=(async(input,init)=>{requests.push(new Request(input,init));return await baseFetch(input,init);}) as typeof fetch;
    const url=new URL(`https://auth.example.test/oauth/upstream/callback?code=selectorless-code&state=${flow.authorization!.searchParams.get("state")}`);
    expect(url.searchParams.has("provider")).toBe(false);
    const request=new Request(url,{headers:{cookie:flow.cookie!}});
    const response=await handleUpstreamCallbackRequest({request,url,store,upstreamOAuth:{...options,fetch:transport},secureCookie:true});
    expect(response.status).toBe(200);
    expect((await response.json() as {provider_id:string}).provider_id).toBe(provider.id);
    expect(new URLSearchParams(await requests[0]!.text()).get("redirect_uri")).toBe("https://auth.example.test/oauth/upstream/callback");
    const count=requests.length;
    const replay=await handleUpstreamCallbackRequest({request,url,store,upstreamOAuth:{...options,fetch:transport},secureCookie:true});
    expect(replay.status).toBe(400);
    expect(requests).toHaveLength(count);
  }
});

test("selectorless verified callback rejects cookie/state/provider/redirect conflicts before token exchange", async () => {
  for(const mode of ["cookie-provider","state","cross-provider","duplicate-provider","conflicting-provider","duplicate-code","duplicate-state","duplicate-cookie","redirect"] as const){
    const store=new InMemoryAccountsStore();
    if(mode==="redirect"){
      const save=store.saveUpstreamLoginTransaction.bind(store);
      store.saveUpstreamLoginTransaction=record=>save({...record,redirectUri:"https://auth.example.test/different-callback"});
    }
    const requests:Request[]=[];
    const options={...hostedOptions(githubFetch({pages:[[]],requests}),google),providers:[...hostedOptions(githubFetch({pages:[[]]}),google).providers,...hostedOptions(githubFetch({pages:[[]]}),github).providers]};
    const flow=await startHostedFlow(store,options);
    let cookie=flow.cookie!;
    const url=new URL(`https://auth.example.test/oauth/upstream/callback?code=selectorless-code&state=${flow.authorization!.searchParams.get("state")}`);
    if(mode==="cookie-provider")cookie=cookie.replace(/social-google/u,"social-github");
    if(mode==="state")url.searchParams.set("state","a".repeat(64));
    if(mode==="cross-provider")url.searchParams.set("provider",github.id);
    if(mode==="duplicate-provider")url.searchParams.append("provider",google.id),url.searchParams.append("provider",google.id);
    if(mode==="conflicting-provider")url.searchParams.append("provider",google.id),url.searchParams.append("provider",github.id);
    if(mode==="duplicate-code")url.searchParams.append("code","other-code");
    if(mode==="duplicate-state")url.searchParams.append("state",url.searchParams.get("state")!);
    if(mode==="duplicate-cookie")cookie+="; "+cookie;
    const response=await handleUpstreamCallbackRequest({request:new Request(url,{headers:{cookie}}),url,store,upstreamOAuth:options,secureCookie:true});
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(0);
  }
});

test("unlink operation proof callback uses exact registered URI without provider selector", async () => {
  const f=await operationFixture();
  // Fixture is one canonical customer with two known immutable login methods.
  // A prior merge is not needed to exercise this callback's provider selection.
  const removedIdentity={providerId:google.id,upstreamIssuer:google.issuer,upstreamSubject:"google-stable-subject"};
  const retainedIdentity={providerId:github.id,upstreamIssuer:github.issuer,upstreamSubject:"4711"};
  await f.store.linkUpstreamIdentity({...retainedIdentity,subject:f.a.subject,createdAt:now,updatedAt:now});
  const base="/api/v1/account/identity-credentials/unlink-intents";
  const created=await handleCredentialUnlinkIntentRequest({request:f.request(base,{removedIdentity,retainedIdentity,consent:true}),store:f.store,issuerOrigin:"https://auth.example.test"});
  expect(created?.status).toBe(201);
  f.updateCookies(created!);
  const {operationId}=await created!.json() as {operationId:string};
  const begin=await handleUpstreamUnlinkProofBeginRequest({request:f.request(`${base}/${operationId}/upstream-proof/begin`,{consent:true}),store:f.store,upstreamOAuth:f.options,issuerOrigin:"https://auth.example.test",secureCookie:true});
  expect(begin?.status).toBe(200);
  f.updateCookies(begin!);
  const authorization=new URL((await begin!.clone().json() as {authorization_url:string}).authorization_url);
  expect(authorization.searchParams.get("redirect_uri")).toBe("https://auth.example.test/oauth/upstream/callback");
  const callback=await f.complete(begin!);
  expect(callback.status).toBe(200);
  const result=await callback.json() as {proof_receipt:string;unlink_intent_id:string;operation_id?:string};
  expect(result.unlink_intent_id).toBe(operationId);
  expect(result.operation_id).toBeUndefined();
  expect((await f.store.findCredentialUnlinkReceipt(result.proof_receipt))?.retainedIdentity).toEqual(retainedIdentity);
});
