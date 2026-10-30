import { expect, test } from "bun:test";
import {
  composeTakosumiMobileOidcClients,
  createEphemeralAccountsHandler,
  type OidcClientRegistration,
} from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";

const ISSUER = "http://localhost:8787";
const REDIRECT = "takosumi://oauth/callback";
const MOBILE_SCOPE = "openid profile offline_access capsules:read capsules:write";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: base64Url(digest) };
}

async function setup(input: {
  clients?: readonly OidcClientRegistration[];
} = {}) {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  for (const [subject, sessionId, email] of [
    ["tsub_mobile_owner", "sess_mobile_owner", "owner@example.test"],
    ["tsub_mobile_other", "sess_mobile_other", "other@example.test"],
  ] as const) {
    store.saveAccount({ subject, email, createdAt: now, updatedAt: now });
    store.saveAccountSession({
      sessionId,
      subject,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
    });
  }
  const composed = composeTakosumiMobileOidcClients({ builtinClient: true });
  const handler = await createEphemeralAccountsHandler({
    issuer: ISSUER,
    subject: "tsub_mobile_owner",
    store,
    clients: input.clients ?? composed.clients,
  });
  return { handler, store };
}

function authorizeUrl(
  challenge: string,
  overrides: Record<string, string> = {},
): URL {
  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "takosumi-mobile",
    redirect_uri: REDIRECT,
    scope: MOBILE_SCOPE,
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...overrides,
  }).toString();
  return url;
}

function cookie(sessionId = "sess_mobile_owner"): string {
  return `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`;
}

function consentTransaction(html: string): string {
  const match = /name="consent_transaction" value="([^"]+)"/u.exec(html);
  if (!match) throw new Error("consent page has no transaction");
  return match[1]!;
}

async function openConsent(
  handler: (request: Request) => Promise<Response>,
  url: URL,
  sessionId?: string,
): Promise<{ response: Response; html: string; transaction: string }> {
  const response = await handler(
    new Request(url, {
      headers: {
        cookie: cookie(sessionId),
        "sec-fetch-dest": "document",
        "accept-language": "ja,en;q=0.8",
      },
    }),
  );
  const html = await response.text();
  return { response, html, transaction: consentTransaction(html) };
}

function submitConsent(
  handler: (request: Request) => Promise<Response>,
  url: URL,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(
    new Request(url, {
      method: "POST",
      headers: {
        cookie: cookie(),
        origin: ISSUER,
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(form),
    }),
  );
}

async function token(
  handler: (request: Request) => Promise<Response>,
  form: Record<string, string>,
): Promise<Response> {
  return await handler(
    new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    }),
  );
}

test("the built-in Takosumi Mobile client shows a consent screen instead of issuing a code", async () => {
  const { handler } = await setup();
  const { challenge } = await pkcePair();
  const { response, html } = await openConsent(handler, authorizeUrl(challenge));

  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'self' takosumi:");
  expect(csp).not.toContain("unsafe-inline");
  expect(html).toContain("Takosumi Mobile にアクセスを許可しますか？");
  expect(html).toContain("Runの承認と取り消し");
  expect(html).toContain("owner@example.test");
  expect(html).toContain(REDIRECT);
  expect(html).not.toContain("code=");
});

test("approving the consent issues a code that only the PKCE verifier can redeem", async () => {
  const { handler } = await setup();
  const { verifier, challenge } = await pkcePair();
  const url = authorizeUrl(challenge);
  const { transaction } = await openConsent(handler, url);

  const approved = await submitConsent(handler, url, {
    consent_transaction: transaction,
    decision: "approve",
  });
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get("location")!);
  expect(`${callback.protocol}//${callback.host}${callback.pathname}`).toBe(REDIRECT);
  expect(callback.searchParams.get("state")).toBe("state-123");
  const code = callback.searchParams.get("code")!;
  expect(code).toBeTruthy();

  const wrongVerifier = await token(handler, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: "takosumi-mobile",
    code_verifier: (await pkcePair()).verifier,
  });
  expect(wrongVerifier.status).toBe(400);

  // The failed attempt consumed the code; start a second authorization.
  const second = await pkcePair();
  const secondUrl = authorizeUrl(second.challenge);
  const secondConsent = await openConsent(handler, secondUrl);
  const secondApproved = await submitConsent(handler, secondUrl, {
    consent_transaction: secondConsent.transaction,
    decision: "approve",
  });
  const secondCode = new URL(secondApproved.headers.get("location")!).searchParams.get("code")!;
  const exchanged = await token(handler, {
    grant_type: "authorization_code",
    code: secondCode,
    redirect_uri: REDIRECT,
    client_id: "takosumi-mobile",
    code_verifier: second.verifier,
  });
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as Record<string, unknown>;
  expect(tokens.token_type).toBe("Bearer");
  expect(typeof tokens.access_token).toBe("string");
  expect(typeof tokens.refresh_token).toBe("string");
  expect(String(tokens.scope).split(" ").sort()).toEqual(MOBILE_SCOPE.split(" ").sort());
  void verifier;
});

test("refresh tokens rotate, a reused refresh token fails, and revocation ends the session", async () => {
  const { handler } = await setup();
  const { verifier, challenge } = await pkcePair();
  const url = authorizeUrl(challenge);
  const { transaction } = await openConsent(handler, url);
  const approved = await submitConsent(handler, url, {
    consent_transaction: transaction,
    decision: "approve",
  });
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const first = (await (await token(handler, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: "takosumi-mobile",
    code_verifier: verifier,
  })).json()) as { access_token: string; refresh_token: string };

  const userinfo = await handler(
    new Request(`${ISSUER}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${first.access_token}` },
    }),
  );
  expect(userinfo.status).toBe(200);

  const rotated = await token(handler, {
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    client_id: "takosumi-mobile",
  });
  expect(rotated.status).toBe(200);
  const second = (await rotated.json()) as { refresh_token: string };
  expect(second.refresh_token).not.toBe(first.refresh_token);

  const reused = await token(handler, {
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    client_id: "takosumi-mobile",
  });
  expect(reused.status).toBe(400);

  // Start a fresh chain and revoke it the way Takosumi Mobile signs out.
  const fresh = await pkcePair();
  const freshUrl = authorizeUrl(fresh.challenge);
  const freshConsent = await openConsent(handler, freshUrl);
  const freshApproved = await submitConsent(handler, freshUrl, {
    consent_transaction: freshConsent.transaction,
    decision: "approve",
  });
  const freshTokens = (await (await token(handler, {
    grant_type: "authorization_code",
    code: new URL(freshApproved.headers.get("location")!).searchParams.get("code")!,
    redirect_uri: REDIRECT,
    client_id: "takosumi-mobile",
    code_verifier: fresh.verifier,
  })).json()) as { access_token: string; refresh_token: string };
  for (const value of [freshTokens.access_token, freshTokens.refresh_token]) {
    const revoked = await handler(
      new Request(`${ISSUER}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: value, client_id: "takosumi-mobile" }),
      }),
    );
    expect(revoked.status).toBe(200);
  }
  const afterRevoke = await token(handler, {
    grant_type: "refresh_token",
    refresh_token: freshTokens.refresh_token,
    client_id: "takosumi-mobile",
  });
  expect(afterRevoke.status).toBe(400);
  const revokedUserinfo = await handler(
    new Request(`${ISSUER}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${freshTokens.access_token}` },
    }),
  );
  expect(revokedUserinfo.status).toBe(401);
});

test("denying the consent returns access_denied to the app without a code", async () => {
  const { handler } = await setup();
  const { challenge } = await pkcePair();
  const url = authorizeUrl(challenge);
  const { transaction } = await openConsent(handler, url);

  const denied = await submitConsent(handler, url, {
    consent_transaction: transaction,
    decision: "deny",
  });
  expect(denied.status).toBe(302);
  const callback = new URL(denied.headers.get("location")!);
  expect(callback.searchParams.get("error")).toBe("access_denied");
  expect(callback.searchParams.get("state")).toBe("state-123");
  expect(callback.searchParams.has("code")).toBe(false);
});

test("the consent POST requires the issuer origin, the same session, the same request, and is single use", async () => {
  const { handler } = await setup();
  const { challenge } = await pkcePair();
  const url = authorizeUrl(challenge);

  const crossSite = await openConsent(handler, url);
  const noOrigin = await handler(
    new Request(url, {
      method: "POST",
      headers: {
        cookie: cookie(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        consent_transaction: crossSite.transaction,
        decision: "approve",
      }),
    }),
  );
  expect(noOrigin.status).toBe(403);
  const foreignOrigin = await submitConsent(
    handler,
    url,
    { consent_transaction: crossSite.transaction, decision: "approve" },
    { origin: "https://attacker.example" },
  );
  expect(foreignOrigin.status).toBe(403);

  const otherSession = await openConsent(handler, url);
  const wrongSession = await submitConsent(
    handler,
    url,
    { consent_transaction: otherSession.transaction, decision: "approve" },
    { cookie: cookie("sess_mobile_other") },
  );
  expect(wrongSession.status).toBe(400);

  const tampered = await openConsent(handler, url);
  const tamperedUrl = authorizeUrl(challenge, { state: "state-swapped" });
  const tamperedResponse = await submitConsent(handler, tamperedUrl, {
    consent_transaction: tampered.transaction,
    decision: "approve",
  });
  expect(tamperedResponse.status).toBe(400);

  const once = await openConsent(handler, url);
  const first = await submitConsent(handler, url, {
    consent_transaction: once.transaction,
    decision: "approve",
  });
  expect(first.status).toBe(302);
  const replay = await submitConsent(handler, url, {
    consent_transaction: once.transaction,
    decision: "approve",
  });
  expect(replay.status).toBe(400);

  const extraField = await openConsent(handler, url);
  const withExtra = await submitConsent(handler, url, {
    consent_transaction: extraField.transaction,
    decision: "approve",
    scope: "openid",
  });
  expect(withExtra.status).toBe(400);
});

test("a consent transaction cannot be redeemed at the token endpoint or burned there", async () => {
  const { handler } = await setup();
  const { verifier, challenge } = await pkcePair();
  const url = authorizeUrl(challenge);
  const { transaction } = await openConsent(handler, url);

  const redeemed = await token(handler, {
    grant_type: "authorization_code",
    code: transaction,
    redirect_uri: REDIRECT,
    client_id: "takosumi-mobile",
    code_verifier: verifier,
  });
  expect(redeemed.status).toBe(400);
  expect(await redeemed.json()).toEqual({ error: "invalid_grant" });

  const stillValid = await submitConsent(handler, url, {
    consent_transaction: transaction,
    decision: "approve",
  });
  expect(stillValid.status).toBe(302);
  expect(new URL(stillValid.headers.get("location")!).searchParams.get("code")).toBeTruthy();
});

test("silent and widened native authorization requests are refused", async () => {
  const { handler } = await setup();
  const { challenge } = await pkcePair();

  const silent = await handler(
    new Request(authorizeUrl(challenge, { prompt: "none" }), {
      headers: { cookie: cookie() },
    }),
  );
  expect(silent.status).toBe(302);
  expect(new URL(silent.headers.get("location")!).searchParams.get("error")).toBe("consent_required");

  const silentSignedOut = await handler(
    new Request(authorizeUrl(challenge, { prompt: "none" })),
  );
  expect(new URL(silentSignedOut.headers.get("location")!).searchParams.get("error")).toBe("login_required");

  // The scope set Takosumi Mobile used to request is not registered.
  const legacyScopes = await handler(
    new Request(
      authorizeUrl(challenge, {
        scope: "openid offline_access workspaces:read capsules:read runs:read runs:approve runs:cancel",
      }),
      { headers: { cookie: cookie() } },
    ),
  );
  expect(legacyScopes.status).toBe(400);
  expect(await legacyScopes.json()).toMatchObject({ error: "invalid_scope" });

  for (const overrides of [
    { workspace_id: "ws_1" },
    { state: "" },
    { code_challenge: "short" },
    { request_uri: "https://attacker.example/request" },
    { response_mode: "fragment" },
    { prompt: "login" },
    { max_age: "0" },
  ]) {
    const response = await handler(
      new Request(authorizeUrl(challenge, overrides), {
        headers: { cookie: cookie() },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  }

  const signedOut = await handler(new Request(authorizeUrl(challenge)));
  expect(signedOut.status).toBe(302);
  expect(new URL(signedOut.headers.get("location")!).pathname).toBe("/sign-in");

  const signedOutPost = await submitConsent(
    handler,
    authorizeUrl(challenge),
    { consent_transaction: "ncons_x", decision: "approve" },
    { cookie: "" },
  );
  expect(signedOutPost.status).toBe(400);
});

test("ordinary static clients keep issuing codes on GET and still refuse POST", async () => {
  const { handler } = await setup({
    clients: [
      {
        clientId: "plain-native",
        redirectUris: ["plain://oauth/callback"],
        tokenEndpointAuthMethod: "none",
        allowedScopes: ["openid"],
      },
      ...(composeTakosumiMobileOidcClients({ builtinClient: true }).clients ?? []),
    ],
  });
  const { challenge } = await pkcePair();
  const url = authorizeUrl(challenge, {
    client_id: "plain-native",
    redirect_uri: "plain://oauth/callback",
    scope: "openid",
  });
  const direct = await handler(new Request(url, { headers: { cookie: cookie() } }));
  expect(direct.status).toBe(302);
  expect(new URL(direct.headers.get("location")!).searchParams.get("code")).toBeTruthy();

  const post = await submitConsent(handler, url, {
    consent_transaction: "ncons_x",
    decision: "approve",
  });
  expect(post.status).toBe(400);
});

test("authorize POST stays method-not-allowed when no client needs consent", async () => {
  const { handler } = await setup({
    clients: [
      {
        clientId: "plain-native",
        redirectUris: ["plain://oauth/callback"],
        tokenEndpointAuthMethod: "none",
        allowedScopes: ["openid"],
      },
    ],
  });
  const response = await submitConsent(
    handler,
    new URL(`${ISSUER}/oauth/authorize?client_id=plain-native`),
    { consent_transaction: "ncons_x", decision: "approve" },
  );
  expect(response.status).toBe(405);
});

test("English browsers get the English consent screen", async () => {
  const { handler } = await setup();
  const { challenge } = await pkcePair();
  const response = await handler(
    new Request(authorizeUrl(challenge), {
      headers: { cookie: cookie(), "accept-language": "en-US,en;q=0.9" },
    }),
  );
  const html = await response.text();
  expect(html).toContain("Allow Takosumi Mobile to access your account?");
  expect(html).toContain("approve and cancel Runs");
  expect(html).toContain("change connections, sources and workspaces");
});
