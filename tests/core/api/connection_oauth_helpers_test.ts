import { expect, test } from "bun:test";

import { createConnectionOAuthHelpers } from "../../../core/api/connection_oauth_helpers.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { connectionOAuthDescriptorsFromEnv } from "../../../providers/registry.ts";

function createReferenceConnectionOAuthHelpers(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
) {
  return createConnectionOAuthHelpers(
    {
      stateSecret: env.TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET,
      descriptors: connectionOAuthDescriptorsFromEnv(env),
    },
    fetchImpl,
  );
}

const PRINCIPAL = {
  actor: "acct_1",
  workspaceIds: ["ws_1"],
  operations: "*",
  runnerProfileIds: "*",
} as const;

test("generic OAuth engine installs an opaque host descriptor", async () => {
  const helpers = createConnectionOAuthHelpers(
    {
      stateSecret: "state-secret",
      descriptors: [
        {
          id: "acme-login",
          providerSource: "registry.example.test/acme/widgets",
          credentialRecipe: {
            id: "operator-acme",
            authMode: "oauth-bearer",
            secretPartition: "operator-acme",
          },
          clientId: "acme-client",
          authorizationUrl: "https://identity.acme.test/authorize",
          tokenUrl: "https://identity.acme.test/token",
          redirectUri: "https://operator.example.test/oauth/acme/callback",
          scopes: ["widgets.write"],
          mapTokenResponse: ({ tokenResponse }) => ({
            ACME_BEARER: String(tokenResponse.opaque_credential ?? ""),
          }),
        },
      ],
    },
    (async () =>
      Response.json({
        opaque_credential: "acme-run-credential",
      })) as typeof fetch,
  );

  expect(Object.keys(helpers ?? {})).toEqual(["acme-login"]);
  const started = await helpers!["acme-login"]!.start({
    helperId: "acme-login",
    request: new Request("https://operator.example.test/oauth/start"),
    principal: PRINCIPAL,
    body: { workspaceId: "ws_1", subject: "acct_1" },
  });
  const completed = await helpers!["acme-login"]!.complete({
    helperId: "acme-login",
    request: new Request("https://operator.example.test/oauth/callback"),
    principal: PRINCIPAL,
    code: "opaque-code",
    state: started.state,
    query: { code: "opaque-code", state: started.state },
  });

  expect(completed.request).toMatchObject({
    provider: "registry.example.test/acme/widgets",
    credentialRecipe: {
      id: "operator-acme",
      authMode: "oauth-bearer",
      secretPartition: "operator-acme",
    },
    values: { ACME_BEARER: "acme-run-credential" },
  });
});

test("Cloudflare OAuth helper signs state and returns an internal provider resolver request", async () => {
  let tokenRequest:
    | {
        readonly url: string;
        readonly body: string;
      }
    | undefined;
  const helpers = createReferenceConnectionOAuthHelpers(
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
    helperId: "cloudflare",
    request: new Request("https://app.example.test/start"),
    principal: PRINCIPAL,
    body: {
      workspaceId: "ws_1",
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
    helperId: "cloudflare",
    request: new Request("https://app.example.test/callback"),
    principal: PRINCIPAL,
    code: "cf-code",
    state: started!.state,
    query: { code: "cf-code", state: started!.state },
  });
  expect(tokenRequest?.url).toBe("https://api.cloudflare.test/oauth2/token");
  expect(tokenRequest?.body).toContain("code=cf-code");
  expect(completion.request).toEqual({
    workspaceId: "ws_1",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    credentialRecipe: {
      id: "cloudflare",
      authMode: "oauth",
      secretPartition: "provider-credentials",
    },
    materialization: "oauth",
    displayName: "Cloudflare OAuth",
    scopeHints: { accountId: "acct_cf" },
    values: { CLOUDFLARE_API_TOKEN: "cf-access-token" },
  });
  // The HMAC-signed subject rides the state so the cross-site callback can
  // authorize without a session cookie.
  expect(completion.subject).toBe("tsub_owner");
});

test("Cloudflare OAuth state binds the subject under the HMAC: tampering fails verification", async () => {
  const helpers = createReferenceConnectionOAuthHelpers(
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
    helperId: "cloudflare",
    request: new Request("https://app.example.test/start"),
    principal: PRINCIPAL,
    body: { workspaceId: "ws_1", subject: "tsub_owner" },
  });
  // Re-sign would be needed to change the subject; flipping the payload alone
  // breaks the signature, so verifyState (and thus complete) rejects it.
  const [payload, signature] = started!.state.split(".");
  const forgedPayloadJson = JSON.stringify({
    helperId: "cloudflare",
    expiresAt: Date.now() + 60_000,
    body: { workspaceId: "ws_1", subject: "tsub_attacker" },
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
      helperId: "cloudflare",
      request: new Request("https://app.example.test/callback"),
      principal: PRINCIPAL,
      code: "cf-code",
      state: forgedState,
      query: { code: "cf-code", state: forgedState },
    }),
  ).rejects.toThrow();
});

test("GCP OAuth helper creates authorized_user GOOGLE_CREDENTIALS", async () => {
  const helpers = createReferenceConnectionOAuthHelpers(
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
    helperId: "gcp",
    request: new Request("https://app.example.test/start"),
    principal: PRINCIPAL,
    body: { workspaceId: "ws_1", displayName: "GCP OAuth" },
  });
  expect(started).toBeDefined();
  const authUrl = new URL(started!.authorizationUrl);
  expect(authUrl.origin + authUrl.pathname).toBe(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  expect(authUrl.searchParams.get("access_type")).toBe("offline");
  expect(authUrl.searchParams.get("prompt")).toBe("consent");

  const completion = await helpers!.gcp!.complete({
    helperId: "gcp",
    request: new Request("https://app.example.test/callback"),
    principal: PRINCIPAL,
    code: "gcp-code",
    state: started!.state,
    query: { code: "gcp-code", state: started!.state },
  });
  const request = completion.request;
  expect(request.provider).toBe("registry.opentofu.org/hashicorp/google");
  expect(request.credentialRecipe).toEqual({
    id: "google",
    authMode: "oauth",
    secretPartition: "provider-credentials",
  });
  expect(request.materialization).toBe("oauth");
  const credentials = JSON.parse(request.values.GOOGLE_CREDENTIALS);
  expect(credentials).toEqual({
    type: "authorized_user",
    client_id: "gcp-client",
    client_secret: "gcp-secret",
    refresh_token: "gcp-refresh",
  });
});

test("OAuth helpers are absent until state secret and provider config exist", () => {
  expect(createReferenceConnectionOAuthHelpers({})).toBeUndefined();
  expect(
    createReferenceConnectionOAuthHelpers({
      TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET: "state-secret",
    }),
  ).toBeUndefined();
});

test("Core does not install vendor OAuth helpers from runtime env", async () => {
  const created = await createTakosumiService({
    runtimeEnv: {
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET: "state-secret",
      TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client",
      TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI:
        "https://operator.example.test/oauth/cloudflare/callback",
      TAKOSUMI_CLOUDFLARE_OAUTH_AUTHORIZATION_URL:
        "https://dash.cloudflare.test/oauth2/auth",
      TAKOSUMI_CLOUDFLARE_OAUTH_TOKEN_URL:
        "https://api.cloudflare.test/oauth2/token",
    },
  });

  expect(created.operations.connectionOAuth).toBeUndefined();
});
