import assert from "node:assert/strict";
import {
  assertDatabaseEncryptionAtRest,
  DatabaseEncryptionConfigurationError,
  inspectDatabaseEncryption,
  resolveBootDatabaseUrl,
} from "./encryption.ts";

Deno.test("assertDatabaseEncryptionAtRest fails closed in production with plain postgres", () => {
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

Deno.test("assertDatabaseEncryptionAtRest fails closed in staging with plain postgres", () => {
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

Deno.test("assertDatabaseEncryptionAtRest accepts sslmode=require in production", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL:
        "postgres://user:pass@db.example.com:5432/takos?sslmode=require",
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.evidence, "sslmode=require");
});

Deno.test("assertDatabaseEncryptionAtRest accepts sslmode=verify-full in production", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL:
        "postgres://user:pass@db.example.com:5432/takos?sslmode=verify-full",
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.evidence, "sslmode=verify-full");
});

Deno.test("assertDatabaseEncryptionAtRest rejects sslmode=disable in production", () => {
  assert.throws(
    () =>
      assertDatabaseEncryptionAtRest({
        env: {
          TAKOSUMI_ENVIRONMENT: "production",
          DATABASE_URL:
            "postgres://user:pass@db.example.com:5432/takos?sslmode=disable",
        },
      }),
    DatabaseEncryptionConfigurationError,
  );
});

Deno.test("assertDatabaseEncryptionAtRest accepts encrypted=true generic flag", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL: "mysql://user:pass@db.example.com/takos?encrypted=true",
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.evidence, "encrypted-flag");
});

Deno.test("assertDatabaseEncryptionAtRest accepts D1 (managed encrypted)", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL: "d1://takos-prod-d1-binding",
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.evidence, "d1-managed-encryption");
});

Deno.test("assertDatabaseEncryptionAtRest accepts sqlcipher in production", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL: "sqlcipher:///var/lib/takos/audit.db?key=...",
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.evidence, "sqlcipher");
});

Deno.test("assertDatabaseEncryptionAtRest accepts sqlite with key=", () => {
  const result = assertDatabaseEncryptionAtRest({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL: "sqlite:///var/lib/takos/audit.db?key=secret",
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.evidence, "sqlite-with-key");
});

Deno.test("assertDatabaseEncryptionAtRest rejects plain sqlite in production", () => {
  assert.throws(
    () =>
      assertDatabaseEncryptionAtRest({
        env: {
          TAKOSUMI_ENVIRONMENT: "production",
          DATABASE_URL: "sqlite:///var/lib/takos/audit.db",
        },
      }),
    DatabaseEncryptionConfigurationError,
  );
});

Deno.test("assertDatabaseEncryptionAtRest production ignores TAKOSUMI_DEV_MODE override", () => {
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

Deno.test("assertDatabaseEncryptionAtRest local without override still allows boot (silent satisfy)", () => {
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

Deno.test("assertDatabaseEncryptionAtRest local with TAKOSUMI_DEV_MODE sets overrideAccepted", () => {
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

Deno.test("assertDatabaseEncryptionAtRest production with no DB url is fail-closed", () => {
  assert.throws(
    () =>
      assertDatabaseEncryptionAtRest({
        env: { TAKOSUMI_ENVIRONMENT: "production" },
      }),
    DatabaseEncryptionConfigurationError,
  );
});

Deno.test("inspectDatabaseEncryption preserves info without throwing", () => {
  const inspection = inspectDatabaseEncryption({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      DATABASE_URL: "postgres://u:p@db/t?sslmode=require",
    },
  });
  assert.equal(inspection.satisfied, true);
  assert.equal(inspection.evidence, "sslmode=require");
});

Deno.test("resolveBootDatabaseUrl prefers TAKOSUMI_DATABASE_URL over DATABASE_URL", () => {
  assert.equal(
    resolveBootDatabaseUrl({
      TAKOSUMI_DATABASE_URL: "postgres://primary",
      DATABASE_URL: "postgres://fallback",
    }),
    "postgres://primary",
  );
});

Deno.test("resolveBootDatabaseUrl falls back to staging url in staging env", () => {
  assert.equal(
    resolveBootDatabaseUrl({
      TAKOSUMI_ENVIRONMENT: "staging",
      TAKOSUMI_STAGING_DATABASE_URL: "postgres://staging?sslmode=require",
    }),
    "postgres://staging?sslmode=require",
  );
});
