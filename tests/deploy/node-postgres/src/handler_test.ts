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
  TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-catalog.md",
  TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
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

test("node-postgres platform readiness defaults closed", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
  });

  expect(config.platformAccess.status).toBe("closed");
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
