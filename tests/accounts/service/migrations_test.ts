import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const migrationsDir = new URL(
  "../../../accounts/service/migrations/",
  import.meta.url,
);

async function readMigration(name: string): Promise<string> {
  return await readFile(new URL(name, migrationsDir), "utf8");
}

test("Takosumi Accounts migrations keep a unique numeric order", async () => {
  const names = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const prefixes = names.map((name) => Number(name.slice(0, 3)));
  expect(new Set(prefixes).size).toBe(prefixes.length);
  expect(prefixes).toEqual(prefixes.map((_, index) => index + 1));
});

test("Takosumi Accounts migrations preserve checksums accepted by existing databases", async () => {
  const fixture = (await Bun.file(
    new URL("./fixtures/valid-applied-catalog-v28.json", import.meta.url),
  ).json()) as AppliedCatalogFixture;
  const names = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .slice(0, fixture.migrations.length);

  expect(fixture.schemaVersion).toBe(1);
  expect(names).toEqual(fixture.migrations.map((migration) => migration.name));
  for (const migration of fixture.migrations) {
    const sql = await readMigration(migration.name);
    expect({
      version: Number(migration.name.slice(0, 3)),
      checksum: `sha256:${createHash("sha256").update(sql).digest("hex")}`,
    }).toEqual({
      version: migration.version,
      checksum: migration.checksum,
    });
  }
});

test("projection-ledger retirement moves OIDC registration to the Accounts schema", async () => {
  const migration = await readMigration(
    "032_retire_accounts_capsule_projection_ledger.sql",
  );
  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS accounts_v1.oidc_clients",
  );
  expect(migration).toContain("capsule_id text NOT NULL UNIQUE");
  expect(migration).toContain("namespace_path text NOT NULL");
  expect(migration).toContain("FROM installation_v1.oidc_clients");
});

test("projection-ledger retirement canonicalizes Capsule and Workspace references", async () => {
  const migration = await readMigration(
    "032_retire_accounts_capsule_projection_ledger.sql",
  );
  expect(migration).toContain("RENAME COLUMN installation_id TO capsule_id");
  expect(migration).toContain("RENAME COLUMN space_id TO workspace_id");
  expect(migration).toContain("DROP COLUMN app_id");
  expect(migration).toContain("personal_access_tokens_workspace_idx");
  expect(migration).toContain("billing_usage_records_capsule_idempotency_idx");
  expect(migration).toContain("billing_usage_records_capsule_reported_at_idx");
});

test("projection-ledger retirement removes the pre-v1 projection ledger", async () => {
  const migration = await readMigration(
    "032_retire_accounts_capsule_projection_ledger.sql",
  );
  expect(migration).toContain("DROP SCHEMA installation_v1 CASCADE");
  expect(
    migration.trimEnd().endsWith("DROP SCHEMA installation_v1 CASCADE;"),
  ).toBe(true);
});

test("historical billing storage migration removed provider-specific identifiers", async () => {
  const migration = await readMigration(
    "033_generalize_billing_provider_storage.sql",
  );
  expect(migration).toContain(
    "ALTER COLUMN provider TYPE text USING provider::text",
  );
  expect(migration).toContain(
    "RENAME COLUMN stripe_customer_id TO provider_customer_id",
  );
  expect(migration).toContain(
    "RENAME COLUMN stripe_subscription_id TO provider_subscription_id",
  );
  expect(migration).toContain(
    "RENAME COLUMN stripe_price_id TO provider_price_id",
  );
  expect(migration).toContain(
    "RENAME COLUMN stripe_default_payment_method_id TO provider_default_payment_method_id",
  );
  expect(migration).toContain(
    "DROP TYPE IF EXISTS accounts_v1.billing_provider_v1",
  );
});

test("current Accounts schema removes commercial billing persistence", async () => {
  const migration = await readMigration(
    "034_remove_commercial_billing_persistence.sql",
  );
  expect(migration).toContain(
    "DROP TABLE IF EXISTS accounts_v1.billing_usage_records",
  );
  expect(migration).toContain(
    "DROP TABLE IF EXISTS accounts_v1.billing_webhook_events",
  );
  expect(migration).toContain(
    "DROP TABLE IF EXISTS accounts_v1.billing_accounts",
  );
  expect(migration).toContain(
    "DROP TYPE IF EXISTS accounts_v1.billing_account_status_v1",
  );
});

test("current Accounts schema persists the optional UserInfo picture", async () => {
  const migration = await readMigration("035_account_picture.sql");
  expect(migration).toContain("ADD COLUMN IF NOT EXISTS picture text");
});

test("refresh-chain retention has timestamp and primary-key covering indexes", async () => {
  const migration = await readMigration(
    "036_refresh_chain_retention_indexes.sql",
  );
  expect(migration).toContain(
    "refresh_chain_links(created_at, parent_token_hash)",
  );
  expect(migration).toContain(
    "refresh_chain_access_tokens(\n    created_at,\n    root_token_hash,\n    access_token_hash",
  );
  expect(migration).toContain(
    "revoked_refresh_roots(revoked_at, root_token_hash)",
  );
  expect(migration).toContain(
    "consumed_authorization_codes(consumed_at, code_hash)",
  );
  expect(migration).toContain(
    "auth_code_token_links(\n    created_at,\n    code_hash,\n    access_token_hash,\n    refresh_root_hash",
  );
});

test("PAT scope widening validates before removing the legacy check", async () => {
  const initial = await readMigration("012_personal_access_tokens.sql");
  const add = await readMigration(
    "037_personal_access_tokens_resources_read_scope.sql",
  );
  const validate = await readMigration(
    "038_validate_personal_access_tokens_resources_read_scope.sql",
  );
  const drop = await readMigration(
    "039_drop_personal_access_tokens_legacy_scope_check.sql",
  );
  const addAi = await readMigration(
    "040_personal_access_tokens_ai_scopes.sql",
  );
  const validateAi = await readMigration(
    "041_validate_personal_access_tokens_ai_scopes.sql",
  );
  const dropV2 = await readMigration(
    "042_drop_personal_access_tokens_scopes_v2_check.sql",
  );

  expect(add).toContain(
    "ADD CONSTRAINT personal_access_tokens_scopes_v2_check CHECK",
  );
  expect(add).toContain("resources:read");
  expect(add).toContain(") NOT VALID;");
  expect(add).not.toContain("DROP CONSTRAINT");
  expect(initial).toContain("personal_access_tokens");
  expect(initial).toContain("ARRAY['read', 'write', 'admin']::text[]");

  const validationOffset = validate.indexOf(
    "VALIDATE CONSTRAINT personal_access_tokens_scopes_v2_check",
  );
  const dropOffset = drop.indexOf(
    "DROP CONSTRAINT personal_access_tokens_scopes_check",
  );
  expect(validationOffset).toBeGreaterThanOrEqual(0);
  expect(validate).not.toContain("DROP CONSTRAINT");
  expect(validate).not.toContain("ADD CONSTRAINT");
  expect(dropOffset).toBeGreaterThanOrEqual(0);
  expect(drop).toContain(
    "DROP CONSTRAINT personal_access_tokens_scopes_check;",
  );
  expect(drop).not.toContain("IF EXISTS");
  expect(drop).not.toContain("VALIDATE CONSTRAINT");

  expect(addAi).toContain(
    "ADD CONSTRAINT personal_access_tokens_scopes_v3_check CHECK",
  );
  for (const scope of ["ai.models.read", "ai.chat", "ai.embeddings"]) {
    expect(addAi).toContain(scope);
  }
  expect(addAi).toContain(") NOT VALID;");
  expect(addAi).not.toContain("DROP CONSTRAINT");
  expect(validateAi).toContain(
    "VALIDATE CONSTRAINT personal_access_tokens_scopes_v3_check",
  );
  expect(validateAi).not.toContain("DROP CONSTRAINT");
  expect(dropV2).toContain(
    "DROP CONSTRAINT personal_access_tokens_scopes_v2_check;",
  );
  expect(dropV2).not.toContain("IF EXISTS");
});

interface AppliedCatalogFixture {
  readonly schemaVersion: number;
  readonly migrations: readonly {
    readonly version: number;
    readonly name: string;
    readonly checksum: string;
  }[];
}
