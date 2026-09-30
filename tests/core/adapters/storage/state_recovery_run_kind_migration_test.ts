import { expect, test } from "bun:test";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { PGliteSqlClient, splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";

test("Postgres v115 admits state recovery without rewriting historical resource operation Runs", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(114);
  try {
    const migration = postgresStorageMigrationStatements.find((entry) => entry.version === 115);
    expect(migration?.id).toBe("deploy.state_recovery_run_kind.add");
    const statements = splitSqlStatements(migration!.sql);
    await client.query(`insert into takosumi_runs
      (id, kind, space_id, status, created_at, run_json)
      values ($1, 'resource_operation', $2, 'succeeded', $3, $4::jsonb)`, [
      "historical_resource_run", "workspace_fixture", "2026-09-30T00:00:00.000Z",
      JSON.stringify({ id: "historical_resource_run", type: "resource_operation", status: "succeeded" }),
    ]);
    const before = await client.query("select * from takosumi_runs where id = $1", ["historical_resource_run"]);
    await expect(client.query(`insert into takosumi_runs
      (id, kind, space_id, status, created_at, run_json)
      values ('recovery_before', 'state_recovery', 'workspace_fixture', 'succeeded',
        '2026-09-30T00:00:00.000Z', '{"id":"recovery_before"}'::jsonb)`))
      .rejects.toMatchObject({ code: "23514" });

    await expect(client.transaction(async (transaction) => {
      for (const statement of statements) await transaction.query(statement);
      throw new Error("fixture migration rollback");
    })).rejects.toThrow("fixture migration rollback");
    await expect(client.query(`insert into takosumi_runs
      (id, kind, space_id, status, created_at, run_json)
      values ('recovery_rolled_back', 'state_recovery', 'workspace_fixture', 'succeeded',
        '2026-09-30T00:00:00.000Z', '{"id":"recovery_rolled_back"}'::jsonb)`))
      .rejects.toMatchObject({ code: "23514" });

    await client.transaction(async (transaction) => {
      for (const statement of statements) await transaction.query(statement);
    });
    expect((await client.query("select * from takosumi_runs where id = $1", ["historical_resource_run"])).rows)
      .toEqual(before.rows);
    await client.query(`insert into takosumi_runs
      (id, kind, space_id, status, created_at, run_json)
      values ('recovery_after', 'state_recovery', 'workspace_fixture', 'succeeded',
        '2026-09-30T00:00:00.000Z', '{"id":"recovery_after"}'::jsonb)`);
    expect((await client.query("select kind from takosumi_runs where id = $1", ["recovery_after"])).rows)
      .toEqual([{ kind: "state_recovery" }]);
  } finally {
    await client.close();
  }
});
