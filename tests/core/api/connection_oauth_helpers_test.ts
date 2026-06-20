import { expect, test } from "bun:test";

import { createConnectionOAuthHelpersFromEnv } from "../../../core/api/connection_oauth_helpers.ts";

const PRINCIPAL = {
  actor: "acct_1",
  spaceIds: ["space_1"],
  operations: "*",
  runnerProfileIds: "*",
} as const;

test("Cloudflare OAuth helper signs state and returns an internal provider resolver request", async () => {
  let tokenRequest:
    | {
        readonly url: string;
        readonly body: string;
      }
    | undefined;
  const helpers = createConnectionOAuthHelpersFromEnv(
    {
      TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET: "state-secret",
      TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client",
      TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
      TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI:
        "https://app.example.test/api/connections/cloudflare/oauth/callback",
      TAKOSUMI_CLOUDFLARE_OAUTH_AUTHORIZATION_URL:
        "https://dash.cloudflare.test/oauth2/auth",
      TAKOSUMI_CLOUDFLARE_OAUTH_TOKEN_URL:
        "https://api.cloudflare.test/oauth2/token",
      TAKOSUMI_CLOUDFLARE_OAUTH_SCOPES: "account:read zone:read",
    },
    (async (input, init) => {
      tokenRequest = {
        url: String(input),
        body: String(init?.body ?? ""),
      };
      return Response.json({ access_token: "cf-access-token" });
    }) as typeof fetch,
  );

  const started = await helpers?.cloudflare?.start({
    provider: "cloudflare",
    request: new Request("https://app.example.test/start"),
    principal: PRINCIPAL,
    body: {
      spaceId: "space_1",
      displayName: "Cloudflare OAuth",
      scopeHints: { accountId: "acct_cf" },
      // The cookie-gated start binds the authenticated subject into the state.
      subject: "tsub_owner",
    },
  });
  expect(started).toBeDefined();
  const authUrl = new URL(started!.authorizationUrl);
  expect(authUrl.origin + authUrl.pathname).toBe(
    "https://dash.cloudflare.test/oauth2/auth",
  );
  expect(authUrl.searchParams.get("client_id")).toBe("cf-client");
  expect(authUrl.searchParams.get("scope")).toBe("account:read zone:read");

  const completion = await helpers!.cloudflare!.complete({
    provider: "cloudflare",
    request: new Request("https://app.example.test/callback"),
    principal: PRINCIPAL,
    code: "cf-code",
    state: started!.state,
    query: { code: "cf-code", state: started!.state },
  });
  expect(tokenRequest?.url).toBe("https://api.cloudflare.test/oauth2/token");
  expect(tokenRequest?.body).toContain("code=cf-code");
  expect(completion.request).toEqual({
    spaceId: "space_1",
    provider: "cloudflare",
    kind: "generic_env_provider",
    credentialDriver: "cloudflare_oauth",
    authMethod: "static_secret",
    displayName: "Cloudflare OAuth",
    scopeHints: { accountId: "acct_cf" },
    values: { CLOUDFLARE_API_TOKEN: "cf-access-token" },
  });
  // The HMAC-signed subject rides the state so the cross-site callback can
  // authorize without a session cookie.
  expect(completion.subject).toBe("tsub_owner");
});

test("Cloudflare OAuth state binds the subject under the HMAC: tampering fails verification", async () => {
  const helpers = createConnectionOAuthHelpersFromEnv(
    {
      TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET: "state-secret",
      TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client",
      TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI:
        "https://app.example.test/api/connections/cloudflare/oauth/callback",
      TAKOSUMI_CLOUDFLARE_OAUTH_AUTHORIZATION_URL:
        "https://dash.cloudflare.test/oauth2/auth",
      TAKOSUMI_CLOUDFLARE_OAUTH_TOKEN_URL:
        "https://api.cloudflare.test/oauth2/token",
    },
    (async () =>
      Response.json({ access_token: "cf-access-token" })) as typeof fetch,
  );
  const started = await helpers!.cloudflare!.start({
    provider: "cloudflare",
    request: new Request("https://app.example.test/start"),
    principal: PRINCIPAL,
    body: { spaceId: "space_1", subject: "tsub_owner" },
  });
  // Re-sign would be needed to change the subject; flipping the payload alone
  // breaks the signature, so verifyState (and thus complete) rejects it.
  const [payload, signature] = started!.state.split(".");
  const forgedPayloadJson = JSON.stringify({
    provider: "cloudflare",
    expiresAt: Date.now() + 60_000,
    body: { spaceId: "space_1", subject: "tsub_attacker" },
    subject: "tsub_attacker",
  });
  const forgedPayload = btoa(forgedPayloadJson)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  expect(forgedPayload).not.toBe(payload);
  const forgedState = `${forgedPayload}.${signature}`;
  await expect(
    helpers!.cloudflare!.complete({
      provider: "cloudflare",
      request: new Request("https://app.example.test/callback"),
      principal: PRINCIPAL,
      code: "cf-code",
      state: forgedState,
      query: { code: "cf-code", state: forgedState },
    }),
  ).rejects.toThrow();
});

test("GCP OAuth helper creates authorized_user GOOGLE_CREDENTIALS", async () => {
  const helpers = createConnectionOAuthHelpersFromEnv(
    {
      TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET: "state-secret",
      TAKOSUMI_GCP_OAUTH_CLIENT_ID: "gcp-client",
      TAKOSUMI_GCP_OAUTH_CLIENT_SECRET: "gcp-secret",
      TAKOSUMI_GCP_OAUTH_REDIRECT_URI:
        "https://app.example.test/api/connections/gcp/oauth/callback",
    },
    (async () =>
      Response.json({ refresh_token: "gcp-refresh" })) as typeof fetch,
  );

  const started = await helpers?.gcp?.start({
    provider: "gcp",
    request: new Request("https://app.example.test/start"),
    principal: PRINCIPAL,
    body: { spaceId: "space_1", displayName: "GCP OAuth" },
  });
  expect(started).toBeDefined();
  const authUrl = new URL(started!.authorizationUrl);
  expect(authUrl.origin + authUrl.pathname).toBe(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  expect(authUrl.searchParams.get("access_type")).toBe("offline");
  expect(authUrl.searchParams.get("prompt")).toBe("consent");

  const completion = await helpers!.gcp!.complete({
    provider: "gcp",
    request: new Request("https://app.example.test/callback"),
    principal: PRINCIPAL,
    code: "gcp-code",
    state: started!.state,
    query: { code: "gcp-code", state: started!.state },
  });
  const request = completion.request;
  expect(request.provider).toBe("google");
  expect(request.kind).toBe("generic_env_provider");
  expect(request.credentialDriver).toBe("gcp_oauth_bootstrap");
  const credentials = JSON.parse(request.values.GOOGLE_CREDENTIALS);
  expect(credentials).toEqual({
    type: "authorized_user",
    client_id: "gcp-client",
    client_secret: "gcp-secret",
    refresh_token: "gcp-refresh",
  });
});

test("OAuth helpers are absent until state secret and provider config exist", () => {
  expect(createConnectionOAuthHelpersFromEnv({})).toBeUndefined();
  expect(
    createConnectionOAuthHelpersFromEnv({
      TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET: "state-secret",
    }),
  ).toBeUndefined();
});
