// Phase 18.2 (H13): tests for the down-migration / rollback path.
//
// These tests focus on the runner's rollback semantics. They use a fake
// SqlClient that records every SQL statement so we can assert that:
//   - `down` clauses run in the correct (reverse) order
//   - the storage_migrations ledger row is removed exactly once per rollback
//   - forward-only migrations refuse to rollback with a typed error
//   - --target / --steps / dry-run all behave per spec

import {
  StorageMigrationDownNotSupportedError,
  type StorageMigrationLock,
  StorageMigrationRunner,
} from "./mod.ts";
import { postgresStorageMigrationStatements } from "../migrations.ts";
import type { StorageMigrationStatement } from "../migrations.ts";
import type { SqlClient, SqlParameters, SqlQueryResult } from "../sql.ts";

const reversibleMigrations: readonly StorageMigrationStatement[] = [
  {
    id: "system.001",
    version: 1,
    domain: "system",
    description: "first",
    sql: "create table if not exists one (id text primary key)",
    down: "drop table if exists one",
  },
  {
    id: "core.002",
    version: 2,
    domain: "core",
    description: "second",
    sql: "create table if not exists two (id text primary key)",
    down: "drop table if exists two",
  },
  {
    id: "deploy.003",
    version: 3,
    domain: "deploy",
    description: "third",
    sql: "create table if not exists three (id text primary key)",
    down: "drop table if exists three",
  },
];

Deno.test("rollback default rolls back the single most recent migration", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, {
    migrations: reversibleMigrations,
  });
  await runner.applyPending();

  const result = await runner.rollback();

  assertEquals(result.rolledBackNow.map((entry) => entry.migration.id), [
    "deploy.003",
  ]);
  // Ledger should now retain the first two but not the third.
  const remaining = await runner.listAppliedMigrations();
  assertEquals(remaining.map((row) => row.id), ["system.001", "core.002"]);
  // The down SQL must have actually been executed against the client.
  assert(
    sql.calls.some((call) => call.sql === "drop table if exists three"),
    "down SQL for deploy.003 was not executed",
  );
  // The delete-from-ledger statement must have been executed.
  assert(
    sql.calls.some((call) =>
      call.sql.startsWith("delete from storage_migrations") &&
      typeof call.parameters === "object" && call.parameters !== null &&
      !Array.isArray(call.parameters) &&
      (call.parameters as Record<string, unknown>).id === "deploy.003"
    ),
    "ledger row for deploy.003 was not removed",
  );
});

Deno.test("rollback with --steps=2 rolls back two migrations in reverse order", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, {
    migrations: reversibleMigrations,
  });
  await runner.applyPending();

  const result = await runner.rollback({ steps: 2 });

  assertEquals(result.rolledBackNow.map((entry) => entry.migration.id), [
    "deploy.003",
    "core.002",
  ]);
  const remaining = await runner.listAppliedMigrations();
  assertEquals(remaining.map((row) => row.id), ["system.001"]);
});

Deno.test("rollback with --target=1 rolls back every migration whose version > 1", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, {
    migrations: reversibleMigrations,
  });
  await runner.applyPending();

  const result = await runner.rollback({ targetVersion: 1 });

  assertEquals(result.rolledBackNow.map((entry) => entry.migration.version), [
    3,
    2,
  ]);
  const remaining = await runner.listAppliedMigrations();
  assertEquals(remaining.map((row) => row.id), ["system.001"]);
});

Deno.test("rollback dry-run reports plan but does not execute", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, {
    migrations: reversibleMigrations,
  });
  await runner.applyPending();
  const baselineCallCount = sql.calls.length;

  const result = await runner.rollback({ steps: 2, dryRun: true });

  assertEquals(result.dryRun, true);
  assertEquals(result.rolledBackNow.length, 0);
  assertEquals(result.planned.map((entry) => entry.migration.id), [
    "deploy.003",
    "core.002",
  ]);
  // No additional writes other than the read of applied migrations.
  const post = sql.calls.slice(baselineCallCount);
  assert(
    !post.some((call) => call.sql === "drop table if exists three"),
    "dry-run must not run any down SQL",
  );
  assert(
    !post.some((call) => call.sql.startsWith("delete from storage_migrations")),
    "dry-run must not modify the ledger",
  );
});

Deno.test("rollback refuses to undo a forward-only migration", async () => {
  const forwardOnly: readonly StorageMigrationStatement[] = [
    reversibleMigrations[0],
    reversibleMigrations[1],
    {
      id: "deploy.003-forward-only",
      version: 3,
      domain: "deploy",
      description: "no down",
      sql: "create table if not exists three (id text primary key)",
      // No `down` -> must refuse rollback.
    },
  ];
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, { migrations: forwardOnly });
  await runner.applyPending();

  await assertRejects(
    () => runner.rollback({ steps: 1 }),
    StorageMigrationDownNotSupportedError,
    "deploy.003-forward-only",
  );
  // Ledger must remain untouched after the refusal.
  const remaining = await runner.listAppliedMigrations();
  assertEquals(remaining.length, 3);
});

Deno.test("rollback refuses to cross deployment unification in the current catalog", async () => {
  const migration = postgresStorageMigrationStatements.find((entry) =>
    entry.id === "deploy.unify_to_deployments"
  );
  assert(migration, "deploy.unify_to_deployments missing from catalog");
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, {
    migrations: postgresStorageMigrationStatements.filter((entry) =>
      entry.version <= migration.version
    ),
  });
  await runner.applyPending();

  await assertRejects(
    () => runner.rollback({ targetVersion: migration.version - 1 }),
    StorageMigrationDownNotSupportedError,
    "deploy.unify_to_deployments",
  );
});

Deno.test("rollback against an empty ledger returns an empty plan", async () => {
  const sql = new FakeSqlClient();
  const runner = new StorageMigrationRunner(sql, {
    migrations: reversibleMigrations,
  });

  const result = await runner.rollback({ steps: 5 });

  assertEquals(result.rolledBackNow.length, 0);
  assertEquals(result.planned.length, 0);
});

Deno.test("rollback uses one runner-wide lock while executing", async () => {
  const sql = new FakeSqlClient();
  const lock = new RecordingLock();
  const runner = new StorageMigrationRunner(sql, {
    migrations: reversibleMigrations,
    lock,
  });
  await runner.applyPending();
  lock.events.length = 0;

  await runner.rollback({ steps: 2 });

  assertEquals(lock.events, ["enter", "exit"]);
});

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

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
        applied_at: "2026-04-30T00:00:00.000Z",
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("delete from storage_migrations where id")) {
      const params = asRecord(parameters);
      const removed = this.#applied.delete(String(params.id)) ? 1 : 0;
      return { rows: [], rowCount: removed };
    }
    if (
      normalized.startsWith("drop table if exists") ||
      normalized.startsWith("alter table") ||
      normalized.startsWith("drop index if exists") ||
      normalized.startsWith("create index if not exists")
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unhandled SQL: ${normalized}`);
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
      throw new Error(
        `expected error message to include ${includes}, got: ${error.message}`,
      );
    }
    return;
  }
  throw new Error("expected function to reject");
}
