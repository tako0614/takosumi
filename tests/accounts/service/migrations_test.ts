import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

const migrationsDir = new URL(
  "../../../accounts/service/migrations/",
  import.meta.url,
);

async function readMigration(name: string): Promise<string> {
  return await readFile(new URL(name, migrationsDir), "utf8");
}

test("accounts identity and billing migration covers AccountsStore production state", async () => {
  const migration = await readMigration(
    "008_accounts_identity_billing_store.sql",
  );
  const requiredTables = [
    "accounts_v1.accounts",
    "accounts_v1.upstream_identities",
    "accounts_v1.passkey_credentials",
    "accounts_v1.account_sessions",
    "accounts_v1.authorization_codes",
    "accounts_v1.oauth_access_tokens",
    "accounts_v1.oauth_refresh_tokens",
    "accounts_v1.billing_accounts",
    "accounts_v1.billing_webhook_events",
  ];

  for (const table of requiredTables) {
    expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  }
  expect(migration).toContain("CREATE SCHEMA IF NOT EXISTS accounts_v1");
  expect(migration).toContain("REFERENCES installation_v1.app_installations");
  expect(migration).toContain("REFERENCES installation_v1.spaces");
  expect(migration).toContain("stripe_price_id text");
  expect(migration).toContain("plan_code text");
  expect(migration).toContain("last_invoice_id text");
  expect(migration).toContain("dunning_started_at timestamptz");
  expect(migration).toContain("next_payment_attempt_unix bigint");
  expect(migration).toContain("dunning_attempt_count integer");
  expect(migration).toContain("dunning_action text");
  expect(migration).toContain("dunning_exhausted_at timestamptz");
  expect(migration).toContain("last_credit_event_id text");
  expect(migration).toContain("last_credit_kind text");
  expect(migration).toContain("last_credit_amount bigint");
  expect(migration).toContain("last_plan_transition_event_id text");
  expect(migration).toContain("last_plan_transitioned_at timestamptz");
  expect(migration).toContain("last_tax_event_id text");
  expect(migration).toContain("tax_policy_ref text");
  expect(migration).toContain("tax_jurisdiction text");
  expect(migration).toContain("tax_automatic_status text");
  expect(migration).toContain("terms_version text");
  expect(migration).toContain("terms_accepted_at timestamptz");
  expect(migration).toContain("terms_accepted_source text");
  expect(migration).toContain("CHECK (code_hash LIKE 'sha256:%')");
  expect(migration).toContain("CHECK (token_hash LIKE 'sha256:%')");
});

test("takosumi migrations keep their numeric order", async () => {
  const names = [];
  for (const entry of await readdir(migrationsDir, { withFileTypes: true })) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();

  const prefixes = names.map((name) => Number(name.slice(0, 3)));
  expect(prefixes.length > 0).toBeTruthy();
  for (const [index, prefix] of prefixes.entries()) {
    expect(prefix === index + 1).toBeTruthy();
  }
});

test("app grant capability catalog migration restricts grants", async () => {
  const baseline = await readMigration("001_app_installation_ledger.sql");
  const migration = await readMigration("009_app_grant_capability_catalog.sql");

  for (const sql of [baseline, migration]) {
    expect(sql).toContain("'files:read'");
    expect(sql).toContain("'threads:write'");
    expect(sql).toContain("'agents:execute'");
    expect(sql).toContain("'events:subscribe'");
    expect(sql).toContain("capability IN");
  }
  expect(migration).toContain("app_grants_capability_catalog_v1");
});

test("accounts boundary cleanup drops retired descriptor/import storage", async () => {
  const migration = await readMigration("010_accounts_boundary_cleanup.sql");

  expect(migration).toContain(
    "DROP TABLE IF EXISTS accounts_v1.service_descriptors",
  );
  expect(migration).toContain("DROP COLUMN IF EXISTS service_imports_json");
  expect(migration).toContain(
    "DROP CONSTRAINT IF EXISTS app_installations_runtime_binding_id_fkey",
  );
  expect(migration).toContain("event_sequence");
  expect(migration).toContain(
    "installation_events_one_root_per_installation_idx",
  );
  expect(migration).toContain("installation_events_one_successor_per_hash_idx");
});

test("personal access token migration stores Accounts PATs without raw secrets", async () => {
  const migration = await readMigration("012_personal_access_tokens.sql");

  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS accounts_v1.personal_access_tokens",
  );
  expect(migration).toContain("token_hash text NOT NULL UNIQUE");
  expect(migration).toContain("token_prefix text NOT NULL");
  expect(migration).toContain("REFERENCES accounts_v1.accounts");
  expect(migration).toContain(
    "scopes <@ ARRAY['read', 'write', 'admin']::text[]",
  );
  expect(migration).toContain("personal_access_tokens_subject_idx");
});

test("authorization code nonce migration preserves OIDC nonce checks", async () => {
  const migration = await readMigration("013_authorization_code_nonce.sql");

  expect(migration).toContain("ALTER TABLE accounts_v1.authorization_codes");
  expect(migration).toContain("ADD COLUMN IF NOT EXISTS nonce text");
});

test("billing usage migration records metered AppInstallation usage", async () => {
  const migration = await readMigration("015_billing_usage_records.sql");

  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS accounts_v1.billing_usage_records",
  );
  expect(migration).toContain("REFERENCES installation_v1.app_installations");
  expect(migration).toContain("REFERENCES accounts_v1.billing_accounts");
  expect(migration).toContain("quantity double precision NOT NULL");
  expect(migration).toContain("request_digest text NOT NULL");
  expect(migration).toContain(
    "billing_usage_records_installation_idempotency_idx",
  );
});

test("launch token retention migration indexes cleanup predicates", async () => {
  const migration = await readMigration("016_launch_token_retention_index.sql");

  expect(migration).toContain("launch_tokens_retention_expires_idx");
  expect(migration).toContain("launch_tokens_retention_used_idx");
  expect(migration).toContain("WHERE used_at IS NOT NULL");
});

test("Wave 6 v1 contract reset drops binding/grant/runtime-binding tables", async () => {
  const migration = await readMigration(
    "017_drop_binding_grant_runtime_binding.sql",
  );

  expect(migration).toContain(
    "DROP TABLE IF EXISTS installation_v1.app_grants",
  );
  expect(migration).toContain(
    "DROP TABLE IF EXISTS installation_v1.app_bindings",
  );
  expect(migration).toContain(
    "DROP TABLE IF EXISTS installation_v1.runtime_bindings",
  );
  expect(migration).toContain("DROP COLUMN IF EXISTS runtime_binding_id");
});

test("service binding material migration does not restore retired app binding tables", async () => {
  const migration = await readMigration("024_service_binding_materials.sql");

  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS installation_v1.service_binding_materials",
  );
  expect(migration).toContain("REFERENCES installation_v1.app_installations");
  expect(migration).toContain("service_binding_materials_kind_catalog_v1");
  expect(migration).toContain("service_binding_materials_installation_id_idx");
  expect(migration).not.toContain("installation_v1.app_bindings");
  expect(migration).not.toContain("installation_v1.app_grants");
});

test("privacy request migration records export and deletion operations", async () => {
  const migration = await readMigration("025_privacy_requests.sql");

  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS accounts_v1.privacy_requests",
  );
  expect(migration).toContain("REFERENCES accounts_v1.accounts");
  expect(migration).toContain("privacy_requests_kind_catalog_v1");
  expect(migration).toContain("privacy_requests_status_catalog_v1");
  expect(migration).toContain("'login_disabled'");
  expect(migration).toContain("retention_record_id text NOT NULL");
  expect(migration).toContain("privacy_requests_subject_idx");
  expect(migration).toContain("privacy_requests_status_idx");
});

test("app installation source path migration preserves Capsule module path", async () => {
  const migration = await readMigration("026_app_installation_source_path.sql");

  expect(migration).toContain("ALTER TABLE installation_v1.app_installations");
  expect(migration).toContain("ADD COLUMN IF NOT EXISTS source_path text");
  expect(migration).toContain("OpenTofu Capsule restore/import fidelity");
});

test("F7 event chain lock migration creates per-installation row lock", async () => {
  const migration = await readMigration("018_event_chain_lock.sql");

  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS installation_v1.installation_event_chain_locks",
  );
  expect(migration).toContain("installation_id text PRIMARY KEY");
  expect(migration).toContain(
    "REFERENCES installation_v1.app_installations(installation_id)",
  );
  expect(migration).toContain("ON DELETE CASCADE");
});

test("F30 refresh chain migration persists rotation links and code reuse markers", async () => {
  const migration = await readMigration("019_refresh_chain.sql");

  for (const table of [
    "accounts_v1.refresh_chain_links",
    "accounts_v1.revoked_refresh_roots",
    "accounts_v1.consumed_authorization_codes",
    "accounts_v1.auth_code_token_links",
    "accounts_v1.refresh_chain_access_tokens",
  ]) {
    expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  }
  expect(migration).toContain(
    "parent_token_hash text PRIMARY KEY CHECK (parent_token_hash LIKE 'sha256:%')",
  );
  expect(migration).toContain("root_token_hash text NOT NULL");
  expect(migration).toContain(
    "code_hash text PRIMARY KEY CHECK (code_hash LIKE 'sha256:%')",
  );
  expect(migration).toContain("refresh_chain_links_root_idx");
  expect(migration).toContain("refresh_chain_access_tokens_root_idx");
});

test("G15 billing version migration adds optimistic concurrency column", async () => {
  const migration = await readMigration("020_billing_version.sql");

  expect(migration).toContain("ALTER TABLE accounts_v1.billing_accounts");
  expect(migration).toContain(
    "ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1",
  );
});

test("billing default payment method migration supports auto recharge", async () => {
  const migration = await readMigration(
    "028_billing_default_payment_method.sql",
  );

  expect(migration).toContain("ALTER TABLE accounts_v1.billing_accounts");
  expect(migration).toContain(
    "ADD COLUMN IF NOT EXISTS stripe_default_payment_method_id text",
  );
  expect(migration).toContain("automatic USD balance recharge");
});

test("auth_code_token_links sentinel migration replaces the NULL-in-PK columns", async () => {
  const migration = await readMigration(
    "021_auth_code_token_links_sentinel.sql",
  );

  // The NULL-permitting columns become NOT NULL with an empty-string sentinel
  // default, matching the D1 store and making the no-offline_access case
  // representable inside the PRIMARY KEY.
  expect(migration).toContain("ALTER COLUMN access_token_hash SET NOT NULL");
  expect(migration).toContain("ALTER COLUMN refresh_root_hash SET NOT NULL");
  expect(migration).toContain("ALTER COLUMN access_token_hash SET DEFAULT ''");
  expect(migration).toContain("ALTER COLUMN refresh_root_hash SET DEFAULT ''");
  // The sentinel-or-hash CHECK admits '' as the absent value.
  expect(migration).toContain(
    "CHECK (refresh_root_hash = '' OR refresh_root_hash LIKE 'sha256:%')",
  );
  expect(migration).toContain(
    "PRIMARY KEY (code_hash, access_token_hash, refresh_root_hash)",
  );
});

test("passkey challenge migration persists single-shot WebAuthn challenges", async () => {
  const migration = await readMigration("022_passkey_challenges.sql");

  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS accounts_v1.passkey_challenges",
  );
  expect(migration).toContain("challenge_key text PRIMARY KEY");
  expect(migration).toContain("expires_at timestamptz NOT NULL");
  expect(migration).toContain("passkey_challenges_expires_at_idx");
});
