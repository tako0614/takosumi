/**
 * Cost and atomicity guards for the control D1 ledger bootstrap.
 *
 * The bootstrap used to issue roughly 1243 sequential `prepare().run()`
 * statements, so the first request that reached the deploy-control seam paid
 * one D1 round trip per statement — billed and rate limited individually on
 * real D1. These tests pin the shape of the fix rather than a wall-clock
 * number: schema DDL travels in `db.batch()` groups, a converged database
 * issues nothing at all, and a migration's ledger row cannot outlive a batch
 * that failed.
 */
import { expect, test } from "bun:test";

import {
  D1_MAX_STATEMENT_BYTES,
  D1_SCHEMA_BATCH_MAX_STATEMENTS,
  ensureD1OpenTofuLedgerSchema,
  groupD1SchemaStatements,
} from "../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

interface D1Traffic {
  /** Statements issued one per round trip. */
  readonly runs: string[];
  /** Read round trips (`first` / `all` / `raw`). */
  readonly reads: string[];
  /** One entry per `batch()` call, holding that batch's statements. */
  readonly batches: string[][];
}

const TAGGED = Symbol("tagged-d1-statement");

interface TaggedStatement extends D1PreparedStatement {
  readonly [TAGGED]: { readonly sql: string; readonly inner: D1PreparedStatement };
}

function isTagged(
  statement: D1PreparedStatement,
): statement is TaggedStatement {
  return TAGGED in statement;
}

/**
 * Counts every D1 round trip the bootstrap makes and remembers what each batch
 * carried, without changing any statement.
 */
class RecordingD1 implements D1Database {
  readonly traffic: D1Traffic = { runs: [], reads: [], batches: [] };

  constructor(
    readonly inner: SqliteFakeD1 = new SqliteFakeD1(),
    /** Optionally append a statement to a batch to make it fail mid-flight. */
    private readonly sabotage: (
      statements: readonly string[],
    ) => string | undefined = () => undefined,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return this.#tag(this.inner.prepare(query), query);
  }

  #tag(inner: D1PreparedStatement, sql: string): D1PreparedStatement {
    const traffic = this.traffic;
    const tag = (next: D1PreparedStatement): D1PreparedStatement =>
      this.#tag(next, sql);
    const statement: TaggedStatement = {
      [TAGGED]: { sql, inner },
      bind: (...values: readonly unknown[]) => tag(inner.bind(...values)),
      run: <T>() => {
        traffic.runs.push(sql);
        return inner.run<T>() as Promise<D1Result<T>>;
      },
      first: <T>() => {
        traffic.reads.push(sql);
        return inner.first<T>();
      },
      all: <T>() => {
        traffic.reads.push(sql);
        return inner.all<T>() as Promise<D1Result<T>>;
      },
      raw: <T>() => {
        traffic.reads.push(sql);
        return inner.raw<T>() as Promise<T[]>;
      },
    };
    return statement;
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const sql = statements.map((statement) =>
      isTagged(statement) ? statement[TAGGED].sql : "<untagged>",
    );
    this.traffic.batches.push(sql);
    const unwrapped = statements.map((statement) =>
      isTagged(statement) ? statement[TAGGED].inner : statement,
    );
    const injected = this.sabotage(sql);
    return this.inner.batch<T>(
      injected === undefined
        ? unwrapped
        : [...unwrapped, this.inner.prepare(injected)],
    );
  }

  exec(query: string) {
    return this.inner.exec(query);
  }
}

function resetTraffic(traffic: D1Traffic): void {
  traffic.runs.length = 0;
  traffic.reads.length = 0;
  traffic.batches.length = 0;
}

async function ledgerVersions(db: SqliteFakeD1): Promise<readonly number[]> {
  const rows = await db
    .prepare(`select version from schema_migrations order by version`)
    .all<{ readonly version: number }>();
  return (rows.results ?? []).map((row) => row.version);
}

test("a fresh bootstrap issues batches, not one round trip per statement", async () => {
  const db = new RecordingD1();
  await ensureD1OpenTofuLedgerSchema(db);

  const { runs, batches } = db.traffic;
  const batchedStatements = batches.reduce(
    (total, batch) => total + batch.length,
    0,
  );
  const migrations = (await ledgerVersions(db.inner)).length;

  // The pass really is large: this is the cost the seam used to pay one
  // `prepare().run()` at a time.
  expect(runs.length + batchedStatements).toBeGreaterThan(600);
  expect(migrations).toBeGreaterThan(50);

  // Batch count is bounded by the group count the batching rule allows: at
  // most one atomic group per migration that owns one, plus the groups the
  // ensure-DDL and the historical index passes split into.
  expect(batches.length).toBeLessThanOrEqual(
    migrations +
      Math.ceil(batchedStatements / D1_SCHEMA_BATCH_MAX_STATEMENTS),
  );

  // What is left outside a batch is the ledger insert of each migration that
  // applies imperatively, plus the handful of per-row repairs those migrations
  // still issue individually. It is not hundreds of DDL statements.
  expect(runs.length).toBeLessThanOrEqual(migrations + 32);
  expect(
    runs.filter((sql) => /^\s*create\s+(unique\s+)?index\b/iu.test(sql)).length,
  ).toBeLessThan(16);

  // Every statement inside a batch stays inside the documented D1 ceilings.
  for (const batch of batches) {
    for (const sql of batch) {
      expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(
        D1_MAX_STATEMENT_BYTES,
      );
    }
  }
});

test("re-running against an already-migrated database issues no statement", async () => {
  const db = new RecordingD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const first = await ledgerVersions(db.inner);
  resetTraffic(db.traffic);

  await ensureD1OpenTofuLedgerSchema(db);

  expect(db.traffic.runs).toEqual([]);
  expect(db.traffic.batches).toEqual([]);
  // One inventory read, one ledger shape probe, one ledger read.
  expect(db.traffic.reads.length).toBeLessThanOrEqual(4);
  expect(await ledgerVersions(db.inner)).toEqual(first);

  resetTraffic(db.traffic);
  await ensureD1OpenTofuLedgerSchema(db);
  expect(db.traffic.runs).toEqual([]);
  expect(db.traffic.batches).toEqual([]);
});

test("a batch that fails partway records no ledger row for its migration", async () => {
  const plain = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(plain, { throughMigrationVersion: 44 });
  const before = await ledgerVersions(plain);
  expect(before.at(-1)).toBe(44);

  // Fail inside the first batch that carries a migration's ledger insert. The
  // duplicate primary key raises after the migration's own statements have
  // executed, which is exactly the partial failure the batch must undo.
  let sabotaged = false;
  const db = new RecordingD1(plain, (statements) => {
    if (sabotaged) return undefined;
    if (!statements.some((sql) => /insert into schema_migrations/iu.test(sql))) {
      return undefined;
    }
    sabotaged = true;
    return `insert into schema_migrations (version, name, checksum, applied_at)
            values (1, 'duplicate', 'duplicate', 'duplicate')`;
  });

  await expect(ensureD1OpenTofuLedgerSchema(db)).rejects.toThrow();
  expect(sabotaged).toBe(true);
  expect(await ledgerVersions(plain)).toEqual(before);

  // The retry converges: the failed migration is simply still pending.
  await ensureD1OpenTofuLedgerSchema(plain);
  const after = await ledgerVersions(plain);
  expect(after.length).toBeGreaterThan(before.length);
  expect(after.slice(0, before.length)).toEqual(before);
});

test("statement groups never split a unit and stay inside the D1 ceilings", () => {
  const pair = [`drop index if exists example_idx`, `create index example_idx on t (a)`];
  const units = Array.from({ length: 40 }, () => pair);
  const groups = groupD1SchemaStatements(units);

  expect(groups.length).toBeGreaterThan(1);
  for (const group of groups) {
    expect(group.length).toBeLessThanOrEqual(D1_SCHEMA_BATCH_MAX_STATEMENTS);
    // A unit is never split across a group boundary: each group holds whole
    // drop/create pairs, so it starts with a drop and has an even length.
    expect(group.length % 2).toBe(0);
    expect(group[0]).toBe(pair[0]);
  }
  expect(groups.flat()).toEqual(units.flat());

  expect(() =>
    groupD1SchemaStatements([`select '${"x".repeat(D1_MAX_STATEMENT_BYTES)}'`]),
  ).toThrow(/exceeds the D1 ceiling/);
});
