import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";

test("Workspace Output Sync retirement drops only the retired execution table", async () => {
  const historicalCreate = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.workspace_output_sync.create",
  );
  const retirement = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.workspace_output_sync.retire",
  );

  expect(historicalCreate?.version).toBe(71);
  expect(retirement?.version).toBe(74);
  expect(retirement?.down).toBeUndefined();

  const db = new PGlite();
  try {
    await db.exec(`
      create table takosumi_outputs (
        id text primary key,
        output_json jsonb not null
      );
      create table takosumi_workspace_output_sync (
        workspace_id text primary key,
        enabled boolean not null default true,
        output_revision integer not null default 0,
        reconciled_revision integer not null default 0,
        active_run_group_id text,
        consecutive_passes integer not null default 0,
        updated_at text not null
      );
      create index takosumi_workspace_output_sync_pending_idx
        on takosumi_workspace_output_sync (
          enabled,
          output_revision,
          reconciled_revision
        );
    `);

    await db.exec(retirement!.sql);

    const tables = await db.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'takosumi_outputs',
            'takosumi_workspace_output_sync'
          )
        order by table_name`,
    );
    expect(tables.rows).toEqual([{ table_name: "takosumi_outputs" }]);
  } finally {
    await db.close();
  }
});
