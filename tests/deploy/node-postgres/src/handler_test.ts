import { expect, test } from "bun:test";
import { parseEnv } from "../../../../deploy/node-postgres/src/handler.ts";

const BASE_ENV = {
  TAKOSUMI_ACCOUNTS_DATABASE_URL:
    "postgres://takosumi:secret@localhost:5432/takosumi_accounts?sslmode=require",
  TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.example",
  TAKOSUMI_ACCOUNTS_PLATFORM_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/readiness.md",
  TAKOSUMI_ACCOUNTS_PLATFORM_APPROVAL_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/approval.md",
  TAKOSUMI_ACCOUNTS_PLATFORM_PUBLIC_SUMMARY:
    "P0 evidence and staged launch rehearsal passed for platform readiness access.",
  TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST:
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/container-smoke.md",
  TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/platform-control-plane-smoke.md",
  TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST:
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/egress.md",
  TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/restore-rehearsal.md",
  TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_DIGEST:
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  TAKOSUMI_CREDENTIAL_RECIPE_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-connections.md",
  TAKOSUMI_CREDENTIAL_RECIPE_EVIDENCE_DIGEST:
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/cost-attribution.md",
  TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST:
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/secret-boundary.md",
  TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST:
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
} satisfies Record<string, string>;

const RELEASE_ACTIVATION_ENV = {
  TAKOSUMI_RELEASE_ACTIVATOR_URL: "https://materializer.example.com/activate",
  TAKOSUMI_RELEASE_ACTIVATOR_TOKEN: "release-activator-token",
  TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-success.md",
  TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_DIGEST:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-failure-surfacing.md",
  TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_DIGEST:
    "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-ledger-independence.md",
  TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_DIGEST:
    "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-payload-boundary.md",
  TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_DIGEST:
    "sha256:5555555555555555555555555555555555555555555555555555555555555555",
} satisfies Record<string, string>;

test("node-postgres platform readiness defaults closed", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
  });

  expect(config.platformAccess.status).toBe("closed");
});

test("node-postgres preserves the operator managed public base domain", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
    TAKOSUMI_MANAGED_PUBLIC_BASE_DOMAIN: "app-staging.takos.example",
  });

  expect(config.managedPublicBaseDomain).toBe("app-staging.takos.example");
});

test("node-postgres treats subject secret without upstream providers as disabled upstream OAuth", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
  });

  expect(config.upstreamOAuth).toBeUndefined();
});

test("node-postgres ignores retired GitHub OAuth env", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
    TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_ID: "github-client",
    TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_REDIRECT_URI:
      "https://accounts.example/sign-in/callback",
  });

  expect(config.upstreamOAuth).toBeUndefined();
});

test("node-postgres ignores non-Google first-party upstream OAuth env", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
    TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_CLIENT_ID: "apple-client",
    TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_CLIENT_SECRET: "apple-secret",
    TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_REDIRECT_URI:
      "https://accounts.example/sign-in/callback",
  });

  expect(config.upstreamOAuth).toBeUndefined();
});

test("node-postgres enforces the pre-GA login allowlist for official Cloud", () => {
  const expected = {
    emails: ["shoutatomiyama0614@gmail.com"],
    requireVerifiedEmail: true,
  };

  expect(
    parseEnv({
      TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
      TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "*",
    }).loginEmailAllowlist,
  ).toEqual(expected);
  expect(
    parseEnv({
      TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
      TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST:
        "someone-else@example.test,shoutatomiyama0614@gmail.com",
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED: "false",
    }).loginEmailAllowlist,
  ).toEqual(expected);
});

test("node-postgres keeps login allowlist configurable for operator origins", () => {
  expect(
    parseEnv({
      TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
      TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.example.test",
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST:
        "owner@example.test,admin@example.test",
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED: "false",
    }).loginEmailAllowlist,
  ).toEqual({
    emails: ["owner@example.test", "admin@example.test"],
    requireVerifiedEmail: false,
  });
  expect(
    parseEnv({
      TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
      TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.example.test",
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "*",
    }).loginEmailAllowlist,
  ).toBeUndefined();
});

test("node-postgres carries previous OIDC public JWKS for rotation overlap", () => {
  const previousPublicJwks = JSON.stringify({
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
    TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
    TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK:
      '{"kty":"EC","crv":"P-256","d":"private-d","x":"active-x","y":"active-y"}',
    TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "active-key",
    TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS: previousPublicJwks,
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "pairwise-secret",
    TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET: "launch-secret",
  });

  expect(config.stableOidc).toMatchObject({
    keyId: "active-key",
    previousPublicJwksJson: previousPublicJwks,
  });
});

test("node-postgres rejects retired custom OIDC GitHub provider id", () => {
  expect(() =>
    parseEnv({
      TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_PROVIDER_ID: "GitHub",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_ISSUER: "https://github.com/login/oauth",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_AUTHORIZATION_ENDPOINT:
        "https://github.com/login/oauth/authorize",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_TOKEN_ENDPOINT:
        "https://github.com/login/oauth/access_token",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_USERINFO_ENDPOINT:
        "https://api.github.com/user",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_ID: "github-client",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_SECRET: "github-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_REDIRECT_URI:
        "https://accounts.example/v1/auth/upstream/callback",
    }),
  ).toThrow("Custom upstream OIDC provider id GitHub is reserved or retired");
});

test("node-postgres platform readiness open requires production hardening gate", () => {
  expect(() =>
    parseEnv({
      ...BASE_ENV,
      TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "open",
      TAKOSUMI_PRODUCTION_HARDENING_GATE: undefined,
    }),
  ).toThrow(
    "Open platform readiness access requires TAKOSUMI_PRODUCTION_HARDENING_GATE=enforce",
  );
});

test("node-postgres platform readiness open requires commit-pinned hardening refs", () => {
  expect(() =>
    parseEnv({
      ...BASE_ENV,
      TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "open",
      TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF:
        "git+https://github.com/tako0614/takosumi-private.git#evidence/platform-control-plane-smoke.md",
    }),
  ).toThrow(
    "TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF must be commit-pinned git+ ref",
  );
});

test("node-postgres platform readiness open accepts readiness and hardening evidence", () => {
  const config = parseEnv({
    ...BASE_ENV,
    TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "open",
  });

  expect(config.platformAccess).toMatchObject({
    status: "open",
    readinessDigest: BASE_ENV.TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST,
    evidenceRef: BASE_ENV.TAKOSUMI_ACCOUNTS_PLATFORM_EVIDENCE_REF,
    approvalRef: BASE_ENV.TAKOSUMI_ACCOUNTS_PLATFORM_APPROVAL_REF,
  });
});

test("node-postgres platform readiness open requires release activation evidence when activator is enabled", () => {
  expect(() =>
    parseEnv({
      ...BASE_ENV,
      TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "open",
      TAKOSUMI_RELEASE_ACTIVATOR_URL:
        RELEASE_ACTIVATION_ENV.TAKOSUMI_RELEASE_ACTIVATOR_URL,
      TAKOSUMI_RELEASE_ACTIVATOR_TOKEN:
        RELEASE_ACTIVATION_ENV.TAKOSUMI_RELEASE_ACTIVATOR_TOKEN,
    }),
  ).toThrow(
    "Open platform readiness access requires TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_REF",
  );
});

test("node-postgres platform readiness open accepts release activation evidence when activator is enabled", () => {
  const config = parseEnv({
    ...BASE_ENV,
    ...RELEASE_ACTIVATION_ENV,
    TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "open",
  });

  expect(config.platformAccess).toMatchObject({
    status: "open",
    readinessDigest: BASE_ENV.TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST,
  });
});
