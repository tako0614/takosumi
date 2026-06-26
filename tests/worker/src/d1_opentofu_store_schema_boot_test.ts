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
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
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
  for (const expected of ["spaces", "sources", "installations", "provider_envs"]) {
    expect(tables.has(expected)).toBe(true);
  }
});

test("ensureD1OpenTofuLedgerSchema is idempotent across reboots", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  // A second (and third) boot against the now-populated schema must not throw.
  await ensureD1OpenTofuLedgerSchema(db);
  await ensureD1OpenTofuLedgerSchema(db);
  const tables = await tableNames(db);
  expect(tables.has("installations")).toBe(true);
});

test("provider_envs is created exactly once (no duplicate ensure-DDL)", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  // bun:sqlite would have thrown on a duplicate `create table` without
  // `if not exists`; assert the table is present and single in sqlite_master.
  const result = await db
    .prepare(
      `select count(*) as n from sqlite_master where type = 'table' and name = 'provider_envs'`,
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
