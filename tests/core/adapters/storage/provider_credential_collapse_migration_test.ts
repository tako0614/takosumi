/**
 * Round-trip test for the provider-credential collapse migration
 * (`deploy.provider_credential_collapse.rename_aside`, version 56).
 *
 * Seeds a legacy connections + provider_envs + provider_catalog snapshot, runs
 * the forward migration, and asserts:
 *   - the unified Connection row carries the materialization + providerSource
 *     folded from the id-equal provider_envs row (and git connections get the
 *     `secret` default);
 *   - the live Provider Catalog / Provider Env tables are renamed aside to
 *     `*_retired` (non-destructive: their rows survive);
 *   - `down` restores the original table names.
 */
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const MIGRATION_ID = "deploy.provider_credential_collapse.rename_aside";

async function seedLegacy(db: PGlite): Promise<void> {
  await db.exec(`create table takosumi_connections (
    id text primary key,
    space_id text,
    provider text not null,
    status text not null,
    connection_json jsonb not null,
    created_at text not null,
    updated_at text not null
  )`);
  await db.exec(`create table takosumi_provider_envs (
    id text primary key,
    space_id text,
    provider_source text not null,
    materialization text not null,
    status text not null,
    env_json jsonb not null,
    created_at text not null,
    updated_at text not null
  )`);
  await db.exec(`create table takosumi_provider_catalog (
    id text primary key,
    provider_source text not null,
    primary_materialization text not null,
    gateway_eligible integer not null,
    entry_json jsonb not null,
    created_at text not null,
    updated_at text not null
  )`);
  // A provider connection with a matching provider_envs row (oauth) ...
  await db.exec(
    `insert into takosumi_connections (id, space_id, provider, status, connection_json, created_at, updated_at)
     values (
       'conn_cf', 'space_1', 'cloudflare', 'verified',
       '{"id":"conn_cf","spaceId":"space_1","provider":"cloudflare","kind":"generic_env_provider","scope":"space","status":"verified","envNames":["CLOUDFLARE_API_TOKEN"],"createdAt":"2026-06-01T00:00:00.000Z","updatedAt":"2026-06-01T00:00:00.000Z"}',
       '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
     )`,
  );
  // ... and a git source connection with NO provider_envs row (defaults secret).
  await db.exec(
    `insert into takosumi_connections (id, space_id, provider, status, connection_json, created_at, updated_at)
     values (
       'conn_git', 'space_1', 'source_git_https_token', 'verified',
       '{"id":"conn_git","spaceId":"space_1","provider":"source_git_https_token","kind":"source_git_https_token","scope":"space","status":"verified","envNames":["GIT_HTTPS_TOKEN"],"createdAt":"2026-06-01T00:00:00.000Z","updatedAt":"2026-06-01T00:00:00.000Z"}',
       '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
     )`,
  );
  // ... and an OPERATOR-scoped Google-OAuth connection (no space_id) which
  // historically never got a provider_envs row; its OAuth credentialDriver must
  // still backfill materialization='oauth' so the fail-closed mint guard stays
  // armed (a 'secret' default would un-reserve it and inject a raw token).
  await db.exec(
    `insert into takosumi_connections (id, space_id, provider, status, connection_json, created_at, updated_at)
     values (
       'conn_gcp_op', null, 'generic_env_provider', 'verified',
       '{"id":"conn_gcp_op","provider":"generic_env_provider","kind":"generic_env_provider","credentialDriver":"gcp_oauth_bootstrap","scope":"operator","status":"verified","envNames":["GOOGLE_OAUTH_ACCESS_TOKEN"],"createdAt":"2026-06-01T00:00:00.000Z","updatedAt":"2026-06-01T00:00:00.000Z"}',
       '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
     )`,
  );
  await db.exec(
    `insert into takosumi_provider_envs (id, space_id, provider_source, materialization, status, env_json, created_at, updated_at)
     values (
       'conn_cf', 'space_1', 'registry.opentofu.org/cloudflare/cloudflare', 'oauth', 'ready',
       '{"id":"conn_cf"}', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
     )`,
  );
  await db.exec(
    `insert into takosumi_provider_catalog (id, provider_source, primary_materialization, gateway_eligible, entry_json, created_at, updated_at)
     values (
       'cloudflare', 'registry.opentofu.org/cloudflare/cloudflare', 'secret', 0,
       '{"id":"cloudflare"}', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
     )`,
  );
}

async function tableExists(db: PGlite, name: string): Promise<boolean> {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables where table_name = $1`,
    [name],
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

test("provider-credential collapse migration folds materialization onto connections and retires the tables", async () => {
  const migration = postgresStorageMigrationStatements.find(
    (entry) => entry.id === MIGRATION_ID,
  );
  expect(migration).toBeDefined();
  expect(migration!.down).toBeDefined();

  const db = new PGlite();
  try {
    await seedLegacy(db);

    for (const statement of splitSqlStatements(migration!.sql)) {
      await db.exec(statement);
    }

    // The oauth provider connection gets materialization + providerSource folded
    // from its id-equal provider_envs row.
    const cf = await db.query<{
      materialization: string;
      provider_source: string;
    }>(
      `select connection_json->>'materialization' as materialization,
              connection_json->>'providerSource' as provider_source
       from takosumi_connections where id = 'conn_cf'`,
    );
    expect(cf.rows[0]?.materialization).toBe("oauth");
    expect(cf.rows[0]?.provider_source).toBe(
      "registry.opentofu.org/cloudflare/cloudflare",
    );

    // The git connection (no provider_envs row) defaults to secret +
    // providerSource = provider.
    const git = await db.query<{
      materialization: string;
      provider_source: string;
    }>(
      `select connection_json->>'materialization' as materialization,
              connection_json->>'providerSource' as provider_source
       from takosumi_connections where id = 'conn_git'`,
    );
    expect(git.rows[0]?.materialization).toBe("secret");
    expect(git.rows[0]?.provider_source).toBe("source_git_https_token");

    // REGRESSION GUARD: the operator-scoped Google-OAuth connection has no
    // provider_envs row, but its OAuth credentialDriver must yield
    // materialization='oauth' (NOT the 'secret' default) so isReservedGcpConnection
    // keeps the fail-closed mint guard armed.
    const gcpOp = await db.query<{ materialization: string }>(
      `select connection_json->>'materialization' as materialization
       from takosumi_connections where id = 'conn_gcp_op'`,
    );
    expect(gcpOp.rows[0]?.materialization).toBe("oauth");

    // The live tables are renamed aside; the rows survive in the retired tables.
    expect(await tableExists(db, "takosumi_provider_envs")).toBe(false);
    expect(await tableExists(db, "takosumi_provider_catalog")).toBe(false);
    expect(await tableExists(db, "takosumi_provider_envs_retired")).toBe(true);
    expect(await tableExists(db, "takosumi_provider_catalog_retired")).toBe(true);
    const retiredEnv = await db.query<{ n: number }>(
      `select count(*)::int as n from takosumi_provider_envs_retired`,
    );
    expect(retiredEnv.rows[0]?.n).toBe(1);
    const retiredCatalog = await db.query<{ n: number }>(
      `select count(*)::int as n from takosumi_provider_catalog_retired`,
    );
    expect(retiredCatalog.rows[0]?.n).toBe(1);

    // `down` restores the original table names.
    for (const statement of splitSqlStatements(migration!.down!)) {
      await db.exec(statement);
    }
    expect(await tableExists(db, "takosumi_provider_envs")).toBe(true);
    expect(await tableExists(db, "takosumi_provider_catalog")).toBe(true);
    expect(await tableExists(db, "takosumi_provider_envs_retired")).toBe(false);
    expect(await tableExists(db, "takosumi_provider_catalog_retired")).toBe(
      false,
    );
  } finally {
    await db.close();
  }
});
