import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import {
  handleAuthorize,
  handleIntrospect,
  handleToken,
} from "../../../../accounts/service/src/oidc-routes.ts";
import {
  handleUpstreamAuthorizeRequest,
  handleUpstreamCallbackRequest,
} from "../../../../accounts/service/src/upstream-oauth-routes.ts";
import { base64UrlEncodeBytes } from "../../../../accounts/service/src/encoding.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { oidcOAuthProvider } from "../../../../accounts/service/src/upstream.ts";
import type {
  OidcAuthorizationCodeFlow,
  OidcClientRegistration,
  UpstreamOAuthOptions,
} from "../../../../accounts/service/src/mod.ts";

const issuer = "https://accounts.example.test";
const redirectUri = "https://client.example.test/oauth/callback";
const client: OidcClientRegistration = {
  clientId: "cache-test-client",
  redirectUris: [redirectUri],
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid"],
};
const confidentialClient: OidcClientRegistration = {
  clientId: "cache-test-resource",
  redirectUris: [redirectUri],
  clientSecret: "cache-test-secret",
  tokenEndpointAuthMethod: "client_secret_post",
};
const flow: OidcAuthorizationCodeFlow = {
  subject: "unused",
  pairwiseSubjectSecret: "test-secret",
  issueIdToken: async () => "test-id-token",
};

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

function authorizeUrl(): URL {
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: "openid",
    state: "request-state",
    code_challenge: "test-challenge",
    code_challenge_method: "S256",
  }).toString();
  return url;
}

test("authorize sign-in redirects are uncacheable and vary by browser inputs", async () => {
  const response = await handleAuthorize({
    request: new Request(authorizeUrl(), {
      headers: { "sec-fetch-dest": "document" },
    }),
    url: authorizeUrl(),
    flow,
    clients: new Map([[client.clientId, client]]),
    store: new InMemoryAccountsStore(),
  });

  expect(response.status).toBe(302);
  expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
  expectNoStore(response);
  expect(response.headers.get("vary")).toBe("Cookie, Sec-Fetch-Dest");
});

test("authenticated authorization-code redirects are uncacheable", async () => {
  const store = new InMemoryAccountsStore();
  await store.saveAccount({
    subject: "tsub_cache_test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await store.saveAccountSession({
    sessionId: "sess_cache_test",
    subject: "tsub_cache_test",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const url = authorizeUrl();
  const response = await handleAuthorize({
    request: new Request(url, {
      headers: {
        cookie: "takosumi_session=sess_cache_test",
        "sec-fetch-dest": "document",
      },
    }),
    url,
    flow,
    clients: new Map([[client.clientId, client]]),
    store,
  });

  expect(response.status).toBe(302);
  expect(new URL(response.headers.get("location")!).searchParams.get("code"))
    .toBeString();
  expectNoStore(response);
  expect(response.headers.get("vary")).toBe("Cookie, Sec-Fetch-Dest");
});

test("token and introspection responses never cache credentials or private claims", async () => {
  const store = new InMemoryAccountsStore();
  const verifier = "cache-test-verifier";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const code = "cache-test-code";
  await store.saveAuthorizationCode(code, {
    clientId: client.clientId,
    redirectUri,
    scope: "openid",
    subject: "tsub_cache_test",
    codeChallenge: base64UrlEncodeBytes(new Uint8Array(digest)),
    codeChallengeMethod: "S256",
    expiresAt: Date.now() + 60_000,
  });

  const token = await handleToken({
    issuer,
    request: new Request(`${issuer}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    }),
    store,
    flow,
    clients: new Map([[client.clientId, client]]),
  });
  expect(token.status).toBe(200);
  expectNoStore(token);
  const tokenBody = (await token.json()) as { access_token: string };
  expect(tokenBody.access_token).toStartWith("takat_");

  const introspectedToken = "opaque-introspection-token";
  await store.saveAccessToken(introspectedToken, {
    clientId: confidentialClient.clientId,
    scope: "openid",
    subject: "tsub_cache_test",
    expiresAt: Date.now() + 60_000,
  });
  const introspection = await handleIntrospect({
    issuer,
    request: new Request(`${issuer}/oauth/introspect`, {
      method: "POST",
      body: new URLSearchParams({
        token: introspectedToken,
        client_id: confidentialClient.clientId,
        client_secret: confidentialClient.clientSecret!,
      }),
    }),
    store,
    clients: new Map([
      [client.clientId, client],
      [confidentialClient.clientId, confidentialClient],
    ]),
  });
  expect(introspection.status).toBe(200);
  expectNoStore(introspection);
  expect(await introspection.json()).toMatchObject({ active: true });

  const inactive = await handleIntrospect({
    issuer,
    request: new Request(`${issuer}/oauth/introspect`, {
      method: "POST",
      body: new URLSearchParams({
        token: "unknown-token",
        client_id: confidentialClient.clientId,
        client_secret: confidentialClient.clientSecret!,
      }),
    }),
    store,
    clients: new Map([[confidentialClient.clientId, confidentialClient]]),
  });
  expect(inactive.status).toBe(200);
  expectNoStore(inactive);
  expect(await inactive.json()).toEqual({ active: false });
});

function upstreamOAuth(fetch: typeof globalThis.fetch): UpstreamOAuthOptions {
  return {
    subjectSecret: "upstream-cache-test-secret",
    fetch,
    providers: [
      {
        providerId: "company",
        clientId: "company-client",
        clientSecret: "company-secret",
        redirectUri: `${issuer}/v1/auth/upstream/callback`,
        provider: oidcOAuthProvider({
          id: "company",
          issuer: "https://idp.example.test",
          authorizationEndpoint: "https://idp.example.test/authorize",
          tokenEndpoint: "https://idp.example.test/token",
          userInfoEndpoint: "https://idp.example.test/userinfo",
        }),
      },
    ],
  };
}

test("upstream OAuth authorize and session callback responses are uncacheable", async () => {
  const authorization = handleUpstreamAuthorizeRequest({
    url: new URL(`${issuer}/v1/auth/upstream/authorize?provider=company&state=client-state`),
    upstreamOAuth: upstreamOAuth(fetch),
    secureCookie: false,
  });
  expect(authorization.status).toBe(302);
  expectNoStore(authorization);
  expect(authorization.headers.get("location")).toContain("state=");
  const stateCookie = authorization.headers.get("set-cookie")!.split(";", 1)[0]!;
  const providerState = decodeURIComponent(stateCookie.split("=", 2)[1]!).split(":", 2)[1]!;

  const callback = await handleUpstreamCallbackRequest({
    request: new Request(
      `${issuer}/v1/auth/upstream/callback?provider=company&code=upstream-code&state=${encodeURIComponent(providerState)}&code_verifier=${"v".repeat(43)}`,
      { headers: { cookie: stateCookie } },
    ),
    url: new URL(
      `${issuer}/v1/auth/upstream/callback?provider=company&code=upstream-code&state=${encodeURIComponent(providerState)}&code_verifier=${"v".repeat(43)}`,
    ),
    store: new InMemoryAccountsStore(),
    upstreamOAuth: upstreamOAuth(async (url) => {
      if (String(url) === "https://idp.example.test/token") {
        return new Response(JSON.stringify({ access_token: "upstream-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ sub: "upstream-subject", email: "user@example.test" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
    secureCookie: false,
  });
  expect(callback.status).toBe(200);
  expectNoStore(callback);
  expect(callback.headers.get("set-cookie")).toContain("takosumi_oauth_state=");
  expect(callback.headers.get("set-cookie")).toContain("takosumi_session=");
});

test("workerd preserves both authorize redirect branches while adding no-store headers", async () => {
  const build = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../fixtures/oauth-cache-runtime.ts"),
    ],
    target: "browser",
    format: "esm",
    minify: true,
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("OAuth cache runtime bundle is missing");

  const runtime = new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [
      {
        type: "ESModule",
        path: "oauth-cache-runtime.mjs",
        contents: await output.text(),
      },
    ],
  });
  try {
    for (const branch of ["sign-in", "code"] as const) {
      const response = await runtime.dispatchFetch(
        `https://worker.test/authorize/${branch}`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      if (branch === "sign-in") {
        expect(location.origin).toBe(issuer);
        expect(location.pathname).toBe("/sign-in");
        expect(location.searchParams.get("return")).toStartWith(
          "/oauth/authorize?",
        );
      } else {
        expect(location.origin).toBe("https://client.example.test");
        expect(location.pathname).toBe("/oauth/callback");
        expect(location.searchParams.get("code")).toBeString();
        expect(location.searchParams.get("state")).toBe("workerd-state");
      }
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("vary")).toBe("Cookie, Sec-Fetch-Dest");
    }
  } finally {
    await runtime.dispose();
  }
});
