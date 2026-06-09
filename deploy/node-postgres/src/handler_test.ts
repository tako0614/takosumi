import { expect, test } from "bun:test";
import { parseEnv } from "./handler.ts";

const BASE_ENV = {
  TAKOSUMI_ACCOUNTS_DATABASE_URL:
    "postgres://takosumi:secret@localhost:5432/takosumi_accounts?sslmode=require",
  TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.takosumi.example",
  TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/readiness.md",
  TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_APPROVAL_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/approval.md",
  TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_PUBLIC_SUMMARY:
    "P0 evidence and staged launch rehearsal passed for managed offering access.",
  TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_READINESS_DIGEST:
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/container-smoke.md",
  TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/egress.md",
  TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-catalog.md",
  TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/secret-boundary.md",
  TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST:
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
} satisfies Record<string, string>;

test("node-postgres managed offering defaults closed", () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_DATABASE_URL: BASE_ENV.TAKOSUMI_ACCOUNTS_DATABASE_URL,
  });

  expect(config.managedOfferingAccess.status).toBe("closed");
});

test("node-postgres managed offering open requires production hardening gate", () => {
  expect(() =>
    parseEnv({
      ...BASE_ENV,
      TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS: "open",
      TAKOSUMI_PRODUCTION_HARDENING_GATE: undefined,
    })
  ).toThrow(
    "Open managed offering access requires TAKOSUMI_PRODUCTION_HARDENING_GATE=enforce",
  );
});

test("node-postgres managed offering open requires commit-pinned hardening refs", () => {
  expect(() =>
    parseEnv({
      ...BASE_ENV,
      TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS: "open",
      TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
        "git+https://github.com/tako0614/takosumi-private.git#evidence/provider-catalog.md",
    })
  ).toThrow(
    "TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF must be commit-pinned git+ ref",
  );
});

test("node-postgres managed offering open accepts readiness and hardening evidence", () => {
  const config = parseEnv({
    ...BASE_ENV,
    TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS: "open",
  });

  expect(config.managedOfferingAccess).toMatchObject({
    status: "open",
    readinessDigest: BASE_ENV.TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_READINESS_DIGEST,
    evidenceRef: BASE_ENV.TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_EVIDENCE_REF,
    approvalRef: BASE_ENV.TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_APPROVAL_REF,
  });
});
