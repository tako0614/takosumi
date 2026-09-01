import { expect, test } from "bun:test";
import {
  PGliteSqlClient,
  splitSqlStatements,
} from "../../helpers/deploy-control/pglite_sql_client.ts";
import { postgresStorageMigrationStatements } from "../../../core/adapters/storage/migrations.ts";
import {
  canonicalStorageMigrationChecksum,
  StorageMigrationRunner,
} from "../../../core/adapters/storage/migration-runner/mod.ts";
import { renderNamedParams } from "../../../core/scripts/pg_sql_client.ts";
import type { SqlClient } from "../../../core/adapters/storage/sql.ts";
import {
  assertDisposableDatabaseUrl,
  assertDisposableEnvironment,
  assertDisposableScope,
  FixtureResetCliError,
  parseFixtureResetArgs,
  runFixtureReset,
} from "../../../core/scripts/db-fixture-reset.ts";

const LOOPBACK = "postgres://takos@127.0.0.1:5432/takosumi_dev";

test("fixture reset requires an explicit disposable scope", () => {
  expect(() => assertDisposableScope(undefined)).toThrow(FixtureResetCliError);
  expect(() => assertDisposableScope("production")).toThrow(
    FixtureResetCliError,
  );
  expect(() => assertDisposableScope("staging")).toThrow(FixtureResetCliError);
  expect(assertDisposableScope("local")).toBe("local");
  expect(assertDisposableScope("development")).toBe("development");
  expect(assertDisposableScope("test")).toBe("test");
});

test("fixture reset only accepts a loopback postgres target", () => {
  assertDisposableDatabaseUrl(LOOPBACK);
  assertDisposableDatabaseUrl("postgres://takos@localhost/takosumi_dev");
  assertDisposableDatabaseUrl("/var/run/postgresql");

  expect(() =>
    assertDisposableDatabaseUrl("postgres://takos@db.example.com/takosumi")
  ).toThrow(FixtureResetCliError);
  expect(() => assertDisposableDatabaseUrl("https://example.com/db")).toThrow(
    FixtureResetCliError,
  );
  expect(() => assertDisposableDatabaseUrl("not a url")).toThrow(
    FixtureResetCliError,
  );
});

test("fixture reset refuses a production-like environment", () => {
  expect(() => assertDisposableEnvironment({ TAKOSUMI_ENVIRONMENT: "production" }))
    .toThrow(FixtureResetCliError);
  expect(() => assertDisposableEnvironment({ TAKOSUMI_ENVIRONMENT: "staging" }))
    .toThrow(FixtureResetCliError);
  assertDisposableEnvironment({ TAKOSUMI_ENVIRONMENT: "local" });
  assertDisposableEnvironment({});
});

test("fixture reset never reads a protected database URL", () => {
  const env = {
    DATABASE_URL: "postgres://takos@127.0.0.1/production_lookalike",
    TAKOSUMI_PRODUCTION_DATABASE_URL: LOOPBACK,
    TAKOSUMI_STAGING_DATABASE_URL: LOOPBACK,
  };

  expect(() => parseFixtureResetArgs(["--scope=local"], env)).toThrow(
    FixtureResetCliError,
  );
});

test("fixture reset resolves its own env var and reset selectors", () => {
  const env = { TAKOSUMI_FIXTURE_DATABASE_URL: LOOPBACK };

  const stepped = parseFixtureResetArgs(["--scope=local", "--steps=2"], env);
  expect(stepped).toEqual({
    scope: "local",
    url: LOOPBACK,
    steps: 2,
    targetVersion: undefined,
    dryRun: false,
  });

  const targeted = parseFixtureResetArgs(
    ["--scope=test", "--target-version=61", "--dry-run"],
    env,
  );
  expect(targeted.targetVersion).toBe(61);
  expect(targeted.dryRun).toBe(true);

  expect(() =>
    parseFixtureResetArgs(
      ["--scope=local", "--steps=1", "--target-version=2"],
      env,
    )
  ).toThrow(FixtureResetCliError);
  expect(() => parseFixtureResetArgs(["--scope=local", "--nope"], env)).toThrow(
    FixtureResetCliError,
  );
});

test("fixture reset accepts an explicit --url over the env var", () => {
  const options = parseFixtureResetArgs(
    ["--scope=development", `--url=${LOOPBACK}`],
    {},
  );
  expect(options.url).toBe(LOOPBACK);
});

test("fixture reset unwinds a real migrated database and stops at the first migration without down SQL", async () => {
  const client = await migratedClientWithLedger();
  const head = [...postgresStorageMigrationStatements].sort(
    (left, right) => right.version - left.version,
  )[0]!;

  const lines: string[] = [];
  const planned = await runFixtureReset(
    client,
    { scope: "local", steps: 1, dryRun: true },
    (line) => lines.push(line),
  );
  expect(planned).toEqual([head.id]);
  expect(lines[0]).toContain("would reset 1 migration(s)");
  // A dry run changes nothing.
  expect(await appliedIds(client)).toContain(head.id);

  const reset = await runFixtureReset(
    client,
    { scope: "local", steps: 1, dryRun: false },
    () => {},
  );
  expect(reset).toEqual([head.id]);
  expect(await appliedIds(client)).not.toContain(head.id);

  // The chain is only unwindable while every entry carries fixture-reset SQL.
  await expect(
    runFixtureReset(
      client,
      { scope: "local", steps: 20, dryRun: true },
      () => {},
    ),
  ).rejects.toThrow(/no fixture reset SQL/);
});

test("fixture reset refuses a protected scope even with a live client", async () => {
  const client = await migratedClientWithLedger();
  await expect(
    runFixtureReset(
      client,
      { scope: "production" as never, steps: 1, dryRun: true },
      () => {},
    ),
  ).rejects.toThrow(/forward-only/);
});

async function appliedIds(client: SqlClient): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    "select id from storage_migrations",
  );
  return result.rows.map((row) => String(row.id));
}

/**
 * A fully migrated PGlite database whose `storage_migrations` ledger is
 * populated, i.e. what an operator's disposable local database looks like.
 *
 * The PGlite helper applies migration SQL directly without recording the
 * ledger, and its client speaks positional parameters and one statement per
 * call. This wrapper renders the runner's named parameters and splits
 * statement bodies the same way the helper does for migrations, so the reset
 * path runs its real `down` SQL against a real Postgres engine.
 */
async function migratedClientWithLedger(): Promise<SqlClient> {
  const pglite = await PGliteSqlClient.create();
  const client = namedParameterClient(pglite);
  // v1 created the ledger without a checksum column; the runner's bootstrap
  // adds it. The PGlite helper replays migration SQL only, so run it here.
  await new StorageMigrationRunner(client).listAppliedMigrations();
  for (const migration of postgresStorageMigrationStatements) {
    await client.query(
      `insert into storage_migrations (id, version, checksum, applied_at)
       values (:id, :version, :checksum, now())`,
      {
        id: migration.id,
        version: migration.version,
        checksum: await canonicalStorageMigrationChecksum(migration),
      },
    );
  }
  return client;
}

function namedParameterClient(inner: SqlClient): SqlClient {
  const wrap = (runner: SqlClient): SqlClient => ({
    async query(sql, parameters) {
      const rendered = renderNamedParams(sql, parameters);
      if (!parameters) {
        // Statement bodies (migration / down SQL) carry no parameters and may
        // hold several statements.
        let last = { rows: [], rowCount: 0 };
        for (const statement of splitSqlStatements(rendered.sql)) {
          last = await runner.query(statement);
        }
        return last;
      }
      return await runner.query(rendered.sql, rendered.values);
    },
    transaction(fn) {
      return runner.transaction((tx) =>
        fn(wrap(tx as unknown as SqlClient) as never)
      );
    },
  });
  return wrap(inner);
}
