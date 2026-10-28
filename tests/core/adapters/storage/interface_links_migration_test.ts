import { expect, test } from "bun:test";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { createD1InterfaceStores, createSqlInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import type { InterfaceLink } from "takosumi-contract/interfaces";
import type { D1Database } from "../../../../worker/src/bindings.ts";
import { ensureD1OpenTofuLedgerSchema, verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient, splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const record: InterfaceLink = {
  id: "retained_link", generation: 1, consumerCapsuleId: "consumer", requirementKey: "storage",
  interface: { type: "storage", version: "1" }, requestedPermissions: ["read"], approvedPermissions: [],
  deliveryType: "oauth2", providerInterfaceId: "provider_interface", providerCapsuleId: "provider",
  state: "pending_approval", selection: "explicit", requestedBy: "requester", createdAt: "2026-10-28", updatedAt: "2026-10-28",
};

async function seedD1Sentinel(db: SqliteFakeD1): Promise<void> {
  await db.prepare("insert into interface_bindings(id,workspace_id,interface_id,subject_kind,subject_id,phase,generation,record_json,created_at,updated_at) values('sentinel','workspace','interface','Principal','subject','Ready',1,?,?,?)")
    .bind('{"retained":"exact old bytes"}', "2026-10-27", "2026-10-27").run();
}

test("D1 v76 expands consent atomically, preserves retained Binding bytes, and reopens without DDL", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
  await seedD1Sentinel(db);
  const before = await db.prepare("select * from interface_bindings").all();
  const priorUnique = await db.prepare("select sql from sqlite_master where name='interface_bindings_active_subject_unique'").first();
  const failing: D1Database = {
    prepare: (query) => db.prepare(query),
    async batch(statements) {
      // A failing tail runs inside the same SQLite transaction as the actual
      // migration and ledger insert, proving neither can partially commit.
      return await db.batch([...statements, db.prepare("insert into deliberately_missing_migration_fixture values (1)")]);
    },
  };
  await expect(ensureD1OpenTofuLedgerSchema(failing)).rejects.toThrow();
  expect(await db.prepare("select name from sqlite_master where name='interface_links'").first()).toBeNull();
  expect(await db.prepare("select version from schema_migrations where version=76").first()).toBeNull();
  expect(await db.prepare("select * from interface_bindings").all()).toEqual(before);
  await ensureD1OpenTofuLedgerSchema(db);
  expect(await db.prepare("select version,name from schema_migrations where version=76").first()).toEqual({ version: 76, name: "d1_interface_links" });
  expect(await db.prepare("select * from interface_bindings").all()).toEqual(before);
  expect(await db.prepare("select sql from sqlite_master where name='interface_bindings_active_subject_unique'").first()).toEqual(priorUnique);
  expect(await createD1InterfaceStores(db).links.create(record)).toBe(true);
  const statements: string[] = [];
  const reopened: D1Database = { prepare(query) { statements.push(query); return db.prepare(query); }, batch: db.batch.bind(db) };
  await verifyD1OpenTofuLedgerSchemaPredeployed(reopened);
  expect(await createD1InterfaceStores(reopened).links.get(record.id)).toEqual(record);
  expect(statements.every((query) => /^(?:select|pragma|with)\b/iu.test(query.trim()))).toBe(true);
  await db.prepare("insert into interface_links(id,generation,consumer_capsule_id,requirement_key,provider_interface_id,provider_capsule_id,state,record_json,created_at,updated_at) values('terminal',2,'consumer','storage','provider_interface','provider','revoked','{}','','')").run();
  await expect(Promise.resolve().then(() => db.prepare("insert into interface_links(id,generation,consumer_capsule_id,requirement_key,provider_interface_id,provider_capsule_id,state,record_json,created_at,updated_at) values('duplicate',3,'consumer','storage','provider_interface','provider','active','{}','','')").run())).rejects.toThrow(/unique constraint/iu);
});

test("Postgres v122 expansion rolls back and preserves rows, indexes and retained link restart readback", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(121);
  try {
    await client.query("insert into takosumi_interface_bindings(id,workspace_id,interface_id,subject_kind,subject_id,phase,generation,record_json,created_at,updated_at) values('sentinel','workspace','interface','Principal','subject','Ready',1,$1::jsonb,'2026-10-27','2026-10-27')", ['{"retained":"exact old document"}']);
    const before = await client.query("select * from takosumi_interface_bindings");
    const priorUnique = await client.query("select indexdef from pg_indexes where indexname='takosumi_interface_bindings_active_subject_unique'");
    const migration = postgresStorageMigrationStatements.find((entry) => entry.version === 122)!;
    expect(migration.id).toBe("runtime_interfaces.links.create");
    const statements = splitSqlStatements(migration.sql);
    await expect(client.transaction(async (transaction) => {
      for (const statement of statements) await transaction.query(statement);
      throw new Error("fixture migration rollback");
    })).rejects.toThrow("fixture migration rollback");
    expect((await client.query("select to_regclass('takosumi_interface_links') as table_name")).rows).toEqual([{ table_name: null }]);
    expect((await client.query("select * from takosumi_interface_bindings")).rows).toEqual(before.rows);
    await client.transaction(async (transaction) => { for (const statement of statements) await transaction.query(statement); });
    expect((await client.query("select * from takosumi_interface_bindings")).rows).toEqual(before.rows);
    expect((await client.query("select indexdef from pg_indexes where indexname='takosumi_interface_bindings_active_subject_unique'")).rows).toEqual(priorUnique.rows);
    expect(await createSqlInterfaceStores(client).links.create(record)).toBe(true);
    await client.query("insert into takosumi_interface_links(id,generation,consumer_capsule_id,requirement_key,provider_interface_id,provider_capsule_id,state,record_json,created_at,updated_at) values('terminal',2,'consumer','storage','provider_interface','provider','revoked','{}','','')");
    await expect(client.query("insert into takosumi_interface_links(id,generation,consumer_capsule_id,requirement_key,provider_interface_id,provider_capsule_id,state,record_json,created_at,updated_at) values('duplicate',3,'consumer','storage','provider_interface','provider','active','{}','','')")).rejects.toMatchObject({ code: "23505" });
    const snapshot = await client.snapshotDataDir();
    const reopened = await PGliteSqlClient.fromDataDirSnapshot(snapshot);
    try { expect(await createSqlInterfaceStores(reopened).links.get(record.id)).toEqual(record); }
    finally { await reopened.close(); }
  } finally { await client.close(); }
});

test("D1 v76 readiness rejects a weakened current-link predicate and missing reverse lookup indexes", async () => {
  for (const statement of [
    "drop index interface_links_provider_capsule_idx",
    "drop index interface_links_provider_interface_idx",
    "drop index interface_links_consumer_lineage_idx",
    "drop index interface_links_current_consumer_requirement_unique; create unique index interface_links_current_consumer_requirement_unique on interface_links(consumer_capsule_id,requirement_key) where state='active'",
  ]) {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    await db.exec(statement);
    await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db)).rejects.toThrow("D1 OpenTofu predeployed schema verification failed");
  }
});
