import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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


test("v78 adds authorization tables without changing writer A v77 checksum", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 77 });
  const original = await db.prepare("select checksum from schema_migrations where version=77").first();
  expect(original).toEqual({ checksum: "sha256:086155184f9fc95a1800c26e699f54ef2559f53182f6d81168c1fd42acb9d35d" });
  expect(await db.prepare("select name from sqlite_master where name='capsule_ownership_transfers'").first()).toBeNull();
  expect(await db.prepare("select name from sqlite_master where name='app_credential_mint_leases'").first()).toBeNull();
  await verifyD1OpenTofuLedgerSchemaPredeployed(db, 77);
  await ensureD1OpenTofuLedgerSchema(db);
  expect(await db.prepare("select checksum from schema_migrations where version=77").first()).toEqual(original);
  expect(await db.prepare("select name,checksum from schema_migrations where version=78").first()).toEqual({
    name: "d1_app_authorization", checksum: "sha256:434011ab063f22768f5e01b5be34f72d36c9cff594fd72878d9d4e35a2c6124b",
  });
  await verifyD1OpenTofuLedgerSchemaPredeployed(db, 78);
  await db.exec("drop index app_credential_mint_leases_capsule_expiry");
  await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db, 78)).rejects.toThrow();
});

test("Postgres v124 adds authorization tables after unchanged v123 ownership", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(123);
  try {
    expect((await client.query("select to_regclass('takosumi_capsule_ownership_transfers') as name")).rows).toEqual([{ name: null }]);
    const migration = postgresStorageMigrationStatements.find(entry => entry.version === 124)!;
    expect(createHash("sha256").update(migration.sql).digest("hex"))
      .toBe("6b22ceedd62b0aaea8c5875052aa47e192031f4a47a6899be2ab928afe7dcdda");
    await client.transaction(async transaction => {
      for (const statement of splitSqlStatements(migration.sql)) await transaction.query(statement);
    });
    expect((await client.query("select to_regclass('takosumi_capsule_ownership_transfers') as name")).rows).toEqual([{ name: "takosumi_capsule_ownership_transfers" }]);
    expect((await client.query("select to_regclass('takosumi_app_credential_mint_leases') as name")).rows).toEqual([{ name: "takosumi_app_credential_mint_leases" }]);
  } finally { await client.close(); }
});

const LIST_VISIBILITY_INDEXES = [
  ["usage_events", "usage_events_workspace_created_idx", ["workspace_id", "created_at", "id"]],
  ["backups", "backups_space_created_idx", ["space_id", "created_at", "id"]],
  ["capsules", "capsules_space_source_idx", ["space_id", "source_id"]],
  ["connections", "connections_owner_created_idx", ["owner_account_id", "created_at", "id"]],
  ["capsule_ownership_transfers", "capsule_ownership_transfers_capsule_state_epoch_idx", ["capsule_id", "state", "ownership_epoch"]],
] as const;

test("D1 v79 adds list visibility indexes atomically after unchanged v76-v78 and is verified read-only", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 78 });
  const earlier = (await db.prepare("select version,name,checksum from schema_migrations where version>=76 order by version").all()).results;
  expect(earlier.map((row) => (row as { checksum: string }).checksum).slice(1)).toEqual([
    "sha256:086155184f9fc95a1800c26e699f54ef2559f53182f6d81168c1fd42acb9d35d",
    "sha256:434011ab063f22768f5e01b5be34f72d36c9cff594fd72878d9d4e35a2c6124b",
  ]);
  await db.prepare(`insert into usage_events(id,workspace_id,kind,quantity,usd_micros,rating_status,source,idempotency_key,created_at)
    values('usage_retained','ws','runner_minute',1,0,'unrated','runner','usage_retained','2026-10-29T00:00:00.000Z')`).run();
  // A v78 target still boots read-only under the code that knows v79.
  const v78 = readOnlyD1(db);
  await verifyD1OpenTofuLedgerSchemaPredeployed(v78.db);
  expect(v78.statements.every(query => /^(?:select|pragma|with)\b/iu.test(query.trim()))).toBe(true);

  const failing: D1Database = {
    prepare: query => db.prepare(query),
    async batch(statements) {
      return db.batch([...statements, db.prepare("insert into nonexistent_list_index_fixture values (1)")]);
    },
  };
  await expect(ensureD1OpenTofuLedgerSchema(failing)).rejects.toThrow();
  expect(await db.prepare("select version from schema_migrations where version=79").first()).toBeNull();
  expect(await db.prepare("select name from sqlite_master where type='index' and name='usage_events_workspace_created_idx'").first()).toBeNull();

  await ensureD1OpenTofuLedgerSchema(db);
  expect((await db.prepare("select version,name,checksum from schema_migrations where version>=76 and version<79 order by version").all()).results).toEqual(earlier);
  expect(await db.prepare("select version,name from schema_migrations where version=79").first()).toEqual({ version: 79, name: "d1_app_list_visibility_indexes" });
  for (const [table, name, columns] of LIST_VISIBILITY_INDEXES) {
    const listed = (await db.prepare(`pragma index_list(${table})`).all<{ name: string; unique: number; partial: number }>()).results ?? [];
    expect(listed.filter((index) => index.name === name).map(({ unique, partial }) => ({ unique, partial })), name).toEqual([{ unique: 0, partial: 0 }]);
    const keyColumns = (await db.prepare(`pragma index_info(${name})`).all<{ name: string }>()).results?.map((row) => row.name);
    expect(keyColumns, name).toEqual([...columns]);
  }
  expect(await db.prepare("select id from usage_events").all()).toMatchObject({ results: [{ id: "usage_retained" }] });

  const v79 = readOnlyD1(db);
  await verifyD1OpenTofuLedgerSchemaPredeployed(v79.db);
  expect(v79.statements.every(query => /^(?:select|pragma|with)\b/iu.test(query.trim()))).toBe(true);
  const indexSql = new Map(((await db.prepare("select name,sql from sqlite_master where type='index'").all<{ name: string; sql: string }>()).results ?? [])
    .map((row) => [row.name, row.sql]));
  for (const [, name] of LIST_VISIBILITY_INDEXES) {
    const sql = indexSql.get(name)!;
    await db.exec(`drop index ${name}`);
    await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db), name).rejects.toThrow("D1 OpenTofu predeployed schema verification failed");
    await db.exec(sql);
    await verifyD1OpenTofuLedgerSchemaPredeployed(db);
  }
  // Last: bun:sqlite keeps an EXPLAIN statement open, which would lock DDL above.
  const plan = (await db.prepare(`explain query plan select id from usage_events
    where workspace_id = 'ws' order by created_at desc, id desc limit 10`).all<{ detail: string }>()).results ?? [];
  expect(plan.map((row) => row.detail).join("\n")).toContain("usage_events_workspace_created_idx");
});

test("Postgres v125 adds the same list visibility indexes after unchanged v124", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(124);
  try {
    const migration = postgresStorageMigrationStatements.find(entry => entry.version === 125)!;
    expect(migration.id).toBe("deploy.app_list_visibility.indexes");
    expect(createHash("sha256").update(postgresStorageMigrationStatements.find(entry => entry.version === 124)!.sql).digest("hex"))
      .toBe("6b22ceedd62b0aaea8c5875052aa47e192031f4a47a6899be2ab928afe7dcdda");
    const statements = splitSqlStatements(migration.sql);
    await expect(client.transaction(async transaction => {
      for (const statement of statements) await transaction.query(statement);
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect((await client.query("select to_regclass('takosumi_usage_events_workspace_created_idx') as name")).rows).toEqual([{ name: null }]);
    await client.transaction(async transaction => { for (const statement of statements) await transaction.query(statement); });
    for (const [table, name, columns] of LIST_VISIBILITY_INDEXES) {
      const pgName = name === "backups_space_created_idx" ? "takosumi_backups_space_created_id_idx" : `takosumi_${name}`;
      const rows = (await client.query(
        `select a.attname as column_name, i.indisunique as is_unique, i.indpred is not null as is_partial
           from pg_index i join pg_class c on c.oid = i.indexrelid
           join lateral unnest(i.indkey) with ordinality as k(attnum, position) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where c.relname = $1 and i.indrelid = $2::regclass order by k.position`,
        [pgName, `takosumi_${table}`],
      )).rows as { column_name: string; is_unique: boolean; is_partial: boolean }[];
      expect(rows.map((row) => row.column_name), pgName).toEqual([...columns]);
      expect(rows.every((row) => !row.is_unique && !row.is_partial), pgName).toBe(true);
    }
  } finally { await client.close(); }
});
