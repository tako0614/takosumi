import { expect, test } from "bun:test";
import { parseEnv } from "../../../../deploy/node-postgres/src/handler.ts";

const DATABASE_URL =
  "postgres://takosumi:secret@localhost:5432/takosumi_accounts?sslmode=require";

test("node-postgres parses substrate config without runtime projection knobs", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: DATABASE_URL,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
    TAKOSUMI_MANAGED_PUBLIC_BASE_DOMAIN: "apps.example.test",
  });
  expect(config).toMatchObject({
    databaseUrl: DATABASE_URL,
    issuer: "https://app.example.test",
    managedPublicBaseDomain: "apps.example.test",
  });
  expect("platformAccess" in config).toBe(false);
  expect("exportDownload" in config).toBe(false);
});

test("node-postgres keeps the login allowlist operator-configurable", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: DATABASE_URL,
    TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST:
      "owner@example.test,admin@example.test",
    TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED: "false",
  });
  expect(config.loginEmailAllowlist).toEqual({
    emails: ["owner@example.test", "admin@example.test"],
    requireVerifiedEmail: false,
  });
});

test("node-postgres preserves a host-specific public mobile OIDC client", () => {
  const mobileClient = {
    clientId: "takos-mobile-host-example",
    redirectUris: ["takos://oauth/callback"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid", "profile", "offline_access", "spaces:read"],
  } as const;
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: DATABASE_URL,
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([mobileClient]),
  });

  expect(config.clients).toEqual([mobileClient]);
});

test("node-postgres resolves the Takosumi Mobile discovery client", () => {
  const mobileClient = {
    clientId: "takosumi-mobile-host-example",
    redirectUris: ["takosumi://oauth/callback"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: [
      "openid",
      "profile",
      "offline_access",
      "capsules:read",
      "capsules:write",
    ],
  } as const;
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: DATABASE_URL,
    TAKOSUMI_MOBILE_OIDC_CLIENT_ID: mobileClient.clientId,
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([mobileClient]),
  });

  expect(config.mobileOidcClientId).toBe(mobileClient.clientId);
});

test("node-postgres stable OIDC needs only the OIDC pairwise subject secret", () => {
  const previousPublicJwksJson = JSON.stringify({
    keys: [
      {
        kty: "EC",
        crv: "P-256",
        kid: "previous-key",
        x: "public-x",
        y: "public-y",
      },
    ],
  });
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: DATABASE_URL,
    TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK:
      '{"kty":"EC","crv":"P-256","d":"private-d","x":"active-x","y":"active-y"}',
    TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "active-key",
    TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS: previousPublicJwksJson,
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "pairwise-secret",
  });
  expect(config.stableOidc).toMatchObject({
    keyId: "active-key",
    previousPublicJwksJson,
    oidcPairwiseSubjectSecret: "pairwise-secret",
  });
  expect("launchTokenPairwiseSecret" in (config.stableOidc ?? {})).toBe(false);
});

test("node-postgres supports an explicit custom OIDC provider", () => {
  const descriptors = JSON.stringify([
    {
      providerId: "company-sso",
      label: "Company SSO",
      issuer: "https://id.example.test",
      authorizationEndpoint: "https://id.example.test/authorize",
      tokenEndpoint: "https://id.example.test/token",
      userInfoEndpoint: "https://id.example.test/userinfo",
      clientId: "oidc-client",
      redirectUri: "https://app.example.test/sign-in/callback",
    },
  ]);
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: DATABASE_URL,
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
    TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: descriptors,
  });
  expect(config.upstreamOAuth?.providers[0]).toMatchObject({
    providerId: "company-sso",
    label: "Company SSO",
    protocol: "oidc",
  });
});
