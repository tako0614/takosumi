import { test } from "bun:test";
import {
  canonicalStorageMigrationChecksum,
  legacyStorageMigrationChecksum,
  StorageMigrationCatalogError,
  StorageMigrationChecksumMismatchError,
  StorageMigrationPendingError,
  type StorageMigrationLock,
  StorageMigrationRunner,
} from "../../../../../core/adapters/storage/migration-runner/mod.ts";
import {
  postgresStorageMigrationStatements,
  type StorageMigrationStatement,
} from "../../../../../core/adapters/storage/migrations.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../../../../core/adapters/storage/sql.ts";

const migrations: readonly StorageMigrationStatement[] = [
  {
    id: "system.001",
    version: 1,
    domain: "system",
    description: "first",
    sql: "create table if not exists one (id text primary key)",
  },
  {
    id: "space.002",
    version: 2,
    domain: "space",
    description: "second",
    sql: "create table if not exists two (id text primary key)",
  },
];

test("StorageMigrationRunner applies pending migrations in version order", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, { migrations });

  const result = await runner.applyPending();

  assertEquals(
    result.appliedNow.map((entry) => entry.migration.id),
    ["system.001", "space.002"],
  );
  assertEquals(
    (await runner.listAppliedMigrations()).map((row) => row.id),
    ["system.001", "space.002"],
  );
  assertEquals(sql.statementsMatching("begin"), 2);
  assertEquals(sql.statementsMatching("commit"), 2);
  assert(sql.calls.some((call) => call.sql === migrations[0].sql));
  assert(sql.calls.some((call) => call.sql === migrations[1].sql));
});

test("StorageMigrationRunner dry-run reports pending without writes", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, { migrations });

  const result = await runner.applyPending({ dryRun: true });

  assertEquals(result.dryRun, true);
  assertEquals(
    result.pending.map((entry) => entry.migration.id),
    ["system.001", "space.002"],
  );
  assertEquals(result.appliedNow, []);
  assert(!sql.calls.some((call) => call.sql === migrations[0].sql));
  assert(!sql.calls.some((call) => call.sql.startsWith("insert into")));
});

test("StorageMigrationRunner verifies a current schema without mutating its ledger", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, { migrations });
  await runner.applyPending();
  const callCountBeforeVerify = sql.calls.length;

  const result = await runner.verifyCurrent();

  assertEquals(result.pending, []);
  assertEquals(
    sql.calls.slice(callCountBeforeVerify).map((call) => call.sql),
    [
      "select id, version, checksum, applied_at from storage_migrations order by version asc, id asc",
    ],
  );
});

test("StorageMigrationRunner verification fails closed on pending migrations", async () => {
  const sql = new FakeSqlClient();
  await new StorageMigrationRunner(sql, {
    migrations: [migrations[0]],
  }).applyPending();

  await assertRejects(
    () => new StorageMigrationRunner(sql, { migrations }).verifyCurrent(),
    StorageMigrationPendingError,
    "space.002",
  );
  assert(!sql.calls.some((call) => call.sql === migrations[1].sql));
});

test("StorageMigrationRunner validates applied migration checksums", async () => {
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

test("StorageMigrationRunner fails closed on unknown applied migrations", async () => {
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

test("StorageMigrationRunner fails closed on applied version drift", async () => {
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

test("StorageMigrationRunner checksums ignore editorial migration fields", async () => {
  const sql = new FakeSqlClient();
  await new StorageMigrationRunner(sql, { migrations }).applyPending();

  // None of these reach a protected database, so none may invalidate a
  // ledger row that already recorded a successful apply.
  const edited: readonly StorageMigrationStatement[] = [
    {
      ...migrations[0],
      description: "first, restated for the runbook",
      domain: "core",
      down: "drop table if exists one",
      sql: `-- explain why this table exists\n${migrations[0].sql}\n`,
    },
    migrations[1],
  ];

  const plan = await new StorageMigrationRunner(sql, { migrations: edited })
    .verifyCurrent();
  assertEquals(plan.pending.length, 0);
  assertEquals(plan.legacyChecksumIds, []);
});

test("StorageMigrationRunner checksums still reject executable SQL drift", async () => {
  const sql = new FakeSqlClient();
  await new StorageMigrationRunner(sql, { migrations }).applyPending();

  const rewritten: readonly StorageMigrationStatement[] = [
    {
      ...migrations[0],
      sql: "create table if not exists one (id text primary key, extra text)",
    },
    migrations[1],
  ];

  await assertRejects(
    () =>
      new StorageMigrationRunner(sql, { migrations: rewritten }).plan(),
    StorageMigrationChecksumMismatchError,
    "system.001",
  );
});

test("StorageMigrationRunner accepts and reconciles a pre-canonical ledger", async () => {
  const sql = new FakeSqlClient();
  for (const migration of migrations) {
    sql.recordApplied({
      id: migration.id,
      version: migration.version,
      checksum: await legacyStorageMigrationChecksum(migration),
    });
  }

  const stale = await new StorageMigrationRunner(sql, { migrations })
    .verifyCurrent();
  assertEquals(stale.legacyChecksumIds, ["system.001", "space.002"]);

  const applied = await new StorageMigrationRunner(sql, { migrations })
    .applyPending();
  assertEquals(applied.reconciledChecksumIds, ["system.001", "space.002"]);
  assertEquals(applied.appliedNow.length, 0);

  const reconciled = await new StorageMigrationRunner(sql, { migrations })
    .verifyCurrent();
  assertEquals(reconciled.legacyChecksumIds, []);
  assertEquals(
    reconciled.applied.map((row) => row.checksum),
    await Promise.all(
      migrations.map((migration) =>
        canonicalStorageMigrationChecksum(migration)
      ),
    ),
  );
});

test("StorageMigrationRunner keeps a declared retirement bootable", async () => {
  const sql = new FakeSqlClient();
  await new StorageMigrationRunner(sql, { migrations }).applyPending();

  const retired = [
    { id: "space.002", version: 2, reason: "superseded by a later shape" },
  ];
  const plan = await new StorageMigrationRunner(sql, {
    migrations: [migrations[0]],
    retired,
  }).verifyCurrent();
  assertEquals(plan.pending.length, 0);
  assertEquals(plan.applied.length, 2);
});

test("StorageMigrationRunner burns a retired id and version forever", async () => {
  const sql = new FakeSqlClient();
  const retired = [
    { id: "space.002", version: 2, reason: "superseded by a later shape" },
  ];

  assertThrows(
    () =>
      new StorageMigrationRunner(sql, { migrations, retired }),
    StorageMigrationCatalogError,
    "must never be reused",
  );

  assertThrows(
    () =>
      new StorageMigrationRunner(sql, {
        migrations: [
          migrations[0],
          { ...migrations[1], id: "space.002.rewritten" },
        ],
        retired,
      }),
    StorageMigrationCatalogError,
    "retired migration space.002",
  );
});

test("released Postgres migrations keep their canonical checksum", async () => {
  const fixture = (await Bun.file(
    new URL("./fixtures/valid-applied-catalog-v61.json", import.meta.url),
  ).json()) as AppliedCatalogFixture;
  const sql = new FakeSqlClient();
  const plan = await new StorageMigrationRunner(sql, {
    migrations: postgresStorageMigrationStatements,
  }).plan();
  const current = new Map(
    plan.pending.map((entry) => [
      entry.migration.id,
      { version: entry.migration.version, checksum: entry.checksum },
    ]),
  );

  assertEquals(fixture.schemaVersion, 2);
  assertEquals(
    postgresStorageMigrationStatements
      .filter((migration) => migration.version <= 61)
      .map((migration) => migration.id),
    fixture.migrations.map((migration) => migration.id),
  );
  // The canonical digest covers the executable SQL, so this pin fails on an
  // edit to released SQL and stays quiet for description / `down` / comment
  // changes.
  for (const applied of fixture.migrations) {
    assertEquals(current.get(applied.id), {
      version: applied.version,
      checksum: applied.checksum,
    });
  }
});

test("ledgers written by the pre-canonical runner still verify", async () => {
  const fixture = (await Bun.file(
    new URL("./fixtures/valid-applied-catalog-v61.json", import.meta.url),
  ).json()) as AppliedCatalogFixture;
  const sql = new FakeSqlClient();
  for (const applied of fixture.migrations) {
    sql.recordApplied({
      id: applied.id,
      version: applied.version,
      checksum: applied.legacyChecksum,
    });
  }

  const plan = await new StorageMigrationRunner(sql, {
    migrations: postgresStorageMigrationStatements,
  }).plan();

  assertEquals(
    plan.legacyChecksumIds,
    fixture.migrations.map((migration) => migration.id),
  );
  assertEquals(
    plan.pending.length,
    postgresStorageMigrationStatements.length - fixture.migrations.length,
  );
});

test("StorageMigrationRunner uses one runner-wide lock while applying", async () => {
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

interface AppliedCatalogFixture {
  readonly schemaVersion: number;
  readonly migrations: readonly {
    readonly id: string;
    readonly version: number;
    readonly checksum: string;
    readonly legacyChecksum: string;
  }[];
}

class FakeSqlClient implements SqlClient {
  readonly calls: SqlCall[] = [];
  readonly #applied = new Map<string, Record<string, unknown>>();

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    try {
      return Promise.resolve(this.#query<Row>(sql, parameters));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // Single-connection fake: issue real begin / commit / rollback through the
  // query path (so the runner's accounting of begin/commit holds) and run the
  // body against this same client (serial, so there is no isolation to fake).
  async transaction<T>(
    fn: (transaction: SqlClient) => T | Promise<T>,
  ): Promise<T> {
    await this.query("begin");
    try {
      const value = await fn(this);
      await this.query("commit");
      return value;
    } catch (error) {
      await this.query("rollback");
      throw error;
    }
  }

  #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): SqlQueryResult<Row> {
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
          : Number(left.version) - Number(right.version),
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
    if (normalized.startsWith("update storage_migrations set checksum")) {
      const params = asRecord(parameters);
      const row = this.#applied.get(String(params.id));
      if (!row || row.checksum !== params.legacy) {
        return { rows: [], rowCount: 0 };
      }
      this.#applied.set(String(params.id), {
        ...row,
        checksum: params.checksum,
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
      `assertEquals failed: ${JSON.stringify(actual)} !== ${JSON.stringify(
        expected,
      )}`,
    );
  }
}

function assertThrows(
  fn: () => unknown,
  errorClass: new (...args: never[]) => Error,
  includes: string,
): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof errorClass)) {
      throw new Error(`expected ${errorClass.name}, got ${String(error)}`);
    }
    if (!error.message.includes(includes)) {
      throw new Error(`expected error message to include ${includes}`);
    }
    return;
  }
  throw new Error("expected function to throw");
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
