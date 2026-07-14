import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  assertDatabaseEncryptionAtRest,
  DatabaseEncryptionConfigurationError,
  inspectDatabaseEncryption,
  resolveBootDatabaseUrl,
} from "../../../../core/adapters/storage/encryption.ts";

test("assertDatabaseEncryptionAtRest fails closed in production with plain postgres", () => {
  assert.throws(
    () =>
      assertDatabaseEncryptionAtRest({
        env: {
          TAKOSUMI_ENVIRONMENT: "production",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/takos",
        },
      }),
    DatabaseEncryptionConfigurationError,
  );
});

test("assertDatabaseEncryptionAtRest fails closed in staging with plain postgres", () => {
  assert.throws(
    () =>
      assertDatabaseEncryptionAtRest({
        env: {
          TAKOSUMI_ENVIRONMENT: "staging",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/takos",
        },
      }),
    DatabaseEncryptionConfigurationError,
  );
});

test("database URL hints do not count as at-rest encryption evidence", () => {
  for (const databaseUrl of [
    "postgres://user:pass@db.example.com/takos?sslmode=verify-full",
    "custom-managed://database?encrypted=true",
    "d1://cloudflare-d1-binding",
    "sqlite:///var/lib/takos/db.sqlite?key=secret",
  ]) {
    assert.throws(
      () =>
        assertDatabaseEncryptionAtRest({
          env: {
            TAKOSUMI_ENVIRONMENT: "production",
            DATABASE_URL: databaseUrl,
          },
        }),
      DatabaseEncryptionConfigurationError,
    );
  }
});

test("assertDatabaseEncryptionAtRest accepts host-injected adapter evidence", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL: "custom://database",
    },
    evidence: { id: "adapter.storage.encryption/v1" },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.evidence, "adapter.storage.encryption/v1");
});

test("assertDatabaseEncryptionAtRest accepts explicit operator evidence", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL: "custom://database",
      TAKOSUMI_DATABASE_ENCRYPTION_AT_REST: "verified",
      TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE: "kms-policy/production-v3",
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.evidence, "kms-policy/production-v3");
});

test("operator evidence uses an exact token and a safe evidence id", () => {
  for (const env of [
    {
      TAKOSUMI_DATABASE_ENCRYPTION_AT_REST: "true",
    },
    {
      TAKOSUMI_DATABASE_ENCRYPTION_AT_REST: "verified",
      TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE: "contains spaces",
    },
  ]) {
    assert.throws(
      () =>
        assertDatabaseEncryptionAtRest({
          env: {
            TAKOSUMI_ENVIRONMENT: "production",
            DATABASE_URL: "custom://database",
            ...env,
          },
        }),
      DatabaseEncryptionConfigurationError,
    );
  }
});

test("assertDatabaseEncryptionAtRest production ignores TAKOSUMI_DEV_MODE override", () => {
  assert.throws(
    () =>
      assertDatabaseEncryptionAtRest({
        env: {
          TAKOSUMI_ENVIRONMENT: "production",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/takos",
          TAKOSUMI_DEV_MODE: "1",
        },
      }),
    DatabaseEncryptionConfigurationError,
  );
});

test("assertDatabaseEncryptionAtRest local without override still allows boot (silent satisfy)", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "local",
      DATABASE_URL: "postgres://user:pass@localhost:5432/takos",
    },
  });
  // Local is not "required". The assertion is not satisfied (no encryption
  // evidence) but the throw only fires when required.
  assert.equal(result.required, false);
});

test("assertDatabaseEncryptionAtRest local with TAKOSUMI_DEV_MODE sets overrideAccepted", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "local",
      DATABASE_URL: "postgres://user:pass@localhost:5432/takos",
      TAKOSUMI_DEV_MODE: "1",
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.overrideAccepted, true);
  assert.equal(result.evidence, "local-override");
});

test("assertDatabaseEncryptionAtRest production with no DB url is fail-closed", () => {
  assert.throws(
    () =>
      assertDatabaseEncryptionAtRest({
        env: { TAKOSUMI_ENVIRONMENT: "production" },
      }),
    DatabaseEncryptionConfigurationError,
  );
});

test("inspectDatabaseEncryption preserves info without throwing", () => {
  const inspection = inspectDatabaseEncryption({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL: "custom://database",
    },
    evidence: { id: "storage-adapter/key-policy-v1" },
  });
  assert.equal(inspection.satisfied, true);
  assert.equal(inspection.evidence, "storage-adapter/key-policy-v1");
});

test("resolveBootDatabaseUrl prefers TAKOSUMI_DATABASE_URL over DATABASE_URL", () => {
  assert.equal(
    resolveBootDatabaseUrl({
      TAKOSUMI_DATABASE_URL: "postgres://primary",
      DATABASE_URL: "postgres://fallback",
    }),
    "postgres://primary",
  );
});

test("resolveBootDatabaseUrl falls back to staging url in staging env", () => {
  assert.equal(
    resolveBootDatabaseUrl({
      TAKOSUMI_ENVIRONMENT: "staging",
      TAKOSUMI_STAGING_DATABASE_URL: "postgres://staging?sslmode=require",
    }),
    "postgres://staging?sslmode=require",
  );
});
