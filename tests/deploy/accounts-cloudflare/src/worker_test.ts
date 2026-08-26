import { afterEach, expect, spyOn, test } from "bun:test";
import {
  accountsExternalLoginConfigured,
  createCloudflareWorker,
  parseConfiguredOidcClients,
  parseLoginEmailAllowlist,
  type CloudflareWorkerEnv,
} from "../../../../deploy/accounts-cloudflare/src/handler.ts";
import { REQUIRED_PLATFORM_BINDINGS } from "../../../../deploy/accounts-cloudflare/src/bindings-check.ts";
import {
  D1AccountsStore,
  type D1Database,
  type D1ExecResult,
  type D1PreparedStatement,
  type D1Result,
  issueInterfaceOAuthAccessToken,
  registerSessionHashSaltConfig,
  resolveSessionHashSalt,
} from "../../../../accounts/service/src/mod.ts";
import { __resetSessionHashSaltConfigForTesting } from "../../../../accounts/service/src/session-hash-salt.ts";
import { oidcClientActivationDigest } from "../../../../accounts/service/src/oidc-activation.ts";
import {
  applyD1AccountsMigrationBatch,
  loadD1AccountsMigrationCatalog,
} from "../../../../accounts/service/src/d1-migrations.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

function env(values: Record<string, unknown> = {}): CloudflareWorkerEnv {
  return values as CloudflareWorkerEnv;
}

async function accountsDbAtHead(headVersion: 3 | 4): Promise<SqliteFakeD1> {
  const db = new SqliteFakeD1();
  const catalog = await loadD1AccountsMigrationCatalog();
  for (const migration of catalog.migrations) {
    if (migration.version > headVersion) break;
    await applyD1AccountsMigrationBatch(db, migration, 1_000 + migration.version);
  }
  return db;
}

async function versionedAccountsDb(): Promise<SqliteFakeD1> {
  return accountsDbAtHead(4);
}

afterEach(() => {
  __resetSessionHashSaltConfigForTesting();
});

test("Cloudflare Accounts worker keeps health local", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/healthz"),
    env(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    service: "takosumi-accounts",
  });
});

test("full Cloudflare handler keeps request-time salt out of legacy global registration", async () => {
  const legacySalt = "legacy-global-session-salt-sentinel";
  registerSessionHashSaltConfig({ salt: legacySalt });
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/api/v1/workspaces"),
    env({
      TAKOSUMI_ACCOUNTS_DB: await versionedAccountsDb(),
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "full-handler-explicit-session-salt",
    }),
  );

  expect(response.status).toBe(401);
  expect(resolveSessionHashSalt("TAKOSUMI_ACCOUNT_SESSION_HASH_SALT")).toBe(
    legacySalt,
  );
});

test("Cloudflare readiness checks canonical platform bindings only", async () => {
  const missing = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/readyz"),
    env(),
  );
  expect(missing.status).toBe(503);
  expect((await missing.json()).missing).not.toContain(
    "TAKOSUMI_ACCOUNTS_EXPORTS",
  );

  const complete: Record<string, unknown> = {};
  for (const name of [
    ...REQUIRED_PLATFORM_BINDINGS.d1,
    ...REQUIRED_PLATFORM_BINDINGS.r2,
    ...REQUIRED_PLATFORM_BINDINGS.durableObjects,
    ...REQUIRED_PLATFORM_BINDINGS.assets,
  ]) {
    complete[name] = {};
  }
  const ready = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/readyz"),
    env(complete),
  );
  expect(ready.status).toBe(200);
});

test("Cloudflare readiness keeps the same JSON response for a trailing slash", async () => {
  const complete: Record<string, unknown> = {};
  for (const name of [
    ...REQUIRED_PLATFORM_BINDINGS.d1,
    ...REQUIRED_PLATFORM_BINDINGS.r2,
    ...REQUIRED_PLATFORM_BINDINGS.durableObjects,
    ...REQUIRED_PLATFORM_BINDINGS.assets,
  ]) {
    complete[name] = {};
  }
  const worker = createCloudflareWorker();
  const canonical = await worker.fetch(
    new Request("https://app.example.test/readyz"),
    env(complete),
  );
  const trailingSlash = await worker.fetch(
    new Request("https://app.example.test/readyz/"),
    env(complete),
  );

  expect(trailingSlash.status).toBe(canonical.status);
  expect(await trailingSlash.json()).toEqual(await canonical.json());
  expect(trailingSlash.headers.get("content-type")).toBe(
    canonical.headers.get("content-type"),
  );
  expect(trailingSlash.headers.get("x-takosumi-version-id")).toBe(
    canonical.headers.get("x-takosumi-version-id"),
  );
});

test("dashboard documents keep inline scripts blocked while allowing the configured Cloudflare beacon", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/new"),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response("<!doctype html><html><body></body></html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
    }),
  );

  expect(response.status).toBe(200);
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(csp).toContain(
    "script-src 'self' https://static.cloudflareinsights.com",
  );
  expect(csp.match(/script-src[^;]*/u)?.[0]).not.toContain("'unsafe-inline'");
});

test("hosted docs allow exactly their own inline scripts by hash, never unsafe-inline", async () => {
  const appearance = `(()=>{const e=localStorage.getItem("vitepress-theme-appearance")})();`;
  const hashMap = `window.__VP_HASH_MAP__=JSON.parse("{}")`;
  const html =
    `<!doctype html><html><head>` +
    `<script>${appearance}</script>` +
    `<script>${hashMap}</script>` +
    `<script src="/docs/assets/app.js"></script>` +
    `</head><body></body></html>`;
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/docs/"),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response(html, {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe(html);
  const scriptSrc =
    response.headers
      .get("content-security-policy")
      ?.match(/script-src[^;]*/u)?.[0] ?? "";
  // Every inline script the document actually ships is allowed by its exact
  // digest, so the docs boot; nothing else is.
  for (const source of [appearance, hashMap]) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source),
    );
    let binary = "";
    for (const byte of new Uint8Array(digest))
      binary += String.fromCharCode(byte);
    expect(scriptSrc).toContain(`'sha256-${btoa(binary)}'`);
  }
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc).toContain("'self'");
  expect(scriptSrc).toContain("https://static.cloudflareinsights.com");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("OAuth callback documents never expose code or state in referrers", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request(
      "https://app.example.test/sign-in/callback?code=oauth-code&state=oauth-state",
    ),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response("<!doctype html><html><body>callback</body></html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("a docs document with no inline script keeps the unmodified dashboard policy", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/docs/endpoints.html"),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response("<!doctype html><html><body>docs</body></html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
    }),
  );

  const scriptSrc =
    response.headers
      .get("content-security-policy")
      ?.match(/script-src[^;]*/u)?.[0] ?? "";
  expect(scriptSrc).toBe(
    "script-src 'self' https://static.cloudflareinsights.com",
  );
});

test("login allowlist and upstream discovery stay provider-neutral", () => {
  expect(
    parseLoginEmailAllowlist(
      env({ TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "a@example.test" }),
      "https://app.example.test",
    ),
  ).toEqual({ emails: ["a@example.test"], requireVerifiedEmail: true });
  expect(accountsExternalLoginConfigured(env())).toBe(false);
  expect(
    accountsExternalLoginConfigured(
      env({
        TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
        TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
          {
            providerId: "primary-oidc",
            issuer: "https://id.example.test",
            authorizationEndpoint: "https://id.example.test/authorize",
            tokenEndpoint: "https://id.example.test/token",
            userInfoEndpoint: "https://id.example.test/userinfo",
            clientId: "accounts-client",
            redirectUri: "https://app.example.test/sign-in/callback",
          },
        ]),
      }),
    ),
  ).toBe(true);
});

test("Cloudflare auth discovery exposes the current Google, OIDC, and passkey contract", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/api/v1/auth/providers"),
    env({
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
        {
          providerId: "google",
          label: "Google",
          protocol: "oidc",
          issuer: "https://accounts.google.example.test",
          authorizationEndpoint:
            "https://accounts.google.example.test/authorize",
          tokenEndpoint: "https://accounts.google.example.test/token",
          userInfoEndpoint: "https://accounts.google.example.test/userinfo",
          clientId: "google-client-id",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
          redirectUri: "https://app.example.test/sign-in/callback",
        },
        {
          providerId: "company-oidc",
          label: "Company SSO",
          protocol: "OIDC",
          issuer: "https://id.example.test",
          authorizationEndpoint: "https://id.example.test/authorize",
          tokenEndpoint: "https://id.example.test/token",
          userInfoEndpoint: "https://id.example.test/userinfo",
          clientId: "company-client-id",
          redirectUri: "https://app.example.test/sign-in/callback",
        },
      ]),
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID: "app.example.test",
      TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME: "Takosumi",
      TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN: "https://app.example.test",
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    providers: [
      {
        id: "google",
        enabled: true,
        label: "Google",
        protocol: "oidc",
      },
      {
        id: "company-oidc",
        enabled: true,
        label: "Company SSO",
        protocol: "oidc",
      },
      {
        id: "passkey",
        enabled: true,
        label: "Passkey",
        protocol: "webauthn",
      },
    ],
  });
  expect(text).not.toContain("google-client-id");
  expect(text).not.toContain("google-client-secret");
  expect(text).not.toContain("accounts.google.example.test");
  expect(text).not.toContain("sign-in/callback");
});

test("retired Accounts /v1 paths bypass Cloudflare SPA assets and return JSON 404", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("http://app.example.test/v1/account/session/me"),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response("<!doctype html><html>spa</html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
      TAKOSUMI_ACCOUNTS_DB: await versionedAccountsDb(),
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "retired-v1-route-test-salt",
    }),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({
    error: { code: "not_found" },
  });
});

test("Cloudflare auth discovery rejects malformed config without leaking it", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/api/v1/auth/providers"),
    env({
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
        {
          providerId: "google",
          label: "Google",
          protocol: "oidc/private-provider-detail",
          issuer: "https://private-idp.example.test",
          authorizationEndpoint: "https://private-idp.example.test/authorize",
          tokenEndpoint: "https://private-idp.example.test/token",
          userInfoEndpoint: "https://private-idp.example.test/userinfo",
          clientId: "private-client-id",
          clientSecret: "must-never-be-returned",
          redirectUri: "https://app.example.test/sign-in/callback",
        },
      ]),
    }),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    error: "auth_provider_configuration_invalid",
    error_description: "Sign-in provider configuration is invalid.",
  });
  expect(text).not.toContain("private-idp");
  expect(text).not.toContain("private-client-id");
  expect(text).not.toContain("must-never-be-returned");
});

test("Cloudflare Accounts authenticates before resolving the cold Control plane", async () => {
  const db = await versionedAccountsDb();
  const sessionSalt = "cloudflare-handler-timing-test-session-salt";
  registerSessionHashSaltConfig({ salt: sessionSalt });
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const sessionId = "sess_control_initialization_timing";
  await store.saveAccount({
    subject: "tsub_control_initialization_timing",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  await store.saveAccountSession({
    sessionId,
    subject: "tsub_control_initialization_timing",
    createdAt: 1_000,
    expiresAt: Date.now() + 60_000,
  });
  let releaseControlInitialization!: () => void;
  const controlInitialization = new Promise<void>((resolve) => {
    releaseControlInitialization = resolve;
  });
  let signalControlInitializationStarted!: () => void;
  const controlInitializationStarted = new Promise<void>((resolve) => {
    signalControlInitializationStarted = resolve;
  });
  let controlInitializationCalls = 0;
  const worker = createCloudflareWorker({
    controlPlaneOperations: async () => {
      controlInitializationCalls += 1;
      signalControlInitializationStarted();
      await controlInitialization;
      return {
        workspaces: {
          listWorkspacesForAccountPage: async () => ({ items: [] }),
        },
      } as never;
    },
  });
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: sessionSalt,
  });
  const request = (authenticated = false) =>
    new Request("https://app.example.test/api/v1/workspaces", {
      ...(authenticated
        ? { headers: { "x-takosumi-account-session": sessionId } }
        : {}),
    });

  const anonymousResponse = await worker.fetch(request(), workerEnv);
  expect(anonymousResponse.status).toBe(401);
  expect(controlInitializationCalls).toBe(0);
  const anonymousTiming = anonymousResponse.headers.get("server-timing") ?? "";
  expect(anonymousTiming).toContain("tk_control_auth");
  expect(anonymousTiming).not.toContain("tk_control_init");

  const coldRequest = worker.fetch(request(true), workerEnv);
  await controlInitializationStarted;
  const concurrentRequest = worker.fetch(request(true), workerEnv);
  releaseControlInitialization();

  const [coldResponse, concurrentResponse] = await Promise.all([
    coldRequest,
    concurrentRequest,
  ]);
  for (const response of [coldResponse, concurrentResponse]) {
    expect(response.status).toBe(200);
    const timing = response.headers.get("server-timing") ?? "";
    expect(timing).toContain("tk_control_auth");
    expect(timing).toMatch(/tk_control_init;dur=\d+(?:\.\d+)?/u);
  }
  expect(controlInitializationCalls).toBe(1);

  const warmResponse = await worker.fetch(request(true), workerEnv);
  expect(warmResponse.status).toBe(200);
  const warmTiming = warmResponse.headers.get("server-timing") ?? "";
  expect(warmTiming).toContain("tk_control_auth");
  expect(warmTiming).not.toContain("tk_accounts_init");
  expect(warmTiming).toMatch(/tk_control_init;dur=\d+(?:\.\d+)?/u);
});

test("Cloudflare PAT self authority uses only the dedicated membership reader", async () => {
  const db = await versionedAccountsDb();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const now = Date.now();
  const rawToken = "takpat_cloudflare_workspace_authority";
  await store.savePersonalAccessToken(rawToken, {
    tokenId: "pat_cloudflare_workspace_authority",
    tokenPrefix: "takpat_cloudflar",
    subject: "tsub_cloudflare_workspace_authority",
    name: "Cloudflare authority",
    scopes: ["write", "read"],
    workspaceId: "ws_cloudflare_workspace_authority",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  let membershipReads = 0;
  let controlInitializations = 0;
  const worker = createCloudflareWorker({
    patWorkspaceMembershipReader: () => ({
      getMember: async (workspaceId, subject) => {
        membershipReads += 1;
        expect([workspaceId, subject]).toEqual([
          "ws_cloudflare_workspace_authority",
          "tsub_cloudflare_workspace_authority",
        ]);
        return {
          workspaceId,
          accountId: subject,
          status: "active",
          roles: ["owner"],
        };
      },
    }),
    controlPlaneOperations: async () => {
      controlInitializations += 1;
      throw new Error("the full Control plane must not initialize");
    },
  });

  const response = await worker.fetch(
    new Request("http://app.example.test/api/v1/account/tokens/current", {
      headers: { authorization: `Bearer ${rawToken}` },
    }),
    env({
      TAKOSUMI_ACCOUNTS_DB: db,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "cloudflare-pat-authority-session-salt",
    }),
  );

  const responseBody = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(responseBody).toEqual({
    kind: "takosumi.account-pat-authority@v1",
    token_id: "pat_cloudflare_workspace_authority",
    subject: "tsub_cloudflare_workspace_authority",
    scopes: ["read", "write"],
    workspace_id: "ws_cloudflare_workspace_authority",
    expires_at: new Date(now + 60_000).toISOString(),
    workspace_role: "owner",
  });
  expect(membershipReads).toBe(1);
  expect(controlInitializations).toBe(0);
});

test("Cloudflare authorize revalidates a Capsule OIDC client with canonical Control", async () => {
  const db = await versionedAccountsDb();
  const sessionSalt = "cloudflare-capsule-oidc-live-grant-session-salt";
  registerSessionHashSaltConfig({ salt: sessionSalt });
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const now = Date.now();
  const subject = "tsub_capsule_oidc_live_grant";
  const sessionId = "sess_capsule_oidc_live_grant";
  const capsuleId = "cap_capsule_oidc_live_grant";
  const workspaceId = "ws_capsule_oidc_live_grant";
  const clientId = "toc_capsule_oidc_live_grant";
  const redirectUri = "https://capsule.example.test/auth/oidc/callback";
  const installConfig = {
    id: "icfg_capsule_oidc_live_grant",
    variableMapping: { oidc_client_id: clientId },
    installExperience: {
      projections: [
        {
          kind: "oidc_client",
          variables: { clientId: "oidc_client_id" },
          callbackPath: "/auth/oidc/callback",
          scopes: ["openid", "profile"],
        },
      ],
    },
    updatedAt: new Date(now).toISOString(),
  };
  await store.saveAccount({
    subject,
    createdAt: now,
    updatedAt: now,
  });
  await store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  await store.saveOidcClient({
    clientId,
    capsuleId,
    namespacePath: "identity.oidc",
    issuerUrl: "http://app.example.test",
    redirectUris: [redirectUri],
    allowedScopes: ["openid", "profile"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    activationDigest: await oidcClientActivationDigest({
      workspaceId,
      capsuleId,
      executionAuthorityEpoch: 1,
      installConfig: installConfig as never,
    }),
    createdAt: now,
    updatedAt: now,
  });
  let controlInitializationCalls = 0;
  const worker = createCloudflareWorker({
    controlPlaneOperations: async () => {
      controlInitializationCalls += 1;
      return {
        capsules: {
          getCapsule: async () => ({
            id: capsuleId,
            workspaceId,
            installConfigId: installConfig.id,
            name: "capsule-live-grant",
            status: "active",
          }),
          getInstallConfig: async () => installConfig,
          getCapsuleExecutionAuthorityEpoch: async () => 1,
        },
        workspaces: {
          getWorkspace: async () => ({
            id: workspaceId,
            ownerUserId: subject,
          }),
        },
        members: { listMembers: async () => [] },
      } as never;
    },
  });
  const authorize = new URL("http://app.example.test/oauth/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile",
    code_challenge: "capsule-live-grant-challenge",
    code_challenge_method: "S256",
    state: "capsule-live-grant-state",
  }).toString();

  const response = await worker.fetch(
    new Request(authorize, {
      headers: { "x-takosumi-account-session": sessionId },
    }),
    env({
      TAKOSUMI_ACCOUNTS_DB: db,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: sessionSalt,
    }),
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toStartWith(
    `${redirectUri}?code=`,
  );
  expect(controlInitializationCalls).toBe(1);
});

test("Cloudflare config preserves a host-specific public mobile OIDC client", () => {
  const mobileClient = {
    clientId: "takos-mobile-host-example",
    redirectUris: ["takos://oauth/callback"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid", "profile", "offline_access", "spaces:read"],
  } as const;

  expect(
    parseConfiguredOidcClients(
      env({ TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([mobileClient]) }),
    ),
  ).toEqual([mobileClient]);
});

test("Cloudflare multi-client config injects one confidential secret by exact client id", () => {
  const publicClient = {
    clientId: "takos-mobile-host-example",
    redirectUris: ["takos://oauth/callback"],
    tokenEndpointAuthMethod: "none",
  } as const;
  const introspectionClient = {
    clientId: "takosumi-cloud-extensions",
    redirectUris: ["https://app.example.test/__takosumi/callback"],
    tokenEndpointAuthMethod: "client_secret_post",
  } as const;

  expect(
    parseConfiguredOidcClients(
      env({
        TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([
          publicClient,
          introspectionClient,
        ]),
        TAKOSUMI_ACCOUNTS_CLIENT_ID: introspectionClient.clientId,
        TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "operator-secret",
      }),
    ),
  ).toEqual([
    publicClient,
    { ...introspectionClient, clientSecret: "operator-secret" },
  ]);

  expect(() =>
    parseConfiguredOidcClients(
      env({
        TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([publicClient]),
        TAKOSUMI_ACCOUNTS_CLIENT_ID: introspectionClient.clientId,
        TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "operator-secret",
      }),
    ),
  ).toThrow("must name an exact TAKOSUMI_ACCOUNTS_CLIENTS entry");
});

test("Cloudflare identity handler lazily revalidates Interface OAuth against Core", async () => {
  const db = await versionedAccountsDb();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const issued = await issueInterfaceOAuthAccessToken({
    store,
    subject: "principal_cloudflare",
    workspaceId: "workspace_cloudflare",
    capsuleId: "capsule_cloudflare",
    audience: "https://resource.example.test/mcp",
    permission: "mcp.invoke",
    interfaceId: "if_cloudflare",
    bindingId: "ifb_cloudflare",
    interfaceRevision: 3,
  });
  let validations = 0;
  const worker = createCloudflareWorker({
    controlPlaneOperations: () =>
      Promise.resolve({
        interfaces: {
          validatePrincipalOAuth2TokenEvidence: (evidence: {
            readonly interfaceId: string;
          }) => {
            validations += 1;
            return Promise.resolve(evidence.interfaceId === "if_cloudflare");
          },
        },
      } as never),
  });
  const oidcKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
      "cloudflare-interface-oauth-test-session-salt",
    TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(
      await crypto.subtle.exportKey("jwk", oidcKeyPair.privateKey),
    ),
    TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "cloudflare-interface-test-key",
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET:
      "cloudflare-interface-test-pairwise-secret",
  });
  const response = await worker.fetch(
    new Request("https://app.example.test/oauth/userinfo", {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    }),
    workerEnv,
  );
  const responseBody = await response.text();
  expect(response.status).toBe(200);
  expect(validations).toBe(1);
  expect(JSON.parse(responseBody)).toMatchObject({
    token_use: "interface_oauth",
    aud: "https://resource.example.test/mcp",
    takosumi: { interface_id: "if_cloudflare" },
  });
});

test("Cloudflare OIDC signing rotation publishes bounded overlap then removes the previous key", async () => {
  const db = await versionedAccountsDb();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const oldKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const newKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const oldPrivateJwk = await crypto.subtle.exportKey(
    "jwk",
    oldKeyPair.privateKey,
  );
  const newPrivateJwk = await crypto.subtle.exportKey(
    "jwk",
    newKeyPair.privateKey,
  );
  const oldPublicJwk = {
    ...(await crypto.subtle.exportKey("jwk", oldKeyPair.publicKey)),
    kid: "oidc-key-before-rotation",
    use: "sig",
    alg: "ES256",
  };
  const worker = createCloudflareWorker();
  const baseEnv = {
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "cloudflare-rotation-test-session-salt",
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET:
      "cloudflare-rotation-test-pairwise-secret",
  };

  const before = await worker.fetch(
    new Request("https://app.example.test/oauth/jwks"),
    env({
      ...baseEnv,
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(oldPrivateJwk),
      TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "oidc-key-before-rotation",
    }),
  );
  expect(before.status).toBe(200);
  expect((await before.json()).keys.map((key: JsonWebKey) => key.kid)).toEqual([
    "oidc-key-before-rotation",
  ]);

  const overlap = await worker.fetch(
    new Request("https://app.example.test/oauth/jwks"),
    env({
      ...baseEnv,
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(newPrivateJwk),
      TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "oidc-key-after-rotation",
      TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({
        keys: [oldPublicJwk],
      }),
    }),
  );
  expect(overlap.status).toBe(200);
  const overlapKeys = (await overlap.json()).keys as JsonWebKey[];
  expect(overlapKeys.map((key) => key.kid)).toEqual([
    "oidc-key-after-rotation",
    "oidc-key-before-rotation",
  ]);
  expect(overlapKeys.every((key) => key.d === undefined)).toBe(true);

  const after = await worker.fetch(
    new Request("https://app.example.test/oauth/jwks"),
    env({
      ...baseEnv,
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(newPrivateJwk),
      TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "oidc-key-after-rotation",
    }),
  );
  expect(after.status).toBe(200);
  expect((await after.json()).keys.map((key: JsonWebKey) => key.kid)).toEqual([
    "oidc-key-after-rotation",
  ]);
});

test("predeployed accounts routes perform multiple document operations with zero request-time DDL", async () => {
  const db = await versionedAccountsDb();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const sessionSalt = "predeployed-accounts-test-session-salt";
  const sessionId = "sess_predeployed_route";
  registerSessionHashSaltConfig({ salt: sessionSalt });
  await store.saveAccount({
    subject: "tsub_predeployed_route",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  await store.saveAccountSession({
    sessionId,
    subject: "tsub_predeployed_route",
    createdAt: 1_000,
    expiresAt: Date.now() + 60_000,
  });

  const predeployedDb = new NoDdlD1Database(db);
  const worker = createCloudflareWorker();
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: predeployedDb,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://localhost:8787",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: sessionSalt,
  });
  const sessionRequest = (method = "GET") =>
    new Request("http://localhost:8787/api/v1/account/session/me", {
      method,
      headers: {
        origin: "http://localhost:8787",
        "x-takosumi-account-session": sessionId,
      },
    });

  const getResponse = await worker.fetch(sessionRequest(), workerEnv);
  expect(getResponse.status).toBe(200);
  expect(await getResponse.json()).toMatchObject({
    subject: "tsub_predeployed_route",
  });

  const deleteResponse = await worker.fetch(
    sessionRequest("DELETE"),
    workerEnv,
  );
  expect(deleteResponse.status).toBe(204);

  const afterDelete = await worker.fetch(sessionRequest(), workerEnv);
  expect(afterDelete.status).toBe(200);
  expect(await afterDelete.json()).toEqual({ session: null });
  expect(predeployedDb.execCount).toBe(0);
});

test("predeployed accounts schema mode fails closed when schema is absent", async () => {
  const db = new SqliteFakeD1();
  const predeployedDb = new NoDdlD1Database(db);
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/api/v1/account/session/me"),
    env({
      TAKOSUMI_ACCOUNTS_DB: predeployedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "predeployed-accounts-absent-test-session-salt",
    }),
  );

  expect(response.status).toBe(500);
  expect(predeployedDb.execCount).toBe(0);
});

test("predeployed Accounts Worker rejects exact legacy v3 after v4 tightening", async () => {
  const predeployedDb = new NoDdlD1Database(await accountsDbAtHead(3));
  const diagnostics: string[] = [];
  const errorSpy = spyOn(console, "error").mockImplementation((value) => {
    if (typeof value === "string") diagnostics.push(value);
  });

  let response: Response;
  try {
    response = await createCloudflareWorker().fetch(
      new Request("https://app.example.test/api/v1/account/session/me"),
      env({
        TAKOSUMI_ACCOUNTS_DB: predeployedDb,
        TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
        TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
        TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
          "predeployed-accounts-v3-test-session-salt",
      }),
    );
  } finally {
    errorSpy.mockRestore();
  }

  expect(response.status).toBe(500);
  expect(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.includes('"event":"accounts_d1_schema_incompatible"') &&
        diagnostic.includes('"worker_catalog_head_not_accepted"'),
    ),
  ).toBe(true);
  expect(predeployedDb.execCount).toBe(0);
});

class NoDdlD1Database implements D1Database {
  execCount = 0;

  constructor(private readonly delegate: D1Database) {}

  prepare(query: string): D1PreparedStatement {
    return this.delegate.prepare(query);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    return this.delegate.batch<T>(statements);
  }

  exec(_query: string): Promise<D1ExecResult> {
    this.execCount += 1;
    return Promise.reject(new Error("request-time schema DDL is forbidden"));
  }
}
