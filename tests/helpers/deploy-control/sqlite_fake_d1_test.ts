import { expect, test } from "bun:test";

import { SqliteFakeD1 } from "./sqlite_fake_d1.ts";

test("SqliteFakeD1 enforces the 50-byte LIKE/GLOB limit by UTF-8 bytes", async () => {
  const db = new SqliteFakeD1();
  const atLimit = `${"あ".repeat(16)}ab`;

  expect(new TextEncoder().encode(atLimit).byteLength).toBe(50);
  expect(
    await db.prepare("SELECT 'x' LIKE ? AS matched").bind(atLimit).first(),
  ).toEqual({ matched: 0 });

  expect(() =>
    db.prepare("SELECT 'x' LIKE ? AS matched").bind("あ".repeat(17)).first(),
  ).toThrow("51 bytes exceeds the D1 cap of 50 bytes");
  expect(() =>
    db.prepare("SELECT 'x' GLOB ? AS matched").bind("x".repeat(51)).first(),
  ).toThrow("51 bytes exceeds the D1 cap of 50 bytes");
  expect(() =>
    db.prepare(`SELECT 'x' LIKE '${"x".repeat(51)}' AS matched`).first(),
  ).toThrow("51 bytes exceeds the D1 cap of 50 bytes");
  expect(() =>
    db
      .prepare("SELECT 'x' LIKE '%' || ? || '%' AS matched")
      .bind("x".repeat(49))
      .first(),
  ).toThrow("51 bytes exceeds the D1 cap of 50 bytes");
});

test("SqliteFakeD1 recognizes operators without treating quoted identifiers or unrelated binds as patterns", async () => {
  const db = new SqliteFakeD1();
  const row = await db
    .prepare(`SELECT ?1 AS "LIKE", ?2 AS [GLOB], 'x' LIKE ?3 AS matched`)
    .bind("x".repeat(500), "y".repeat(500), "x")
    .first<Record<string, unknown>>();

  expect(row).toEqual({
    LIKE: "x".repeat(500),
    GLOB: "y".repeat(500),
    matched: 1,
  });
});

test("SqliteFakeD1 rejects undefined instead of silently storing NULL", async () => {
  const db = new SqliteFakeD1();

  expect(() => db.prepare("SELECT ?").bind(undefined)).toThrow("D1_TYPE_ERROR");
  expect(
    await db.prepare("SELECT ? IS NULL AS is_null").bind(null).first(),
  ).toEqual({ is_null: 1 });
});

test("SqliteFakeD1 bind returns independent prepared statements", async () => {
  const db = new SqliteFakeD1();
  const statement = db.prepare("SELECT ? AS value");
  const first = statement.bind("first");
  const second = statement.bind("second");

  expect(await first.first()).toEqual({ value: "first" });
  expect(await second.first()).toEqual({ value: "second" });
  expect(await first.first()).toEqual({ value: "first" });
});

test("SqliteFakeD1 enables foreign keys and keeps batch writes atomic", async () => {
  const db = new SqliteFakeD1();
  await db.exec(`
    CREATE TABLE parents (id TEXT PRIMARY KEY);
    CREATE TABLE children (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES parents(id)
    );
    CREATE TABLE unique_rows (id TEXT PRIMARY KEY);
  `);

  expect(await db.prepare("PRAGMA foreign_keys").first()).toEqual({
    foreign_keys: 1,
  });
  expect(() =>
    db
      .prepare("INSERT INTO children (id, parent_id) VALUES (?, ?)")
      .bind("child_1", "missing")
      .run(),
  ).toThrow("FOREIGN KEY constraint failed");

  await expect(
    db.batch([
      db.prepare("INSERT INTO unique_rows (id) VALUES (?)").bind("row_1"),
      db.prepare("INSERT INTO unique_rows (id) VALUES (?)").bind("row_1"),
    ]),
  ).rejects.toThrow("UNIQUE constraint failed");
  expect(
    await db.prepare("SELECT count(*) AS count FROM unique_rows").first(),
  ).toEqual({ count: 0 });
});

test("SqliteFakeD1 rejects transaction control and disabling foreign keys", () => {
  const db = new SqliteFakeD1();

  expect(() => db.prepare("BEGIN IMMEDIATE").run()).toThrow(
    "explicit transaction control is not supported",
  );
  expect(() => db.exec("PRAGMA foreign_keys = OFF")).toThrow(
    "PRAGMA foreign_keys = OFF is not supported",
  );
});
