import { expect, test } from "bun:test";

import {
  ACCOUNT_SESSION_COOKIE_NAME,
} from "../../../../accounts/service/src/account-session.ts";
import {
  createAccountsHandler,
  type AccountsHandler,
} from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const HTTP_ISSUER = "http://accounts.example.test";
const HTTPS_ISSUER = "https://accounts.example.test";

function handlerFor(
  issuer = HTTP_ISSUER,
  options: {
    readonly loginEmailAllowlist?: {
      readonly emails: readonly string[];
    };
    readonly passkeys?: {
      readonly rpId: string;
      readonly rpName: string;
      readonly origin: string;
    };
  } = {},
): AccountsHandler {
  return createAccountsHandler({
    issuer,
    store: new InMemoryAccountsStore(),
    ...(options.loginEmailAllowlist
      ? { loginEmailAllowlist: options.loginEmailAllowlist }
      : {}),
    ...(options.passkeys ? { passkeys: options.passkeys } : {}),
  });
}

function request(
  issuer: string,
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(`${issuer}${path}`, init);
}

test("Accounts preserves exact 404 versus 405/Allow route boundaries", async () => {
  const handler = handlerFor();

  const unknown = await handler(request(HTTP_ISSUER, "/healthz/"));
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get("allow")).toBeNull();
  expect(await unknown.json()).toMatchObject({
    error: { code: "not_found" },
  });

  const wrongMethod = await handler(
    request(HTTP_ISSUER, "/healthz", {
      method: "POST",
      headers: { origin: HTTP_ISSUER },
    }),
  );
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD");
  expect(await wrongMethod.json()).toMatchObject({
    error: { code: "method_not_allowed" },
  });
});

test("Accounts keeps HEAD support limited to the current GET/HEAD routes", async () => {
  const handler = handlerFor();

  for (const path of [
    "/healthz",
    "/.well-known/openid-configuration",
    "/oauth/jwks",
  ]) {
    const response = await handler(request(HTTP_ISSUER, path, { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
  }

  const getOnly = await handler(
    request(HTTP_ISSUER, "/v1/auth/providers", { method: "HEAD" }),
  );
  expect(getOnly.status).toBe(405);
  expect(getOnly.headers.get("allow")).toBe("GET");
});

test("Accounts preserves malformed path, body, UTF-8, and media-type responses", async () => {
  const handler = handlerFor(HTTP_ISSUER, {
    passkeys: {
      rpId: "accounts.example.test",
      rpName: "Takosumi",
      origin: HTTP_ISSUER,
    },
  });
  const path = "/v1/auth/passkeys/authenticate/options";
  const headers = {
    origin: HTTP_ISSUER,
    "content-type": "application/json",
  };

  const malformedPath = await handler(request(HTTP_ISSUER, "/%ZZ"));
  expect(malformedPath.status).toBe(404);
  expect(await malformedPath.json()).toMatchObject({
    error: { code: "not_found" },
  });

  const malformedJson = await handler(
    request(HTTP_ISSUER, path, {
      method: "POST",
      headers,
      body: "{",
    }),
  );
  expect(malformedJson.status).toBe(400);
  expect(await malformedJson.json()).toMatchObject({
    error: { code: "invalid_request" },
  });

  const invalidUtf8 = await handler(
    request(HTTP_ISSUER, path, {
      method: "POST",
      headers,
      body: new Uint8Array([0xff]),
    }),
  );
  expect(invalidUtf8.status).toBe(400);
  expect(await invalidUtf8.json()).toMatchObject({
    error: {
      code: "invalid_request",
      message: "request body must be valid UTF-8",
    },
  });

  const wrongMediaType = await handler(
    request(HTTP_ISSUER, path, {
      method: "POST",
      headers: { origin: HTTP_ISSUER, "content-type": "text/plain" },
      body: "{}",
    }),
  );
  expect(wrongMediaType.status).toBe(415);
  expect(await wrongMediaType.json()).toMatchObject({
    error: { code: "unsupported_media_type" },
  });
});

test("Accounts requires the issuer Origin for cookie mutations", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_origin",
    email: "origin@example.test",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_origin",
    subject: "tsub_origin",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const handler = createAccountsHandler({ issuer: HTTP_ISSUER, store });
  const cookie = `${ACCOUNT_SESSION_COOKIE_NAME}=sess_origin`;

  const crossSite = await handler(
    request(HTTP_ISSUER, "/v1/account/session/me", {
      method: "DELETE",
      headers: { cookie, origin: "https://evil.example.test" },
    }),
  );
  expect(crossSite.status).toBe(403);
  expect(await crossSite.json()).toMatchObject({
    error: { code: "csrf_failed" },
  });
  expect(store.findAccountSession("sess_origin")).toBeDefined();

  const sameOrigin = await handler(
    request(HTTP_ISSUER, "/v1/account/session/me", {
      method: "DELETE",
      headers: { cookie, origin: HTTP_ISSUER },
    }),
  );
  expect(sameOrigin.status).toBe(204);
  expect(store.findAccountSession("sess_origin")).toBeUndefined();
});

test("the OAuth callback exception applies only to the exact GET path", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_callback",
    email: "removed@example.test",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_callback",
    subject: "tsub_callback",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const handler = createAccountsHandler({
    issuer: HTTPS_ISSUER,
    store,
    loginEmailAllowlist: { emails: ["kept@example.test"] },
  });
  const cookie = `${ACCOUNT_SESSION_COOKIE_NAME}=sess_callback`;

  const exactGet = await handler(
    request(HTTPS_ISSUER, "/v1/auth/upstream/callback?provider=google", {
      headers: { cookie },
    }),
  );
  // No provider is configured, but the exact callback path is allowed to
  // reach its own protocol response without an Origin or allowlist gate.
  expect(exactGet.status).toBe(503);
  expect(await exactGet.json()).toMatchObject({
    error: "feature_unavailable",
  });
  expect(store.findAccountSession("sess_callback")).toBeDefined();

  const trailingPath = await handler(
    request(HTTPS_ISSUER, "/v1/auth/upstream/callback/?provider=google", {
      headers: { cookie },
    }),
  );
  expect(trailingPath.status).toBe(403);
  expect(await trailingPath.json()).toMatchObject({
    error: { code: "login_not_allowed" },
  });
  expect(store.findAccountSession("sess_callback")).toBeUndefined();

  const crossSitePost = await handler(
    request(HTTPS_ISSUER, "/v1/auth/upstream/callback?provider=google", {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(crossSitePost.status).toBe(403);
  expect(await crossSitePost.json()).toMatchObject({
    error: { code: "csrf_failed" },
  });
});

test("Accounts emits baseline security headers and HTTPS-only HSTS", async () => {
  const expected = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
  };

  const httpResponse = await handlerFor(HTTP_ISSUER)(
    request(HTTP_ISSUER, "/does-not-exist"),
  );
  expect(httpResponse.status).toBe(404);
  for (const [name, value] of Object.entries(expected)) {
    expect(httpResponse.headers.get(name)).toBe(value);
  }
  expect(httpResponse.headers.get("strict-transport-security")).toBeNull();

  const httpsResponse = await handlerFor(HTTPS_ISSUER)(
    request(HTTPS_ISSUER, "/does-not-exist"),
  );
  expect(httpsResponse.status).toBe(404);
  for (const [name, value] of Object.entries(expected)) {
    expect(httpsResponse.headers.get(name)).toBe(value);
  }
  expect(httpsResponse.headers.get("strict-transport-security")).toBe(
    "max-age=31536000; includeSubDomains; preload",
  );
});
