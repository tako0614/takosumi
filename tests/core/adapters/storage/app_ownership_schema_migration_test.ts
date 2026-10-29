import { expect, test } from "bun:test";
import type { D1Database } from "../../../../worker/src/bindings.ts";
import { ensureD1OpenTofuLedgerSchema, verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../../worker/src/d1_opentofu_store.ts";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { PGliteSqlClient, splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const readOnlyD1 = (db: SqliteFakeD1): { db: D1Database; statements: string[] } => {
  const statements: string[] = [];
  return {
    db: {
      prepare(query) { statements.push(query); return db.prepare(query); },
      batch() { throw new Error("read-only boot attempted D1 batch"); },
    },
    statements,
  };
};

test("D1 v75/v76 boot remains read-only, and v77 expansion is atomic and verified", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
  for (const version of [75, 76]) {
    if (version === 76) await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 76 });
    const probe = readOnlyD1(db);
    await verifyD1OpenTofuLedgerSchemaPredeployed(probe.db);
    expect(probe.statements.every(query => /^(?:select|pragma|with)\b/iu.test(query.trim()))).toBe(true);
    expect(await db.prepare("select version from schema_migrations where version=77").first()).toBeNull();
  }
  const failing: D1Database = {
    prepare: query => db.prepare(query),
    async batch(statements) {
      return db.batch([...statements, db.prepare("insert into nonexistent_app_ownership_fixture values (1)")]);
    },
  };
  await expect(ensureD1OpenTofuLedgerSchema(failing)).rejects.toThrow();
  expect(await db.prepare("select version from schema_migrations where version=77").first()).toBeNull();
  expect(await db.prepare("select name from sqlite_master where name='capsule_members'").first()).toBeNull();
  await ensureD1OpenTofuLedgerSchema(db);
  expect(await db.prepare("select version,name from schema_migrations where version=77").first()).toEqual({ version: 77, name: "d1_app_ownership" });
  const probe = readOnlyD1(db);
  await verifyD1OpenTofuLedgerSchemaPredeployed(probe.db);
  expect(probe.statements.every(query => /^(?:select|pragma|with)\b/iu.test(query.trim()))).toBe(true);
  expect(await db.prepare("select name from sqlite_master where type='index' and tbl_name='capsules' and sql like '%owner_account_id%'").first()).toBeNull();
  await db.prepare("insert into capsule_members(capsule_id,account_id,status,created_at,updated_at) values('cap','member','active','now','now')").run();
  await expect(Promise.resolve().then(() => db.prepare("insert into capsule_members(capsule_id,account_id,status,created_at,updated_at) values('cap','other','invalid','now','now')").run())).rejects.toThrow();
  await expect(Promise.resolve().then(() => db.prepare("insert into capsule_members(capsule_id,account_id,status,created_at,updated_at) values('cap','member','active','now','now')").run())).rejects.toThrow();
  await db.exec("drop index capsule_members_account_status_idx");
  await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db)).rejects.toThrow("D1 OpenTofu predeployed schema verification failed");
});

test("Postgres v123 expands ownership atomically without replacing legacy rows", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(122);
  try {
    await client.query("insert into takosumi_workspaces(id,handle,space_json,created_at,updated_at) values('ws','ws','{}','now','now')");
    await client.query("insert into takosumi_projects(id,workspace_id,name,slug,project_json,created_at,updated_at) values('project','ws','Project','project','{}','now','now')");
    await client.query("insert into takosumi_capsules(id,space_id,project_id,name,environment,install_config_id,status,installation_json,created_at,updated_at) values('cap','ws','project','App','production','config','active','{}','now','now')");
    const before = (await client.query("select * from takosumi_capsules where id='cap'")).rows;
    const migration = postgresStorageMigrationStatements.find(entry => entry.version === 123)!;
    expect(migration.id).toBe("deploy.app_ownership.expand");
    const statements = splitSqlStatements(migration.sql);
    await expect(client.transaction(async transaction => {
      for (const statement of statements) await transaction.query(statement);
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect((await client.query("select to_regclass('takosumi_capsule_members') as table_name")).rows).toEqual([{ table_name: null }]);
    expect((await client.query("select * from takosumi_capsules where id='cap'")).rows).toEqual(before);
    await client.transaction(async transaction => { for (const statement of statements) await transaction.query(statement); });
    const capsule = (await client.query("select owner_account_id,slug,ownership_epoch,management_state,management_epoch,storage_root from takosumi_capsules where id='cap'")).rows[0];
    expect(capsule).toEqual({ owner_account_id: null, slug: null, ownership_epoch: 0, management_state: "active", management_epoch: 0, storage_root: null });
    expect((await client.query("select indexname from pg_indexes where tablename='takosumi_capsules' and indexdef like '%owner_account_id%'")).rows).toEqual([]);
    await client.query("insert into takosumi_capsule_members(capsule_id,account_id,status,created_at,updated_at) values('cap','member','active','now','now')");
    await expect(client.query("insert into takosumi_capsule_members(capsule_id,account_id,status,created_at,updated_at) values('cap','other','invalid','now','now')")).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("insert into takosumi_capsule_members(capsule_id,account_id,status,created_at,updated_at) values('cap','member','active','now','now')")).rejects.toMatchObject({ code: "23505" });
    expect((await client.query("select account_id from takosumi_capsule_members")).rows).toEqual([{ account_id: "member" }]);
  } finally { await client.close(); }
});
