import { expect, test } from "bun:test";
import { handleStagingLoginPortal } from "../../../../deploy/accounts-cloudflare/src/staging-login-portal.ts";
import { createEphemeralAccountsHandler, type UpstreamOAuthOptions } from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { verifiedSocialOAuthProvider } from "../../../../accounts/service/src/upstream-verification.ts";
import { base64UrlEncodeBytes, sha256Text } from "../../../../accounts/service/src/encoding.ts";

const issuer = "https://auth-staging.takos.jp";
const returnTo = "/oauth/authorize?response_type=code&client_id=hosted-staging&state=original-state&nonce=original-nonce";
const descriptors = [
  { id: "google", label: "Google", protocol: "oidc", enabled: true },
  { id: "github", label: "GitHub", protocol: "oauth2", enabled: true },
];

function signInUrl(continuation: string | undefined = returnTo, parameters: Record<string, string> = {}): URL {
  const url = new URL("/sign-in", issuer);
  if (continuation !== undefined) url.searchParams.set("return", continuation);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url;
}

async function render(url: URL = signInUrl(), providers: unknown = descriptors, method = "GET") {
  return handleStagingLoginPortal({ request: new Request(url, { method }), issuer, accountsHandler: () => Response.json({ providers }) });
}

function links(html: string): URL[] {
  return [...html.matchAll(/href="([^"]+)"/gu)].map((match) => new URL(match[1]!.replace(/&amp;/gu, "&"), issuer));
}

test("stage login uses only configured public providers and preserves the entire authorize continuation", async () => {
  const configured = [...descriptors, { id: "passkey", label: "Passkey", protocol: "webauthn", enabled: true },
    { id: "enterprise", label: "Company", protocol: "oidc", enabled: true }];
  const url = signInUrl();
  const response = await render(url, configured);
  expect(response?.status).toBe(200);
  const html = await response!.text();
  const targets = links(html);
  expect(targets.map((target) => target.searchParams.get("provider"))).toEqual(["google", "github"]);
  for (const target of targets) {
    expect(target.origin).toBe(issuer);
    expect(target.pathname).toBe("/oauth/upstream/authorize");
    expect(target.searchParams.get("return_to")).toBe(returnTo);
    expect(target.searchParams.get("state")).toBeNull();
    expect(target.searchParams.get("code_verifier")).toBeNull();
  }
  expect(html).not.toContain("Company");
  expect(html).not.toContain("Passkey");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("client_secret");
});

test("provider discovery is an in-process public request with no caller authority or forwarded host", async () => {
  let actualRequest: Request | undefined;
  const response = await handleStagingLoginPortal({
    request: new Request(signInUrl(), { headers: { cookie: "__Host-takosumi_session=private-fixture", authorization: "Bearer private-fixture", "x-forwarded-host": "attacker.example.test" } }),
    issuer,
    accountsHandler(request) { actualRequest = request; return Response.json({ providers: descriptors }); },
  });
  expect(response?.status).toBe(200);
  expect(actualRequest?.url).toBe(`${issuer}/api/v1/auth/providers`);
  expect(actualRequest?.method).toBe("GET");
  expect(actualRequest?.headers.get("cookie")).toBeNull();
  expect(actualRequest?.headers.get("authorization")).toBeNull();
  expect(actualRequest?.headers.get("x-forwarded-host")).toBeNull();
});

test("host and configured issuer guards refuse production before querying Accounts", async () => {
  let calls = 0;
  const handler = () => { calls++; return Response.json({ providers: descriptors }); };
  for (const [requestUrl, configuredIssuer, host] of [
    ["https://auth.takos.jp/sign-in", issuer, undefined],
    ["https://auth-staging.takos.jp.attacker.test/sign-in", issuer, undefined],
    ["http://auth-staging.takos.jp/sign-in", issuer, undefined],
    ["https://auth-staging.takos.jp:444/sign-in", issuer, undefined],
    [`${issuer}/sign-in`, "https://auth.takos.jp", undefined],
    [`${issuer}/sign-in`, `${issuer}/`, undefined],
    [`${issuer}/sign-in`, issuer, "auth.takos.jp"],
  ] as const) {
    const request = new Request(requestUrl, { headers: host ? { host } : {} });
    expect((await handleStagingLoginPortal({ request, issuer: configuredIssuer, accountsHandler: handler }))?.status).toBe(404);
  }
  expect(calls).toBe(0);
  expect(await handleStagingLoginPortal({ request: new Request(`${issuer}/oauth/authorize`), issuer, accountsHandler: handler })).toBeNull();
  expect(calls).toBe(0);
});

test("HEAD returns a validated empty response and writes are rejected without discovery", async () => {
  const response = await render(signInUrl(), descriptors, "HEAD");
  expect(response?.status).toBe(200);
  expect(await response!.text()).toBe("");
  expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
  let queried = false;
  const post = await handleStagingLoginPortal({ request: new Request(signInUrl(), { method: "POST" }), issuer,
    accountsHandler: () => { queried = true; return Response.json({ providers: descriptors }); } });
  expect(post?.status).toBe(405);
  expect(post?.headers.get("allow")).toBe("GET, HEAD");
  expect(queried).toBe(false);
});

for (const [name, continuation] of [
  ["absolute external URL", "https://attacker.example.test/oauth/authorize"],
  ["absolute issuer URL", `${issuer}/oauth/authorize`],
  ["scheme-relative URL", "//attacker.example.test/oauth/authorize"],
  ["URL credentials", "https://user:password@auth-staging.takos.jp/oauth/authorize"],
  ["backslash URL", "/\\attacker.example.test/oauth/authorize"],
  ["encoded path", "/oauth/%61uthorize?state=original"],
  ["relative sibling", "/oauth/authorize/../token"],
  ["path suffix", "/oauth/authorize/"],
  ["fragment", "/oauth/authorize?state=original#steal"],
  ["duplicate state", "/oauth/authorize?state=first&state=second"],
  ["duplicate unknown parameter", "/oauth/authorize?extension=first&extension=second"],
  ["encoded control", "/oauth/authorize?state=%0aheader"],
  ["raw control", "/oauth/authorize?state=\rheader"],
  ["oversized return", `/oauth/authorize?state=${"a".repeat(8192)}`],
  ["oversized parameter", `/oauth/authorize?state=${"a".repeat(4097)}`],
  ["contradictory prompt", "/oauth/authorize?prompt=none+login"],
] as const) {
  test(`sign-in rejects ${name} before provider lookup`, async () => {
    let called = false;
    const response = await handleStagingLoginPortal({ request: new Request(signInUrl(continuation)), issuer,
      accountsHandler: () => { called = true; return Response.json({ providers: descriptors }); } });
    expect(response?.status).toBe(400);
    expect(called).toBe(false);
    expect(await response!.text()).not.toContain(continuation);
  });
}

test("duplicate outer parameters, arbitrary provider overrides and invalid freshness are refused", async () => {
  const invalid = [
    signInUrl(returnTo, { provider: "attacker" }),
    signInUrl(returnTo, { prompt: "none" }),
    signInUrl(returnTo, { max_age: "-1" }),
    signInUrl(returnTo, { max_age: "604801" }),
    signInUrl(returnTo, { max_age: "00.1" }),
  ];
  for (const key of ["return", "prompt", "max_age"]) {
    const url = signInUrl(returnTo, { prompt: "login", max_age: "0" });
    url.searchParams.append(key, key === "return" ? returnTo : key === "prompt" ? "login" : "0");
    invalid.push(url);
  }
  for (const url of invalid) expect((await render(url))?.status).toBe(400);
});

test("labels and OAuth values are safely escaped and HTML has a nonce-only style policy", async () => {
  const dangerousLabel = 'Google <script>alert("x")</script> & \'quoted\'';
  const response = await render(signInUrl("/oauth/authorize?state=%22%3E%3Cscript%3Eattack%3C%2Fscript%3E"), [{ ...descriptors[0], label: dangerousLabel }]);
  expect(response?.status).toBe(200);
  const html = await response!.text();
  expect(html).toContain("Google &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;");
  expect(html).not.toContain("<script");
  expect(links(html)[0]?.searchParams.get("return_to")).toBe("/oauth/authorize?state=%22%3E%3Cscript%3Eattack%3C%2Fscript%3E");
  const nonce = html.match(/<style nonce="([^"]+)"/u)?.[1];
  expect(nonce).toBeTruthy();
  expect(response?.headers.get("content-security-policy")).toBe(`default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response?.headers.get("set-cookie")).toBeNull();
});

test("freshness makes Google explicit and disables GitHub without inventing authentication times", async () => {
  for (const url of [signInUrl(returnTo, { prompt: "login", max_age: "0" }), signInUrl(`${returnTo}&prompt=login`), signInUrl(`${returnTo}&max_age=0`)]) {
    const response = await render(url);
    const html = await response!.text();
    const targets = links(html);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.searchParams.get("provider")).toBe("google");
    expect(targets[0]?.searchParams.get("prompt")).toBe("login");
    expect(targets[0]?.searchParams.get("max_age")).toBe("0");
    expect(html).toContain('<button type="button" disabled>GitHub</button>');
    expect(html).toContain("GitHub cannot confirm fresh credential entry");
    expect(html).not.toContain("auth_time");
    expect(html).not.toContain("reauthenticatedAt");
  }
});

test("missing return explains the app entry without creating an invalid authorization flow", async () => {
  const response = await render(new URL("/sign-in", issuer));
  expect(response?.status).toBe(200);
  const html = await response!.text();
  expect(html).toContain("Start sign-in from Takosumi Hosted or Takoserver.");
  expect(links(html)).toHaveLength(0);
  expect(html).toContain("Google");
  expect(html).toContain("GitHub");
});

test("empty, malformed, disabled, mismatched and oversized provider discovery fails closed", async () => {
  for (const providers of [[], [{ ...descriptors[0], enabled: false }], [{ id: "other", label: "Other", protocol: "oidc", enabled: true }],
    [descriptors[0], descriptors[0]], [{ ...descriptors[1], protocol: "oidc" }], [{ ...descriptors[0], label: "" }],
    [{ ...descriptors[0], label: "x".repeat(161) }], [{ ...descriptors[0], enabled: "true" }], null]) {
    expect((await render(signInUrl(), providers))?.status).toBe(503);
  }
  for (const providerResponse of [new Response("x".repeat(16 * 1024 + 1), { headers: { "content-type": "application/json" } }),
    new Response("invalid-json", { headers: { "content-type": "application/json" } }),
    new Response("private diagnostic fixture", { status: 500 }), Response.redirect("https://attacker.example.test/providers", 302)]) {
    const response = await handleStagingLoginPortal({ request: new Request(signInUrl()), issuer, accountsHandler: () => providerResponse });
    expect(response?.status).toBe(503);
    expect(await response!.text()).not.toContain("private diagnostic fixture");
    expect(response?.headers.get("location")).toBeNull();
  }
  expect((await handleStagingLoginPortal({ request: new Request(signInUrl()), issuer }))?.status).toBe(503);
  expect((await handleStagingLoginPortal({ request: new Request(signInUrl()), issuer, accountsHandler: () => { throw new Error("private secret fixture"); } }))?.status).toBe(503);
});

test("real Accounts navigation reaches durable GitHub callback, issuer session and registered-client consent", async () => {
  const store = new InMemoryAccountsStore();
  const github = verifiedSocialOAuthProvider({ id: "github", profile: "github-oauth" });
  const upstreamRequests: Request[] = [];
  const upstreamOAuth: UpstreamOAuthOptions = {
    subjectSecret: "fixture-upstream-subject-secret",
    hostedSessionPolicy: true,
    providers: [{ providerId: "github", label: "GitHub", protocol: "oauth2", provider: github, clientId: "fixture-upstream-client",
      clientSecret: "fixture-upstream-secret", redirectUri: `${issuer}/oauth/upstream/callback?provider=github` }],
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      upstreamRequests.push(request);
      if (request.url === github.tokenEndpoint) return Response.json({ access_token: "fixture-private-access", token_type: "bearer" });
      expect(request.headers.get("authorization")).toBe("Bearer fixture-private-access");
      if (request.url === github.userInfoEndpoint) return Response.json({ id: 84115, login: "fixture-user", email: "public-unverified@example.test" });
      expect(new URL(request.url).origin + new URL(request.url).pathname).toBe("https://api.github.com/user/emails");
      return Response.json([{ email: "private@example.test", primary: true, verified: true }]);
    }) as typeof fetch,
  };
  const accountsHandler = await createEphemeralAccountsHandler({ issuer, store, upstreamOAuth, hostedSessionPolicy: true, allowEphemeralKeyOnHttpsIssuer: true,
    clients: [{ clientId: "hosted-staging", profile: "shared-account", enabled: true, clientSecret: "fixture-hosted-client-secret", tokenEndpointAuthMethod: "client_secret_basic",
      redirectUris: ["https://app-staging.takosumi.com/auth/oidc/callback"], allowedScopes: ["openid", "email"] }] });
  const authorize = new URL("/oauth/authorize", issuer);
  const challenge = base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("v".repeat(43)))));
  authorize.search = new URLSearchParams({ response_type: "code", client_id: "hosted-staging", redirect_uri: "https://app-staging.takosumi.com/auth/oidc/callback",
    scope: "openid email", state: "fixture-rp-state", nonce: "fixture-rp-nonce", code_challenge: challenge, code_challenge_method: "S256" }).toString();
  const initial = await accountsHandler(new Request(authorize));
  expect(initial.status).toBe(302);
  const login = new URL(initial.headers.get("location")!);
  expect(login.pathname).toBe("/sign-in");
  expect(login.searchParams.get("return")).toBe(authorize.pathname + authorize.search);
  const page = await handleStagingLoginPortal({ request: new Request(login), issuer, accountsHandler });
  expect(page?.status).toBe(200);
  const upstream = await accountsHandler(new Request(links(await page!.text())[0]!));
  expect(upstream.status).toBe(302);
  const providerAuthorization = new URL(upstream.headers.get("location")!);
  expect(providerAuthorization.origin).toBe("https://github.com");
  expect(providerAuthorization.searchParams.get("code_challenge_method")).toBe("S256");
  const bindingCookie = upstream.headers.get("set-cookie")!.split(";")[0]!;
  expect(bindingCookie).toStartWith("__Host-takosumi_upstream=");
  const callbackUrl = new URL("/oauth/upstream/callback", issuer);
  callbackUrl.search = new URLSearchParams({ provider: "github", state: providerAuthorization.searchParams.get("state")!, code: "fixture-provider-code" }).toString();
  const callbackRequest = new Request(callbackUrl, { headers: { cookie: bindingCookie } });
  const callback = await accountsHandler(callbackRequest);
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(authorize.pathname + authorize.search);
  const sessionCookie = callback.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-takosumi_session="))?.split(";")[0];
  expect(sessionCookie).toBeTruthy();
  expect(callback.headers.getSetCookie().join("\n")).toContain("HttpOnly; Secure; SameSite=Lax");
  expect(await callback.clone().text()).toBe("");
  const tokenExchange = upstreamRequests.find((request) => request.url === github.tokenEndpoint)!;
  const verifier = new URLSearchParams(await tokenExchange.text()).get("code_verifier");
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect((await sha256Text(verifier!)).slice(7)).toBe(providerAuthorization.searchParams.get("code_challenge"));
  const consent = await accountsHandler(new Request(new URL(callback.headers.get("location")!, issuer), { headers: { cookie: sessionCookie! } }));
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain("Continue sign-in");
  const replay = await accountsHandler(callbackRequest);
  expect(replay.status).toBe(400);
  expect(upstreamRequests).toHaveLength(3);
});
