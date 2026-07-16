/**
 * Boot-convergence tests for the D1 OpenTofu ledger schema mechanism.
 *
 * Guards the P0 invariant that makes the 17-noun rename (P4) safe: guarded
 * table renames run BEFORE the final-name `create table if not exists`
 * ensure-DDL, and the same boot path converges on fresh, existing, and
 * already-renamed databases without bricking the control DB.
 */
import { expect, test } from "bun:test";

import {
  applyD1GuardedTableRenames,
  createCloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
  verifyD1OpenTofuLedgerSchemaPredeployed,
} from "../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import { acquireControlD1MaintenanceFence } from "../../../worker/src/d1_schema_maintenance.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

async function tableNames(db: SqliteFakeD1): Promise<Set<string>> {
  const result = await db
    .prepare(`select name from sqlite_master where type = 'table'`)
    .all<{ name: string }>();
  return new Set((result.results ?? []).map((row) => row.name));
}

test("ensureD1OpenTofuLedgerSchema converges on a fresh database", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const tables = await tableNames(db);
  for (const expected of [
    "workspaces",
    "projects",
    "sources",
    "capsules",
    "connections",
  ]) {
    expect(tables.has(expected)).toBe(true);
  }
});

test("retired provider_envs/provider_catalog tables are renamed aside, not live", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const tables = await tableNames(db);
  // The live Provider Catalog / Provider Env tables are retired (migration 16
  // renames them aside). The historical chain still materializes them on a fresh
  // DB, so the rename-aside leaves the `_retired` names present and recoverable.
  expect(tables.has("provider_envs")).toBe(false);
  expect(tables.has("provider_catalog")).toBe(false);
  expect(tables.has("provider_envs_retired")).toBe(true);
  expect(tables.has("provider_catalog_retired")).toBe(true);
});

test("ensureD1OpenTofuLedgerSchema is idempotent across reboots", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  // A second (and third) boot against the now-populated schema must not throw.
  await ensureD1OpenTofuLedgerSchema(db);
  await ensureD1OpenTofuLedgerSchema(db);
  const tables = await tableNames(db);
  expect(tables.has("capsules")).toBe(true);
});

test("predeployed verification is strictly read-only", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const queries: string[] = [];
  const readOnlyDb: D1Database = {
    prepare(query) {
      queries.push(query.trim());
      if (!/^(?:select|pragma)\b/iu.test(query.trim())) {
        throw new Error("predeployed verification attempted a write");
      }
      return db.prepare(query);
    },
    async batch() {
      throw new Error("predeployed verification attempted a batch");
    },
  };

  await verifyD1OpenTofuLedgerSchemaPredeployed(readOnlyDb);
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((query) => /^(?:select|pragma)\b/iu.test(query))).toBe(
    true,
  );
});

test("predeployed store fails closed without request-time bootstrap", async () => {
  const db = new SqliteFakeD1();
  const store = createCloudflareD1OpenTofuControlStore(db, {
    schemaMode: "predeployed",
  });

  await expect(store.listWorkspaces()).rejects.toThrow(
    "D1 OpenTofu predeployed schema verification failed",
  );
  expect((await tableNames(db)).has("workspaces")).toBe(false);
  expect((await tableNames(db)).has("schema_migrations")).toBe(false);
});

test("a warmed store observes a newly acquired maintenance fence", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const store = createCloudflareD1OpenTofuControlStore(db, {
    schemaMode: "predeployed",
  });
  expect(await store.listWorkspaces()).toEqual([]);

  await acquireControlD1MaintenanceFence(
    db,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "test",
    },
    "2026-07-16T00:00:00.000Z",
  );

  await expect(store.listWorkspaces()).rejects.toThrow(
    "maintenance_fence_active",
  );
});

test("predeployed verification rejects checksum drift", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await db
    .prepare(`update schema_migrations set checksum = ? where version = 43`)
    .bind(`sha256:${"0".repeat(64)}`)
    .run();

  await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db)).rejects.toThrow(
    "D1 OpenTofu predeployed schema verification failed",
  );
});

test("destructive usage migration and ledger insert roll back and retry atomically", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await db.prepare(`drop table usage_events`).run();
  await db
    .prepare(
      `create table usage_events (
        id text primary key,
        workspace_id text not null,
        capsule_id text,
        run_id text,
        meter_id text,
        resource_family text,
        resource_id text,
        operation text,
        resource_metadata_json text,
        kind text not null,
        quantity real not null,
        usd_micros integer not null,
        source text not null,
        idempotency_key text not null,
        created_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into usage_events (
         id, workspace_id, kind, quantity, usd_micros, source,
         idempotency_key, created_at
       ) values ('usage_retry', 'ws_retry', 'request', 1, 123, 'legacy',
                 'usage-retry', '2026-07-16T00:00:00.000Z')`,
    )
    .run();
  await db.prepare(`delete from schema_migrations where version = 39`).run();

  let injected = false;
  const failingDb: D1Database = {
    prepare(query) {
      return db.prepare(query);
    },
    async batch(statements) {
      if (!injected && statements.length > 2) {
        injected = true;
        return await db.batch([
          ...statements.slice(0, -1),
          db.prepare(`insert into table_that_does_not_exist values (1)`),
          statements.at(-1)!,
        ]);
      }
      return await db.batch(statements);
    },
  };

  await expect(ensureD1OpenTofuLedgerSchema(failingDb)).rejects.toThrow();
  expect(injected).toBe(true);
  expect(await d1ColumnNamesForTest(db, "usage_events")).not.toContain(
    "rating_status",
  );
  expect(
    await db
      .prepare(`select usd_micros from usage_events where id = 'usage_retry'`)
      .first(),
  ).toEqual({ usd_micros: 123 });
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 39`)
      .first(),
  ).toBeNull();

  await ensureD1OpenTofuLedgerSchema(db);
  expect(await d1ColumnNamesForTest(db, "usage_events")).toContain(
    "rating_status",
  );
  expect(
    await db
      .prepare(
        `select usd_micros, rating_status
         from usage_events where id = 'usage_retry'`,
      )
      .first(),
  ).toEqual({ usd_micros: 0, rating_status: "unrated" });
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 39`)
      .first(),
  ).toEqual({ version: 39 });
});

async function d1ColumnNamesForTest(
  db: SqliteFakeD1,
  table: string,
): Promise<readonly string[]> {
  const result = await db
    .prepare(`pragma table_info(${table})`)
    .all<{ readonly name: string }>();
  return (result.results ?? []).map((row) => row.name);
}

test("install config metadata converges to the canonical store key", async () => {
  const db = new SqliteFakeD1();
  await db
    .prepare(
      `create table install_configs (
        id text primary key,
        space_id text,
        install_type text not null,
        trust_level text not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    )
    .run();
  const retiredOnly = {
    id: "icfg_retired_only",
    name: "retired-only",
    catalog: { inputs: [{ name: "public_subdomain" }] },
  };
  const both = {
    id: "icfg_both",
    name: "both",
    catalog: { inputs: [{ name: "stale" }] },
    store: { inputs: [{ name: "current" }] },
  };
  for (const config of [retiredOnly, both]) {
    await db
      .prepare(
        `insert into install_configs
          (id, space_id, install_type, trust_level, record_json, created_at, updated_at)
         values (?, null, 'opentofu_module', 'trusted', ?, ?, ?)`,
      )
      .bind(
        config.id,
        JSON.stringify(config),
        "2026-07-10T00:00:00.000Z",
        "2026-07-10T00:00:00.000Z",
      )
      .run();
  }

  await ensureD1OpenTofuLedgerSchema(db);

  const rows = await db
    .prepare(`select id, record_json from install_configs order by id`)
    .all<{ id: string; record_json: string }>();
  const configs = new Map(
    (rows.results ?? []).map((row) => [row.id, JSON.parse(row.record_json)]),
  );
  expect(configs.get("icfg_retired_only")).toMatchObject({
    store: { inputs: [{ name: "public_subdomain" }] },
  });
  expect(configs.get("icfg_both")).toMatchObject({
    store: { inputs: [{ name: "current" }] },
  });
  expect(configs.get("icfg_retired_only")).not.toHaveProperty("catalog");
  expect(configs.get("icfg_both")).not.toHaveProperty("catalog");
});

test("connections is created exactly once (no duplicate ensure-DDL)", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  // bun:sqlite would have thrown on a duplicate `create table` without
  // `if not exists`; assert the table is present and single in sqlite_master.
  const result = await db
    .prepare(
      `select count(*) as n from sqlite_master where type = 'table' and name = 'connections'`,
    )
    .first<{ n: number }>();
  expect(result?.n).toBe(1);
});

test("applyD1GuardedTableRenames renames an existing table and preserves rows", async () => {
  const db = new SqliteFakeD1();
  await db.prepare(`create table old_demo (id text primary key, v text)`).run();
  await db.prepare(`insert into old_demo (id, v) values ('a', 'keep')`).run();

  await applyD1GuardedTableRenames(db, [{ from: "old_demo", to: "new_demo" }]);

  const tables = await tableNames(db);
  expect(tables.has("new_demo")).toBe(true);
  expect(tables.has("old_demo")).toBe(false);
  const row = await db
    .prepare(`select v from new_demo where id = 'a'`)
    .first<{ v: string }>();
  expect(row?.v).toBe("keep");
});

test("applyD1GuardedTableRenames is a no-op when the source is absent (fresh DB)", async () => {
  const db = new SqliteFakeD1();
  await applyD1GuardedTableRenames(db, [{ from: "old_demo", to: "new_demo" }]);
  const tables = await tableNames(db);
  expect(tables.has("new_demo")).toBe(false);
  expect(tables.has("old_demo")).toBe(false);
});

test("applyD1GuardedTableRenames is a no-op when the target already exists", async () => {
  const db = new SqliteFakeD1();
  await db.prepare(`create table new_demo (id text primary key, v text)`).run();
  await db.prepare(`insert into new_demo (id, v) values ('a', 'final')`).run();
  // A stale source left behind must NOT clobber the already-renamed target.
  await db.prepare(`create table old_demo (id text primary key, v text)`).run();
  await db.prepare(`insert into old_demo (id, v) values ('a', 'stale')`).run();

  await applyD1GuardedTableRenames(db, [{ from: "old_demo", to: "new_demo" }]);

  const row = await db
    .prepare(`select v from new_demo where id = 'a'`)
    .first<{ v: string }>();
  expect(row?.v).toBe("final");
});
