import { expect, test } from "bun:test";
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
