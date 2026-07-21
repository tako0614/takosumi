import { expect, test } from "bun:test";
import {
  UPSTREAM_PROVIDER_DESCRIPTORS_ENV,
  upstreamOAuthOptionsFromEnvironment,
} from "../../../../accounts/service/src/upstream-config.ts";

const provider = {
  providerId: "company-sso",
  label: "Company SSO",
  issuer: "https://id.example.test",
  authorizationEndpoint: "https://id.example.test/oauth/authorize",
  tokenEndpoint: "https://id.example.test/oauth/token",
  userInfoEndpoint: "https://id.example.test/oauth/userinfo",
  clientId: "accounts-client",
  clientSecretEnv: "COMPANY_SSO_CLIENT_SECRET",
  redirectUri: "https://accounts.example.test/sign-in/callback",
  scopes: ["openid", "profile", "email"],
};

test("upstream provider descriptors resolve arbitrary providers explicitly", () => {
  const options = upstreamOAuthOptionsFromEnvironment({
    [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([provider]),
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
    TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS: "60000",
    COMPANY_SSO_CLIENT_SECRET: "client-secret",
  });

  expect(options?.providers).toHaveLength(1);
  expect(options?.providers[0]).toMatchObject({
    providerId: "company-sso",
    label: "Company SSO",
    protocol: "oidc",
    clientId: "accounts-client",
    clientSecret: "client-secret",
    redirectUri: "https://accounts.example.test/sign-in/callback",
  });
  expect(options?.providers[0]?.provider).toMatchObject({
    id: "company-sso",
    issuer: "https://id.example.test",
    tokenEndpoint: "https://id.example.test/oauth/token",
  });
  expect(options?.sessionTtlMs).toBe(60000);
});

test("issuer identity is spelling-stable across trailing-slash drift", () => {
  // The issuer is one of the two inputs that key `upstream_identities` and seed
  // the account-subject HMAC. If parsing rewrites it (URL.toString() appending
  // "/" to an origin-only issuer, an operator adding or dropping the slash),
  // every existing user of that provider silently lands on a brand-new empty
  // account on their next sign-in. Both spellings must resolve to one string.
  const resolveIssuer = (issuer: string): string | undefined =>
    upstreamOAuthOptionsFromEnvironment({
      [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([
        { ...provider, issuer },
      ]),
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      COMPANY_SSO_CLIENT_SECRET: "client-secret",
    })?.providers[0]?.provider.issuer;

  expect(resolveIssuer("https://accounts.google.com")).toBe(
    "https://accounts.google.com",
  );
  expect(resolveIssuer("https://accounts.google.com/")).toBe(
    "https://accounts.google.com",
  );
  expect(resolveIssuer("https://id.example.test/oidc/")).toBe(
    "https://id.example.test/oidc",
  );
});

test("provider identifiers never select a built-in adapter", () => {
  const options = upstreamOAuthOptionsFromEnvironment({
    [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([
      {
        ...provider,
        providerId: "well-known-vendor",
        clientSecretEnv: undefined,
      },
    ]),
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
  });

  expect(options?.providers[0]?.provider.authorizationEndpoint).toBe(
    "https://id.example.test/oauth/authorize",
  );
});

test("public descriptor metadata is normalized and malformed values fail closed", () => {
  const options = upstreamOAuthOptionsFromEnvironment({
    [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([
      { ...provider, protocol: "OIDC" },
    ]),
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
    COMPANY_SSO_CLIENT_SECRET: "client-secret",
  });
  expect(options?.providers[0]).toMatchObject({
    providerId: "company-sso",
    label: "Company SSO",
    protocol: "oidc",
  });

  expect(() =>
    upstreamOAuthOptionsFromEnvironment({
      [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([
        { ...provider, protocol: "oidc/private-detail" },
      ]),
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      COMPANY_SSO_CLIENT_SECRET: "client-secret",
    }),
  ).toThrow("protocol must be a lowercase provider token");

  expect(() =>
    upstreamOAuthOptionsFromEnvironment({
      [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([
        { ...provider, label: "" },
      ]),
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      COMPANY_SSO_CLIENT_SECRET: "client-secret",
    }),
  ).toThrow("label must be a non-empty string");
});

test("upstream descriptor cannot shadow the WebAuthn passkey provider", () => {
  expect(() =>
    upstreamOAuthOptionsFromEnvironment({
      [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([
        { ...provider, providerId: "passkey" },
      ]),
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      COMPANY_SSO_CLIENT_SECRET: "client-secret",
    }),
  ).toThrow("providerId is reserved for the WebAuthn provider");
});

test("inline and unresolved upstream client secrets fail closed", () => {
  expect(() =>
    upstreamOAuthOptionsFromEnvironment({
      [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([
        { ...provider, clientSecret: "must-not-be-public" },
      ]),
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
    }),
  ).toThrow("inline client secrets are forbidden");

  expect(() =>
    upstreamOAuthOptionsFromEnvironment({
      [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([provider]),
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
    }),
  ).toThrow("references missing runtime secret COMPANY_SSO_CLIENT_SECRET");
});

test("descriptor config requires a subject secret and unique provider ids", () => {
  expect(() =>
    upstreamOAuthOptionsFromEnvironment({
      [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([provider]),
      COMPANY_SSO_CLIENT_SECRET: "client-secret",
    }),
  ).toThrow("requires TAKOSUMI_ACCOUNTS_SUBJECT_SECRET");

  expect(() =>
    upstreamOAuthOptionsFromEnvironment({
      [UPSTREAM_PROVIDER_DESCRIPTORS_ENV]: JSON.stringify([
        provider,
        { ...provider, label: "Duplicate" },
      ]),
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      COMPANY_SSO_CLIENT_SECRET: "client-secret",
    }),
  ).toThrow("providerId is duplicated");
});
