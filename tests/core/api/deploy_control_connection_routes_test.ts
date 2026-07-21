import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { StaticSecretConnectionVault } from "../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { ActivityService } from "../../../core/domains/activity/mod.ts";
import { ConnectionsService } from "../../../core/domains/connections/mod.ts";
import type { DeployControlInternalRouteDependencies } from "../../../core/api/deploy_control_internal_routes.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../providers/registry.ts";

const WORKSPACE_ID = "ws_10000001";

function makeApp(
  options: {
    fetch?: typeof fetch;
    connectionOAuthHelpers?: DeployControlInternalRouteDependencies["connectionOAuthHelpers"];
    allowOperatorScopedProviderConnections?: boolean;
  } = {},
) {
  const store = new InMemoryOpenTofuControlStore();
  let counter = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "route-test-passphrase-0123456789-abcdef",
    }),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => `conn_route${(counter += 1).toString().padStart(11, "0")}`,
    fetch: options.fetch as never,
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
        (recipe) => recipe.id === id,
      ),
    credentialDrivers:
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
  });
  const activityService = new ActivityService({
    store,
    now: () => new Date("2026-06-04T00:00:00.000Z"),
  });
  const connectionsService = new ConnectionsService({
    store,
    now: () => "2026-06-04T00:00:00.000Z",
    newId: (prefix) => `${prefix}_route_default`,
    allowOperatorScopedProviderConnections:
      options.allowOperatorScopedProviderConnections === true,
  });
  const controller = new OpenTofuController({
    store,
    vault,
    allowOperatorScopedProviderConnections:
      options.allowOperatorScopedProviderConnections === true,
  });
  return createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      activityService,
      connectionsService,
      buildConnectionSetupRequest:
        REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.buildConnectionSetupRequest,
      ...(options.connectionOAuthHelpers
        ? { connectionOAuthHelpers: options.connectionOAuthHelpers }
        : {}),
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_1",
              workspaceIds: [WORKSPACE_ID],
              operations: "*",
              runnerProfileIds: "*",
            }
          : token === "operator-token"
            ? {
                actor: "op",
                workspaceIds: "*",
                operations: "*",
                runnerProfileIds: "*",
              }
            : undefined,
    },
    requestCorrelation: false,
  });
}

const CF_PATH = "/internal/v1/connections/setups/cloudflare-api-token";
const HTTPS_PATH = "/internal/v1/connections/setups/git-https-token";
const SSH_PATH = "/internal/v1/connections/setups/git-ssh-key";
const AWS_PATH = "/internal/v1/connections/setups/aws-assume-role";
const GCP_IMPERSONATION_PATH =
  "/internal/v1/connections/setups/google-impersonation";
const GCP_SERVICE_ACCOUNT_JSON_PATH =
  "/internal/v1/connections/setups/google-service-account-json";
const GENERIC_ENV_PROVIDER_PATH = "/internal/v1/connections/setups/generic-env";
const RESERVED_DRIVER_PATHS = [
  ["POST", "/internal/v1/connections/oauth/cloudflare/start"],
  ["GET", "/internal/v1/connections/oauth/cloudflare/callback"],
  ["POST", "/internal/v1/connections/oauth/gcp/start"],
  ["GET", "/internal/v1/connections/oauth/gcp/callback"],
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

test("POST /internal/v1/connections/setups/cloudflare-api-token requires a bearer (401)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf" },
    }),
  });
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});

test("POST /internal/v1/connections/setups/cloudflare-api-token rejects an unknown body field (400)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf" },
      sneaky: "field",
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});

test("POST /internal/v1/connections/setups/cloudflare-api-token rejects credential files", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf" },
      files: [
        {
          path: "cloudflare.json",
          content: '{"token":"file-secret"}',
          envName: "CLOUDFLARE_CREDENTIALS_FILE",
        },
      ],
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("does not accept credential files");
});

test("POST /internal/v1/connections/setups/cloudflare-api-token enforces Workspace scope (403)", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: "space_denied",
      values: { CLOUDFLARE_API_TOKEN: "cf" },
    }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("POST /internal/v1/connections/setups/cloudflare-api-token rejects a Workspace session asking scope:operator (403)", async () => {
  const app = await makeApp();
  // Privilege-escalation guard: a Workspace session (scoped-token, workspaceIds:
  // [WORKSPACE_ID]) supplies its OWN workspaceId but asks for `scope: "operator"`. The
  // workspaceId alone would pass the Workspace permission check, so the gate must
  // additionally require the unrestricted bearer for any operator-scope request.
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      scope: "operator",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("POST /internal/v1/connections/setups/cloudflare-api-token happy path returns 201 and never echoes values", async () => {
  const app = await makeApp();
  const response = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      displayName: "prod",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("cf-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connection.status).toBe("pending");
  expect(payload.connection.provider).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );
  expect(payload.connection.kind).toBeUndefined();
  expect(payload.connection.credentialRecipe).toMatchObject({
    id: "cloudflare",
    authMode: "api_token",
    secretPartition: "provider-credentials",
  });
  expect(payload.connection.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
  expect(payload.connection.values).toBeUndefined();

  const activity = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/activity`,
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
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    recipeId: "cloudflare",
    recipeAuthMode: "api_token",
    scope: "workspace",
  });
  expect(JSON.stringify(events)).not.toContain("cf-secret-token");
});

test("POST /internal/v1/connections/setups/git-https-token returns 201 with the source kind", async () => {
  const app = await makeApp();
  const response = await app.request(HTTPS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      displayName: "github",
      scopeHints: {
        providerSettings: {
          username: "git",
          repositoryUrl: "https://git.example.com/o/r.git",
        },
      },
      values: { GIT_HTTPS_TOKEN: "ghp-secret" },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("ghp-secret");
  const payload = JSON.parse(text);
  expect(payload.connection.kind).toBe("source_git_https_token");
});

test("POST /internal/v1/connections/setups/git-ssh-key requires knownHosts (400)", async () => {
  const app = await makeApp();
  const response = await app.request(SSH_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      values: { GIT_SSH_PRIVATE_KEY: "-----BEGIN KEY-----" },
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("knownHostsEntry");
});

test("POST /internal/v1/connections/setups/git-ssh-key with knownHosts returns 201", async () => {
  const app = await makeApp();
  const response = await app.request(SSH_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      scopeHints: {
        providerSettings: {
          knownHostsEntry: "github.com ssh-ed25519 AAAA...",
        },
      },
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

test("POST /internal/v1/connections/setups/aws-assume-role requires a role ARN hint (400)", async () => {
  const app = await makeApp();
  const response = await app.request(AWS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      values: {
        AWS_ACCESS_KEY_ID: "akid",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("providerSettings.roleArn");
});

test("POST /internal/v1/connections/setups/aws-assume-role returns 201 and never echoes values", async () => {
  const app = await makeApp();
  const response = await app.request(AWS_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      displayName: "prod aws",
      scopeHints: {
        providerSettings: {
          roleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
          externalId: WORKSPACE_ID,
          region: "us-east-1",
        },
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
  expect(payload.connection.provider).toBe(
    "registry.opentofu.org/hashicorp/aws",
  );
  expect(payload.connection.kind).toBeUndefined();
  expect(payload.connection.credentialRecipe).toMatchObject({
    id: "aws",
    authMode: "assume_role",
    secretPartition: "provider-credentials",
  });
  expect(payload.connection.scopeHints.providerSettings.roleArn).toBe(
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

test("POST /internal/v1/connections/setups/generic-env registers a secret-backed Provider Connection", async () => {
  const app = await makeApp();
  const response = await app.request(GENERIC_ENV_PROVIDER_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      provider: "registry.opentofu.org/integrations/github",
      displayName: "github",
      values: {
        GITHUB_TOKEN: "github-secret-token",
        GITHUB_CUSTOM_ENDPOINT: "https://github.example.test",
      },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("github-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe(
    "registry.opentofu.org/integrations/github",
  );
  expect(payload.connection.kind).toBeUndefined();
  expect(payload.connection.credentialRecipe).toMatchObject({
    id: "generic-env",
    authMode: "env",
    secretPartition: "provider-credentials",
  });
  expect(payload.connection.scope).toBe("workspace");
  expect(payload.connection.envNames).toEqual([
    "GITHUB_CUSTOM_ENDPOINT",
    "GITHUB_TOKEN",
  ]);
});

test("POST /internal/v1/connections/setups/generic-env registers env and file credentials", async () => {
  const app = await makeApp();
  const response = await app.request(GENERIC_ENV_PROVIDER_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      provider: "registry.opentofu.org/example/envfile",
      displayName: "envfile",
      values: {
        GENERIC_API_TOKEN: "generic-secret-token",
      },
      files: [
        {
          path: "provider-credentials.json",
          content: '{"token":"file-secret"}',
          envName: "GENERIC_CREDENTIALS_FILE",
          mode: 0o600,
        },
      ],
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("generic-secret-token");
  expect(text).not.toContain("file-secret");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe(
    "registry.opentofu.org/example/envfile",
  );
  expect(payload.connection.kind).toBeUndefined();
  expect(payload.connection.credentialRecipe).toMatchObject({
    id: "generic-env",
    authMode: "env",
    secretPartition: "provider-credentials",
  });
  expect(payload.connection.scope).toBe("workspace");
  expect(payload.connection.envNames).toEqual([
    "GENERIC_API_TOKEN",
    "GENERIC_CREDENTIALS_FILE",
  ]);
  expect(payload.connection.fileEnvNames).toEqual(["GENERIC_CREDENTIALS_FILE"]);
});

test("POST /internal/v1/connections/setups/generic-env registers an arbitrary OpenTofu provider recipe", async () => {
  const app = await makeApp();
  const provider = "registry.opentofu.org/snowflake-labs/snowflake";
  const response = await app.request(GENERIC_ENV_PROVIDER_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      provider,
      displayName: "Snowflake",
      values: {
        SNOWFLAKE_ACCOUNT: "account",
        SNOWFLAKE_USER: "user",
        SNOWFLAKE_PASSWORD: "snowflake-secret",
      },
    }),
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("snowflake-secret");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe(provider);
  expect(payload.connection.kind).toBeUndefined();
  expect(payload.connection.credentialRecipe).toMatchObject({
    id: "generic-env",
    authMode: "env",
    secretPartition: "provider-credentials",
  });
  expect(payload.connection.envNames).toEqual([
    "SNOWFLAKE_ACCOUNT",
    "SNOWFLAKE_PASSWORD",
    "SNOWFLAKE_USER",
  ]);
});

test("POST /internal/v1/connections accepts an explicit provider source and Credential Recipe", async () => {
  const app = await makeApp();
  const provider = "registry.opentofu.org/example/acme";
  const response = await app.request("/internal/v1/connections", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      provider,
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: "provider-credentials",
      },
      displayName: "Acme",
      values: { ACME_API_TOKEN: "acme-secret" },
    }),
  });

  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("acme-secret");
  const payload = JSON.parse(text);
  expect(payload.connection).toMatchObject({
    provider,
    providerSource: provider,
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
      envNames: ["ACME_API_TOKEN"],
      fileEnvNames: [],
      requiredEnvGroups: [],
    },
  });
});

test("POST /internal/v1/connections/setups/generic-env rejects operator scope", async () => {
  const app = await makeApp();
  const response = await app.request(GENERIC_ENV_PROVIDER_PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer operator-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      scope: "operator",
      provider: "registry.opentofu.org/integrations/github",
      values: { GITHUB_TOKEN: "github-secret-token" },
    }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("Workspace-scoped");
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
    expect(payload.error.message).toContain("connection helper");
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
            workspaceId: WORKSPACE_ID,
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            credentialRecipe: {
              id: "cloudflare",
              authMode: "oauth",
              secretPartition: "provider-credentials",
            },
            materialization: "oauth",
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
    "/internal/v1/connections/oauth/cloudflare/start",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
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
    "/internal/v1/connections/oauth/cloudflare/callback?code=code_cf&state=state_cf",
    {
      method: "GET",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(completed.status).toBe(201);
  const text = await completed.text();
  expect(text).not.toContain("oauth-token-code_cf-state_cf");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );
  expect(payload.connection.kind).toBeUndefined();
  expect(payload.connection.credentialRecipe).toMatchObject({
    id: "cloudflare",
    authMode: "oauth",
    secretPartition: "provider-credentials",
  });
  expect(payload.connection.materialization).toBe("oauth");
  expect(payload.connection.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
});

test("OAuth helper cannot smuggle a Source Git connection discriminator", async () => {
  const app = await makeApp({
    connectionOAuthHelpers: {
      example: {
        start: async () => ({
          authorizationUrl: "https://identity.example.test/authorize",
          state: "state_example",
        }),
        complete: async () => ({
          request: {
            workspaceId: WORKSPACE_ID,
            provider: "registry.opentofu.org/example/provider",
            credentialRecipe: {
              id: "example",
              authMode: "oauth",
              secretPartition: "provider-credentials",
            },
            kind: "source_git_https_token",
            values: { EXAMPLE_TOKEN: "secret" },
          },
        }),
      },
    },
  });

  const response = await app.request(
    "/internal/v1/connections/oauth/example/callback?code=code&state=state_example",
    {
      method: "GET",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("Source Git connection kind");
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
            workspaceId: WORKSPACE_ID,
            provider: "registry.opentofu.org/hashicorp/google",
            credentialRecipe: {
              id: "google",
              authMode: "oauth",
              secretPartition: "provider-credentials",
            },
            materialization: "oauth",
            values: { GOOGLE_CREDENTIALS: "{}" },
          },
        }),
      },
    },
  });

  const missing = await app.request(
    "/internal/v1/connections/oauth/gcp/callback",
    {
      method: "GET",
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(missing.status).toBe(400);
  expect((await missing.json()).error.message).toContain("code");
});

test("unimplemented Google impersonation setup is not advertised as installed", async () => {
  const app = await makeApp();
  const response = await app.request(GCP_IMPERSONATION_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      displayName: "gcp impersonation",
      scopeHints: {
        providerSettings: {
          serviceAccountEmail:
            "takosumi-runner@project-1.iam.gserviceaccount.com",
          projectId: "project-1",
        },
      },
      values: {
        GOOGLE_CREDENTIALS:
          '{"type":"authorized_user","refresh_token":"secret-refresh"}',
      },
    }),
  });

  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toContain(
    "guided connection setup google-impersonation is not installed",
  );
});

test("POST /internal/v1/connections/setups/google-service-account-json registers a runnable Google Provider Connection", async () => {
  const app = await makeApp();
  const serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: "project-1",
    client_email: "takosumi-runner@project-1.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----\\n",
  });
  const response = await app.request(GCP_SERVICE_ACCOUNT_JSON_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      displayName: "gcp service account",
      values: {
        GOOGLE_CREDENTIALS: serviceAccountJson,
      },
    }),
  });

  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("private_key");
  expect(text).not.toContain("BEGIN PRIVATE KEY");
  const payload = JSON.parse(text);
  expect(payload.connection.provider).toBe(
    "registry.opentofu.org/hashicorp/google",
  );
  expect(payload.connection.kind).toBeUndefined();
  expect(payload.connection.credentialRecipe).toMatchObject({
    id: "google",
    authMode: "service_account_json",
    secretPartition: "provider-credentials",
  });
  expect(payload.connection.envNames).toEqual(["GOOGLE_CREDENTIALS"]);
  expect(payload.connection.scopeHints).toBeUndefined();
});

test("GET /internal/v1/connections lists connections without secret values", async () => {
  const app = await makeApp();
  await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  });

  const response = await app.request(
    `/internal/v1/connections?workspaceId=${WORKSPACE_ID}`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("cf-secret-token");
  const payload = JSON.parse(text);
  expect(payload.connections).toHaveLength(1);
  expect(payload.connections[0].provider).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );
});

test("GET /internal/v1/connections with no workspaceId lists operator-scoped connections for the unrestricted bearer", async () => {
  const app = await makeApp();
  // Operator-scoped connection (no workspaceId): only the unrestricted bearer.
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

test("GET /internal/v1/connections with no workspaceId is denied for a scoped bearer (403)", async () => {
  const app = await makeApp();
  const response = await app.request("/internal/v1/connections", {
    headers: { authorization: "Bearer scoped-token" },
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("canonical Connection list/get routes never leak secret material", async () => {
  const app = await makeApp();

  const empty = await app.request(
    `/internal/v1/connections?workspaceId=${WORKSPACE_ID}`,
    { headers: HEADERS },
  );
  expect(empty.status).toBe(200);
  expect((await empty.json()).connections).toHaveLength(0);

  // Registering a Workspace connection creates the resolver record directly.
  const spaceCreated = await app.request(CF_PATH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      values: { CLOUDFLARE_API_TOKEN: "workspace-secret-token" },
    }),
  });
  expect(spaceCreated.status).toBe(201);
  const spaceConnection = (await spaceCreated.json()).connection;

  const listedConnections = await app.request(
    `/internal/v1/connections?workspaceId=${WORKSPACE_ID}`,
    { headers: HEADERS },
  );
  expect(listedConnections.status).toBe(200);
  const listedPayload = await listedConnections.json();
  expect(listedPayload.connections).toHaveLength(1);
  expect(listedPayload.connections[0]).toMatchObject({
    id: spaceConnection.id,
    workspaceId: WORKSPACE_ID,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    materialization: "secret",
  });
  expect(JSON.stringify(listedPayload)).not.toContain("secretRef");
  expect(JSON.stringify(listedPayload)).not.toContain("workspace-secret-token");

  // And readable by id, still never echoing sealed material.
  const readConnection = await app.request(
    `/internal/v1/connections/${spaceConnection.id}`,
    { headers: HEADERS },
  );
  expect(readConnection.status).toBe(200);
  const readPayload = await readConnection.json();
  expect(readPayload.connection).toMatchObject({
    id: spaceConnection.id,
    workspaceId: WORKSPACE_ID,
    materialization: "secret",
  });
  expect(JSON.stringify(readPayload)).not.toContain("secretRef");
  expect(JSON.stringify(readPayload)).not.toContain("workspace-secret-token");
});

test("operator-scoped Connection reads are operator-gated", async () => {
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
  expect(operatorConnection.scope).toBe("operator");

  // A scoped Workspace bearer cannot read an operator-scoped resolver record.
  const scopedDenied = await app.request(
    `/internal/v1/connections/${operatorConnection.id}`,
    { headers: HEADERS },
  );
  expect(scopedDenied.status).toBe(403);
  expect((await scopedDenied.json()).error.code).toBe("permission_denied");

  // The unrestricted operator bearer can read it, still never echoing secrets.
  const operatorRead = await app.request(
    `/internal/v1/connections/${operatorConnection.id}`,
    { headers: { authorization: "Bearer operator-token" } },
  );
  expect(operatorRead.status).toBe(200);
  const operatorReadPayload = await operatorRead.json();
  expect(operatorReadPayload.connection).toMatchObject({
    id: operatorConnection.id,
    scope: "operator",
    materialization: "secret",
  });
  expect(JSON.stringify(operatorReadPayload)).not.toContain(
    "operator-secret-token",
  );
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
      workspaceId: WORKSPACE_ID,
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
      workspaceId: WORKSPACE_ID,
      scopeHints: {
        providerSettings: {
          roleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
          externalId: WORKSPACE_ID,
          region: "us-west-2",
        },
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
      workspaceId: WORKSPACE_ID,
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
    `/internal/v1/connections?workspaceId=${WORKSPACE_ID}`,
    {
      headers: { authorization: "Bearer scoped-token" },
    },
  );
  expect((await list.json()).connections).toHaveLength(0);

  const activity = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/activity`,
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
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    recipeId: "cloudflare",
    recipeAuthMode: "api_token",
    scope: "workspace",
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
