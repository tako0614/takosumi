import {
  StorageMigrationCatalogError,
  StorageMigrationChecksumMismatchError,
  type StorageMigrationLock,
  StorageMigrationRunner,
} from "./mod.ts";
import type { StorageMigrationStatement } from "../migrations.ts";
import type { SqlClient, SqlParameters, SqlQueryResult } from "../sql.ts";

const migrations: readonly StorageMigrationStatement[] = [
  {
    id: "system.001",
    version: 1,
    domain: "system",
    description: "first",
    sql: "create table if not exists one (id text primary key)",
  },
  {
    id: "core.002",
    version: 2,
    domain: "core",
    description: "second",
    sql: "create table if not exists two (id text primary key)",
  },
];

Deno.test("StorageMigrationRunner applies pending migrations in version order", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, { migrations });

  const result = await runner.applyPending();

  assertEquals(result.appliedNow.map((entry) => entry.migration.id), [
    "system.001",
    "core.002",
  ]);
  assertEquals((await runner.listAppliedMigrations()).map((row) => row.id), [
    "system.001",
    "core.002",
  ]);
  assertEquals(sql.statementsMatching("begin"), 2);
  assertEquals(sql.statementsMatching("commit"), 2);
  assert(sql.calls.some((call) => call.sql === migrations[0].sql));
  assert(sql.calls.some((call) => call.sql === migrations[1].sql));
});

Deno.test("StorageMigrationRunner dry-run reports pending without writes", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, { migrations });

  const result = await runner.applyPending({ dryRun: true });

  assertEquals(result.dryRun, true);
  assertEquals(result.pending.map((entry) => entry.migration.id), [
    "system.001",
    "core.002",
  ]);
  assertEquals(result.appliedNow, []);
  assert(!sql.calls.some((call) => call.sql === migrations[0].sql));
  assert(!sql.calls.some((call) => call.sql.startsWith("insert into")));
});

Deno.test("StorageMigrationRunner validates applied migration checksums", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, { migrations });
  await runner.applyPending();
  sql.corruptChecksum("system.001", "sha256:bad");

  await assertRejects(
    () => runner.plan(),
    StorageMigrationChecksumMismatchError,
    "system.001",
  );
});

Deno.test("StorageMigrationRunner fails closed on unknown applied migrations", async () => {
  const sql = new FakeSqlClient();
  sql.recordApplied({
    id: "unknown.999",
    version: 999,
    checksum: "sha256:unknown",
  });
  const runner = new StorageMigrationRunner(sql, { migrations });

  await assertRejects(
    () => runner.plan(),
    StorageMigrationCatalogError,
    "unknown.999",
  );
});

Deno.test("StorageMigrationRunner fails closed on applied version drift", async () => {
  const sql = new FakeSqlClient();
  sql.recordApplied({
    id: "system.001",
    version: 99,
    checksum: "sha256:old-version",
  });
  const runner = new StorageMigrationRunner(sql, { migrations });

  await assertRejects(
    () => runner.plan(),
    StorageMigrationCatalogError,
    "recorded version 99",
  );
});

Deno.test("StorageMigrationRunner checksums include down/forward-only state", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, { migrations });
  await runner.applyPending();

  const withDown: readonly StorageMigrationStatement[] = [
    { ...migrations[0], down: "drop table if exists one" },
    migrations[1],
  ];
  const changedRunner = new StorageMigrationRunner(sql, {
    migrations: withDown,
  });

  await assertRejects(
    () => changedRunner.plan(),
    StorageMigrationChecksumMismatchError,
    "system.001",
  );
});

Deno.test("StorageMigrationRunner uses one runner-wide lock while applying", async () => {
  const sql = new FakeSqlClient();
  const lock = new RecordingLock();
  const runner = new StorageMigrationRunner(sql, { migrations, lock });

  await runner.applyPending();

  assertEquals(lock.events, ["enter", "exit"]);
  assertEquals(sql.statementsMatching("begin"), 2);
  assertEquals(sql.statementsMatching("commit"), 2);
});

interface SqlCall {
  readonly sql: string;
  readonly parameters?: SqlParameters;
}

class FakeSqlClient implements SqlClient {
  readonly calls: SqlCall[] = [];
  readonly #applied = new Map<string, Record<string, unknown>>();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const normalized = normalizeSql(sql);
    this.calls.push({ sql: normalized, parameters });

    if (["begin", "commit", "rollback"].includes(normalized)) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("create table if not exists")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("alter table storage_migrations")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("select id, version, checksum, applied_at")) {
      const rows = [...this.#applied.values()].sort((left, right) =>
        Number(left.version) === Number(right.version)
          ? String(left.id).localeCompare(String(right.id))
          : Number(left.version) - Number(right.version)
      );
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (normalized.startsWith("insert into storage_migrations")) {
      const params = asRecord(parameters);
      this.#applied.set(String(params.id), {
        id: params.id,
        version: params.version,
        checksum: params.checksum,
        applied_at: "2026-04-27T00:00:00.000Z",
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("create table")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unhandled SQL: ${normalized}`);
  }

  corruptChecksum(id: string, checksum: string): void {
    const row = this.#applied.get(id);
    if (!row) throw new Error(`missing applied migration: ${id}`);
    this.#applied.set(id, { ...row, checksum });
  }

  recordApplied(row: Record<string, unknown>): void {
    this.#applied.set(String(row.id), {
      id: row.id,
      version: row.version,
      checksum: row.checksum,
      applied_at: row.applied_at ?? "2026-04-27T00:00:00.000Z",
    });
  }

  statementsMatching(sql: string): number {
    return this.calls.filter((call) => call.sql === sql).length;
  }
}

class RecordingLock implements StorageMigrationLock {
  readonly events: string[] = [];

  async runExclusive<T>(
    _client: SqlClient,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    this.events.push("enter");
    try {
      return await fn();
    } finally {
      this.events.push("exit");
    }
  }
}

function asRecord(
  value: SqlParameters | undefined,
): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return {};
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ");
}

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `assertEquals failed: ${JSON.stringify(actual)} !== ${
        JSON.stringify(expected)
      }`,
    );
  }
}

async function assertRejects(
  fn: () => Promise<unknown>,
  errorClass: new (...args: never[]) => Error,
  includes: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof errorClass)) {
      throw new Error(`expected ${errorClass.name}, got ${String(error)}`);
    }
    if (!error.message.includes(includes)) {
      throw new Error(`expected error message to include ${includes}`);
    }
    return;
  }
  throw new Error("expected function to reject");
}
