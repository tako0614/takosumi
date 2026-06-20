import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuDeploymentController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
import { StaticSecretConnectionVault } from "../../../core/adapters/vault/mod.ts";
import { MultiCloudSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { ActivityService } from "../../../core/domains/activity/mod.ts";
import { ConnectionsService } from "../../../core/domains/connections/mod.ts";
import type { DeployControlInternalRouteDependencies } from "../../../core/api/deploy_control_internal_routes.ts";

const SPACE_ID = "space_10000001";

function makeApp(
  options: {
    fetch?: typeof fetch;
    connectionOAuthHelpers?: DeployControlInternalRouteDependencies["connectionOAuthHelpers"];
    allowOperatorBackedProviderEnvs?: boolean;
  } = {},
) {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "route-test-passphrase-0123456789-abcdef",
    }),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => `conn_route${(counter += 1).toString().padStart(11, "0")}`,
    fetch: options.fetch as never,
  });
  const activityService = new ActivityService({
    store,
    now: () => new Date("2026-06-04T00:00:00.000Z"),
  });
  const connectionsService = new ConnectionsService({
    store,
    now: () => "2026-06-04T00:00:00.000Z",
    newId: (prefix) => `${prefix}_route_default`,
    allowOperatorBackedProviderEnvs:
      options.allowOperatorBackedProviderEnvs === true,
  });
  const controller = new OpenTofuDeploymentController({
    store,
    vault,
    allowOperatorBackedProviderEnvs:
      options.allowOperatorBackedProviderEnvs === true,
  });
  return createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      activityService,
      connectionsService,
      ...(options.connectionOAuthHelpers
        ? { connectionOAuthHelpers: options.connectionOAuthHelpers }
        : {}),
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_1",
              spaceIds: [SPACE_ID],
              operations: "*",
              runnerProfileIds: "*",
            }
          : token === "operator-token"
            ? {
                actor: "op",
                spaceIds: "*",
                operations: "*",
                runnerProfileIds: "*",
              }
            : undefined,
    },
    requestCorrelation: false,
  });
}

const CF_PATH = "/internal/v1/connections/cloudflare/token";
const HTTPS_PATH = "/internal/v1/connections/source/https-token";
const SSH_PATH = "/internal/v1/connections/source/ssh-key";
const AWS_PATH = "/internal/v1/connections/aws/assume-role";
const GCP_IMPERSONATION_PATH = "/internal/v1/connections/gcp/impersonation";
const GENERIC_ENV_PROVIDER_PATH =
  "/internal/v1/connections/generic-env-provider";
const RESERVED_DRIVER_PATHS = [
  ["POST", "/internal/v1/connections/cloudflare/oauth/start"],
  ["GET", "/internal/v1/connections/cloudflare/oauth/callback"],
  ["POST", "/internal/v1/connections/gcp/oauth/start"],
  ["GET", "/internal/v1/connections/gcp/oauth/callback"],
] as const;

const HEADERS = {
  authorization: "Bearer scoped-token",
  "content-type": "application/json",
} as const;

function stsSuccessXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>ASIA_assumed</AccessKeyId>
      <SecretAccessKey>assumed_secret</SecretAccessKey>
      <SessionToken>assumed_session</SessionToken>
      <Expiration>2026-06-04T01:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleResult>
</AssumeRoleResponse>`;
}

test("POST /internal/v1/connections/cloudflare/token requires a bearer (401)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spaceId: SPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf" },
    }),
  });
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});

test("POST /internal/v1/connections/cloudflare/token rejects an unknown body field (400)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf" },
      sneaky: "field",
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});

test("POST /internal/v1/connections/cloudflare/token enforces space scope (403)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: "space_denied",
      values: { CLOUDFLARE_API_TOKEN: "cf" },
    }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("POST /internal/v1/connections/cloudflare/token rejects a space session asking scope:operator (403)", async () => {
  const app = await makeApp();
  // Privilege-escalation guard: a space session (scoped-token, spaceIds:
  // [SPACE_ID]) supplies its OWN spaceId but asks for `scope: "operator"`. The
  // spaceId alone would pass the space permission check, so the gate must
  // additionally require the unrestricted bearer for any operator-scope request.
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      scope: "operator",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("POST /internal/v1/connections/cloudflare/token happy path returns 201 and never echoes values", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      displayName: "prod",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("cf-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connection.status).toBe("pending");
  expect(payload.connection.provider).toBe("cloudflare");
  expect(payload.connection.kind).toBe("cloudflare_api_token");
  expect(payload.connection.credentialDriver).toBe("cloudflare_api_token");
  expect(payload.connection.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
  expect(payload.connection.values).toBeUndefined();

  const activity = await app.request(
    `/internal/v1/spaces/${SPACE_ID}/activity`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(activity.status).toBe(200);
  const events = (await activity.json()).events;
  const createdEvent = events.find(
    (event: { action: string }) => event.action === "connection.created",
  );
  expect(createdEvent).toBeDefined();
  expect(createdEvent.metadata).toEqual({
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    scope: "space",
  });
  expect(JSON.stringify(events)).not.toContain("cf-secret-token");
});

test("POST /internal/v1/connections/source/https-token returns 201 with the source kind", async () => {
  const app = await makeApp();
  const response = await app.request(HTTPS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      displayName: "github",
      scopeHints: { username: "git" },
      values: { GIT_HTTPS_TOKEN: "ghp-secret" },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("ghp-secret");
  const payload = JSON.parse(text);
  expect(payload.connection.kind).toBe("source_git_https_token");
});

test("POST /internal/v1/connections/source/ssh-key requires knownHosts (400)", async () => {
  const app = await makeApp();
  const response = await app.request(SSH_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      values: { GIT_SSH_PRIVATE_KEY: "-----BEGIN KEY-----" },
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("knownHostsEntry");
});

test("POST /internal/v1/connections/source/ssh-key with knownHosts returns 201", async () => {
  const app = await makeApp();
  const response = await app.request(SSH_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      scopeHints: { knownHostsEntry: "github.com ssh-ed25519 AAAA..." },
      values: {
        GIT_SSH_PRIVATE_KEY:
          "-----BEGIN KEY-----\nprivatekeymaterial\n-----END KEY-----",
      },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("privatekeymaterial");
  expect(JSON.parse(text).connection.kind).toBe("source_git_ssh_key");
});

test("POST /internal/v1/connections/aws/assume-role requires a role ARN hint (400)", async () => {
  const app = await makeApp();
  const response = await app.request(AWS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      values: {
        AWS_ACCESS_KEY_ID: "akid",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("awsRoleArn");
});

test("POST /internal/v1/connections/aws/assume-role returns 201 and never echoes values", async () => {
  const app = await makeApp();
  const response = await app.request(AWS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      displayName: "prod aws",
      scopeHints: {
        awsRoleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
        awsExternalId: SPACE_ID,
        awsRegion: "us-east-1",
      },
      values: {
        AWS_ACCESS_KEY_ID: "akid",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("aws-secret");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe("aws");
  expect(payload.connection.kind).toBe("aws_assume_role");
  expect(payload.connection.credentialDriver).toBe("aws_assume_role");
  expect(payload.connection.authMethod).toBe("static_secret");
  expect(payload.connection.scopeHints.awsRoleArn).toBe(
    "arn:aws:iam::123456789012:role/takosumi-prod",
  );
  expect(payload.connection.envNames).toEqual([
    "AWS_ACCESS_KEY_ID",
    "AWS_REGION",
    "AWS_ROLE_ARN",
    "AWS_SECRET_ACCESS_KEY",
  ]);
  expect(payload.connection.values).toBeUndefined();
});

test("POST /internal/v1/connections/generic-env-provider registers an own-key Provider Connection", async () => {
  const app = await makeApp();
  const response = await app.request(GENERIC_ENV_PROVIDER_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      provider: "registry.opentofu.org/integrations/github",
      displayName: "github",
      values: { GITHUB_TOKEN: "github-secret-token" },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("github-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe(
    "registry.opentofu.org/integrations/github",
  );
  expect(payload.connection.kind).toBe("generic_env_provider");
  expect(payload.connection.credentialDriver).toBe("generic_env");
  expect(payload.connection.scope).toBe("space");
  expect(payload.connection.envNames).toEqual(["GITHUB_TOKEN"]);
});

test("POST /internal/v1/connections/generic-env-provider rejects operator scope", async () => {
  const app = await makeApp();
  const response = await app.request(GENERIC_ENV_PROVIDER_PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer operator-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: SPACE_ID,
      scope: "operator",
      provider: "registry.opentofu.org/integrations/github",
      values: { GITHUB_TOKEN: "github-secret-token" },
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("Space-scoped");
});

test("unconfigured OAuth helper routes authenticate first then return 501", async () => {
  const app = await makeApp();
  for (const [method, path] of RESERVED_DRIVER_PATHS) {
    const unauthenticated = await app.request(path, { method });
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json()).error.code).toBe("unauthenticated");

    const reserved = await app.request(path, {
      method,
      headers: { authorization: "Bearer scoped-token" },
    });
    expect(reserved.status).toBe(501);
    const payload = await reserved.json();
    expect(payload.error.code).toBe("not_implemented");
    expect(payload.error.message).toContain("connection driver not wired");
  }
});

test("Cloudflare OAuth helper starts and completes as a write-only Provider Connection", async () => {
  const app = await makeApp({
    connectionOAuthHelpers: {
      cloudflare: {
        start: async ({ body }) => ({
          authorizationUrl:
            "https://dash.cloudflare.test/oauth2/auth?state=state_cf",
          state: "state_cf",
          ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
        }),
        complete: async ({ code, state }) => ({
          request: {
            spaceId: SPACE_ID,
            provider: "cloudflare",
            kind: "generic_env_provider",
            authMethod: "static_secret",
            displayName: "cf oauth",
            values: {
              CLOUDFLARE_API_TOKEN: `oauth-token-${code}-${state}`,
            },
          },
        }),
      },
    },
  });

  const started = await app.request(
    "/internal/v1/connections/cloudflare/oauth/start",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        spaceId: SPACE_ID,
        displayName: "cf oauth",
        redirectUri: "https://app.example.test/callback",
      }),
    },
  );
  expect(started.status).toBe(200);
  expect(await started.json()).toEqual({
    authorizationUrl: "https://dash.cloudflare.test/oauth2/auth?state=state_cf",
    state: "state_cf",
  });

  const completed = await app.request(
    "/internal/v1/connections/cloudflare/oauth/callback?code=code_cf&state=state_cf",
    {
      method: "GET",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(completed.status).toBe(201);
  const text = await completed.text();
  expect(text).not.toContain("oauth-token-code_cf-state_cf");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe("cloudflare");
  expect(payload.connection.kind).toBe("generic_env_provider");
  expect(payload.connection.credentialDriver).toBe("cloudflare_oauth");
  expect(payload.connection.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
});

test("OAuth callback requires code and state once helper is configured", async () => {
  const app = await makeApp({
    connectionOAuthHelpers: {
      gcp: {
        start: async () => ({
          authorizationUrl: "https://accounts.google.test/o/oauth2/v2/auth",
          state: "state_gcp",
        }),
        complete: async () => ({
          request: {
            spaceId: SPACE_ID,
            provider: "google",
            kind: "generic_env_provider",
            authMethod: "static_secret",
            values: { GOOGLE_CREDENTIALS: "{}" },
          },
        }),
      },
    },
  });

  const missing = await app.request(
    "/internal/v1/connections/gcp/oauth/callback",
    {
      method: "GET",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(missing.status).toBe(400);
  expect((await missing.json()).error.message).toContain("code");
});

test("POST /internal/v1/connections/gcp/impersonation registers a Google Provider Connection", async () => {
  const app = await makeApp();
  const response = await app.request(GCP_IMPERSONATION_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      displayName: "gcp impersonation",
      scopeHints: {
        gcpServiceAccountEmail:
          "takosumi-runner@project-1.iam.gserviceaccount.com",
        gcpProjectId: "project-1",
      },
      values: {
        GOOGLE_CREDENTIALS:
          '{"type":"authorized_user","refresh_token":"secret-refresh"}',
      },
    }),
  });

  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("secret-refresh");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe("google");
  expect(payload.connection.kind).toBe("gcp_service_account_impersonation");
  expect(payload.connection.credentialDriver).toBe(
    "gcp_service_account_impersonation",
  );
  expect(payload.connection.envNames).toEqual(["GOOGLE_CREDENTIALS"]);
  expect(payload.connection.scopeHints).toEqual({
    gcpServiceAccountEmail: "takosumi-runner@project-1.iam.gserviceaccount.com",
    gcpProjectId: "project-1",
  });
});

test("POST /internal/v1/connections/gcp/impersonation requires service account and project hints", async () => {
  const app = await makeApp();
  const response = await app.request(GCP_IMPERSONATION_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      scopeHints: {
        gcpServiceAccountEmail: "svc@example.iam.gserviceaccount.com",
      },
      values: { GOOGLE_CREDENTIALS: "{}" },
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toContain("gcpProjectId");
});

test("GET /internal/v1/connections lists connections without secret values", async () => {
  const app = await makeApp();
  await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });

  const response = await app.request(
    `/internal/v1/connections?spaceId=${SPACE_ID}`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("cf-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connections).toHaveLength(1);
  expect(payload.connections[0].provider).toBe("cloudflare");
});

test("GET /internal/v1/connections with no spaceId lists operator-scoped connections for the unrestricted bearer", async () => {
  const app = await makeApp();
  // Operator-scoped connection (no spaceId): only the unrestricted bearer.
  await app.request(CF_PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer operator-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      scope: "operator",
      values: { CLOUDFLARE_API_TOKEN: "op-secret-token" },
    }),
  });

  const response = await app.request("/internal/v1/connections", {
    headers: { authorization: "Bearer operator-token" },
  });
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.connections).toHaveLength(1);
  expect(payload.connections[0].scope).toBe("operator");
});

test("GET /internal/v1/connections with no spaceId is denied for a scoped bearer (403)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/connections", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("internal provider resolver records reject global OSS records and allow scoped Space records", async () => {
  const app = await makeApp();
  const globalGatewayBody = {
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    displayName: "Cloud-only gateway materialization",
    materialization: "gateway",
    gatewayProfileId: "cloudflare-default",
    requiredEnvNames: [],
  };

  const globalGatewayDenied = await app.request(
    "/internal/v1/provider-envs/penv_globalcf0001",
    {
      method: "PUT",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(globalGatewayBody),
    },
  );
  expect(globalGatewayDenied.status).toBe(400);
  expect((await globalGatewayDenied.json()).error.code).toBe("invalid_argument");

  const globalSecretDenied = await app.request(
    "/internal/v1/provider-envs/penv_globalsecret1",
    {
      method: "PUT",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        displayName: "Global secret",
        materialization: "secret",
        requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
        secretRef: "conn_operator_secret",
      }),
    },
  );
  expect(globalSecretDenied.status).toBe(400);
  expect((await globalSecretDenied.json()).error.code).toBe("invalid_argument");

  const listed = await app.request("/internal/v1/provider-envs", {
    headers: { authorization: "Bearer operator-token" },
  });
  expect(listed.status).toBe(200);
  expect((await listed.json()).providerEnvs).toHaveLength(0);

  const spaceCreated = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "space-secret-token" },
    }),
  });
  expect(spaceCreated.status).toBe(201);
  const spaceConnection = (await spaceCreated.json()).connection;
  const storedSpaceEnv = await app.request(
    "/internal/v1/provider-envs/penv_spacecf0001",
    {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        spaceId: SPACE_ID,
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        displayName: "Cloudflare Space secret",
        materialization: "secret",
        requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
        secretRef: spaceConnection.id,
      }),
    },
  );
  expect(storedSpaceEnv.status).toBe(200);
  const storedSpaceEnvPayload = await storedSpaceEnv.json();
  expect(storedSpaceEnvPayload.providerEnv).toMatchObject({
    id: "penv_spacecf0001",
    spaceId: SPACE_ID,
    materialization: "secret",
    status: "needs_setup",
  });
  expect(JSON.stringify(storedSpaceEnvPayload)).not.toContain("secretRef");

  const readSpaceEnv = await app.request(
    "/internal/v1/provider-envs/penv_spacecf0001",
    {
      headers: HEADERS,
    },
  );
  expect(readSpaceEnv.status).toBe(200);
  expect(JSON.stringify(await readSpaceEnv.json())).not.toContain("secretRef");

  const listedSpaceEnv = await app.request(
    `/internal/v1/provider-envs?spaceId=${SPACE_ID}`,
    {
      headers: HEADERS,
    },
  );
  expect(listedSpaceEnv.status).toBe(200);
  expect(JSON.stringify(await listedSpaceEnv.json())).not.toContain(
    "secretRef",
  );
});

test("operator-backed provider resolver records are Cloud-only and operator-gated", async () => {
  const app = await makeApp();
  const operatorConnectionResponse = await app.request(CF_PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer operator-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      scope: "operator",
      values: { CLOUDFLARE_API_TOKEN: "operator-secret-token" },
    }),
  });
  expect(operatorConnectionResponse.status).toBe(201);
  const operatorConnection = (await operatorConnectionResponse.json())
    .connection;

  const scopedDenied = await app.request(
    "/internal/v1/provider-envs/penv_operatorbacked1",
    {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        spaceId: SPACE_ID,
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        displayName: "Takosumi provided Cloudflare",
        materialization: "secret",
        requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
        secretRef: operatorConnection.id,
      }),
    },
  );
  expect(scopedDenied.status).toBe(403);
  expect((await scopedDenied.json()).error.code).toBe("permission_denied");

  const ossDenied = await app.request(
    "/internal/v1/provider-envs/penv_operatorbacked1",
    {
      method: "PUT",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: SPACE_ID,
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        displayName: "Takosumi provided Cloudflare",
        materialization: "secret",
        requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
        secretRef: operatorConnection.id,
      }),
    },
  );
  expect(ossDenied.status).toBe(403);
  expect((await ossDenied.json()).error.message).toContain("operator-scoped");

  const cloudApp = await makeApp({ allowOperatorBackedProviderEnvs: true });
  const cloudOperatorConnectionResponse = await cloudApp.request(CF_PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer operator-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      scope: "operator",
      values: { CLOUDFLARE_API_TOKEN: "operator-secret-token" },
    }),
  });
  expect(cloudOperatorConnectionResponse.status).toBe(201);
  const cloudOperatorConnection = (await cloudOperatorConnectionResponse.json())
    .connection;
  const cloudCreated = await cloudApp.request(
    "/internal/v1/provider-envs/penv_operatorbacked1",
    {
      method: "PUT",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: SPACE_ID,
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        displayName: "Takosumi provided Cloudflare",
        materialization: "secret",
        requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
        secretRef: cloudOperatorConnection.id,
      }),
    },
  );
  expect(cloudCreated.status).toBe(200);
  expect(await cloudCreated.json()).toMatchObject({
    providerEnv: {
      id: "penv_operatorbacked1",
      spaceId: SPACE_ID,
      materialization: "secret",
      status: "needs_setup",
    },
  });
});

test("POST /internal/v1/connections/{id}/test verifies via injected fetch (200 verified)", async () => {
  const fakeFetch = (): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({ success: true, result: { status: "active" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const app = await makeApp({ fetch: fakeFetch as never });
  const created = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  const { connection } = await created.json();

  const tested = await app.request(
    `/internal/v1/connections/${connection.id}/test`,
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(tested.status).toBe(200);
  expect((await tested.json()).status).toBe("verified");
});

test("POST /internal/v1/connections/{id}/test verifies aws assume-role via STS (200 verified)", async () => {
  let called:
    | {
        readonly url: string;
        readonly auth: string | null;
        readonly body: string;
      }
    | undefined;
  const fakeFetch = (input: string, init?: RequestInit): Promise<Response> => {
    called = {
      url: input,
      auth: new Headers(init?.headers).get("authorization"),
      body: String(init?.body ?? ""),
    };
    return Promise.resolve(
      new Response(stsSuccessXml(), {
        status: 200,
        headers: { "content-type": "text/xml" },
      }),
    );
  };
  const app = await makeApp({ fetch: fakeFetch as never });
  const created = await app.request(AWS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      scopeHints: {
        awsRoleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
        awsExternalId: SPACE_ID,
        awsRegion: "us-west-2",
      },
      values: {
        AWS_ACCESS_KEY_ID: "AKIA_source",
        AWS_SECRET_ACCESS_KEY: "source_secret",
      },
    }),
  });
  expect(created.status).toBe(201);
  const { connection } = await created.json();

  const tested = await app.request(
    `/internal/v1/connections/${connection.id}/test`,
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(tested.status).toBe(200);
  expect((await tested.json()).status).toBe("verified");
  expect(called?.url).toBe("https://sts.us-west-2.amazonaws.com/");
  expect(called?.body).toContain("Action=AssumeRole");
  expect(called?.body).toContain(
    "RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Ftakosumi-prod",
  );
  expect(called?.auth).toContain("AWS4-HMAC-SHA256");
});

test("POST /internal/v1/connections/{id}/revoke revokes and returns 204", async () => {
  const app = await makeApp();
  const created = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      spaceId: SPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  const { connection } = await created.json();

  const revoked = await app.request(
    `/internal/v1/connections/${connection.id}/revoke`,
    {
      method: "POST",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(revoked.status).toBe(204);

  const list = await app.request(
    `/internal/v1/connections?spaceId=${SPACE_ID}`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect((await list.json()).connections).toHaveLength(0);

  const activity = await app.request(
    `/internal/v1/spaces/${SPACE_ID}/activity`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(activity.status).toBe(200);
  const events = (await activity.json()).events;
  const revokedEvent = events.find(
    (event: { action: string }) => event.action === "connection.revoked",
  );
  expect(revokedEvent).toBeDefined();
  expect(revokedEvent.actorId).toBe("acct_1");
  expect(revokedEvent.targetType).toBe("connection");
  expect(revokedEvent.targetId).toBe(connection.id);
  expect(revokedEvent.metadata).toEqual({
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    scope: "space",
  });
  expect(JSON.stringify(events)).not.toContain("cf-secret-token");
});

test("connection id with an unsupported shape is rejected (400)", async () => {
  const app = await makeApp();
  const response = await app.request(
    "/internal/v1/connections/not-a-conn-id/test",
    {
      method: "POST",
      headers: HEADERS,
    },
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});
