import assert from "node:assert/strict";
import {
  probePostgresHealth,
  retryPostgres,
  SelfHostedPostgresError,
  SelfHostedPostgresMigrationRunner,
  type SelfHostedSqlClient,
  type SelfHostedSqlParameters,
  type SelfHostedSqlQueryResult,
} from "../src/providers/selfhosted/mod.ts";

class StubSql implements SelfHostedSqlClient {
  readonly statements: string[] = [];
  readonly params: unknown[] = [];
  readonly ledger: Array<Record<string, unknown>> = [];
  readonly schemaCreated = { value: false };

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SelfHostedSqlParameters,
  ): Promise<SelfHostedSqlQueryResult<Row>> {
    this.statements.push(sql.trim());
    this.params.push(parameters);
    if (/^create table if not exists/i.test(sql.trim())) {
      this.schemaCreated.value = true;
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (/^select id, description, checksum/i.test(sql.trim())) {
      return Promise.resolve({
        rows: this.ledger as unknown as Row[],
        rowCount: this.ledger.length,
      });
    }
    if (/^insert into takos_paas_migrations/i.test(sql.trim())) {
      this.ledger.push({
        id: (parameters as Record<string, unknown>).id,
        description: (parameters as Record<string, unknown>).description,
        checksum: (parameters as Record<string, unknown>).checksum,
        appliedAt: (parameters as Record<string, unknown>).appliedAt,
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

Deno.test("selfhosted postgres migration runner ensures the ledger table", async () => {
  const sql = new StubSql();
  const runner = new SelfHostedPostgresMigrationRunner(sql, {
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
  });
  await runner.ensureLedger();
  assert.ok(sql.schemaCreated.value);
});

Deno.test("selfhosted postgres migration runner applies and skips on re-run", async () => {
  const sql = new StubSql();
  const clock = () => new Date("2026-04-30T00:00:00.000Z");
  const runner = new SelfHostedPostgresMigrationRunner(sql, { clock });
  const migrations = [{
    id: "001_init",
    description: "create takos table",
    statements: ["create table takos_x (id text)"],
  }];

  const first = await runner.apply(migrations);
  assert.equal(first.applied.length, 1);
  assert.equal(first.skipped.length, 0);

  const second = await runner.apply(migrations);
  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, 1);
});

Deno.test("selfhosted postgres migration runner detects checksum drift", async () => {
  const sql = new StubSql();
  const runner = new SelfHostedPostgresMigrationRunner(sql, {
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
  });
  await runner.apply([{
    id: "001_init",
    statements: ["create table x ()"],
  }]);
  await assert.rejects(
    () =>
      runner.apply([{
        id: "001_init",
        statements: ["create table y ()"],
      }]),
    (error) =>
      error instanceof SelfHostedPostgresError &&
      /checksum mismatch/.test(error.message),
  );
});

Deno.test("selfhosted postgres retry recovers from transient connection errors", async () => {
  let attempts = 0;
  const result = await retryPostgres(() => {
    attempts += 1;
    if (attempts < 3) throw new Error("ECONNREFUSED while connecting");
    return Promise.resolve("ok");
  }, { sleep: () => Promise.resolve(), initialBackoffMs: 1, maxAttempts: 5 });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

Deno.test("selfhosted postgres health probe reports timeout when client stalls", async () => {
  const stub = {
    query() {
      return new Promise<SelfHostedSqlQueryResult>(() => {
        // never resolves
      });
    },
  } as unknown as SelfHostedSqlClient;
  const health = await probePostgresHealth(stub, { timeoutMs: 5 });
  assert.equal(health.ok, false);
});
