import { expect, test } from "bun:test";
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
  issueInterfaceOAuthAccessToken,
} from "../../../../accounts/service/src/mod.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

function env(values: Record<string, unknown> = {}): CloudflareWorkerEnv {
  return values as CloudflareWorkerEnv;
}

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
    ...REQUIRED_PLATFORM_BINDINGS.queues,
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
  expect(csp).toContain(
    "script-src 'self' https://static.cloudflareinsights.com",
  );
  expect(csp.match(/script-src[^;]*/u)?.[0]).not.toContain("'unsafe-inline'");
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
    new Request("https://app.example.test/v1/auth/providers"),
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

test("Cloudflare auth discovery rejects malformed config without leaking it", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/v1/auth/providers"),
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

test("Cloudflare identity handler lazily revalidates Interface OAuth against Core", async () => {
  const db = new SqliteFakeD1();
  const store = new D1AccountsStore(db);
  await store.initialize();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO takosumi_accounts_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    )
    .bind(2, "current", Date.now())
    .run();
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

test("predeployed accounts schema mode performs no request-time DDL", async () => {
  const db = new SqliteFakeD1();
  const store = new D1AccountsStore(db);
  await store.initialize();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO takosumi_accounts_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    )
    .bind(2, "current", Date.now())
    .run();

  let requestTimeExecCalls = 0;
  const predeployedDb: CloudflareWorkerEnv["TAKOSUMI_ACCOUNTS_DB"] = {
    prepare: (query) => db.prepare(query),
    exec: () => {
      requestTimeExecCalls += 1;
      return Promise.reject(new Error("request-time schema DDL is forbidden"));
    },
  };
  const response = await createCloudflareWorker().fetch(
    new Request("http://localhost:8787/v1/account/session/me"),
    env({
      TAKOSUMI_ACCOUNTS_DB: predeployedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://localhost:8787",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "predeployed-accounts-test-session-salt",
    }),
  );

  expect(response.status).toBe(200);
  expect(requestTimeExecCalls).toBe(0);
});

test("predeployed accounts schema mode fails closed when schema is absent", async () => {
  const db = new SqliteFakeD1();
  let requestTimeExecCalls = 0;
  const predeployedDb: CloudflareWorkerEnv["TAKOSUMI_ACCOUNTS_DB"] = {
    prepare: (query) => db.prepare(query),
    exec: () => {
      requestTimeExecCalls += 1;
      return Promise.reject(new Error("request-time schema DDL is forbidden"));
    },
  };
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/v1/account/session/me"),
    env({
      TAKOSUMI_ACCOUNTS_DB: predeployedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "predeployed-accounts-absent-test-session-salt",
    }),
  );

  expect(response.status).toBe(500);
  expect(requestTimeExecCalls).toBe(0);
});
