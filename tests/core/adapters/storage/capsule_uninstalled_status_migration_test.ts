import { expect, test } from "bun:test";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { PGliteSqlClient, splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const insertCapsule = (id: string, status: string) => `insert into takosumi_capsules (
  id, space_id, project_id, name, environment, source_id, install_config_id,
  current_state_version_id, status, installation_json, created_at, updated_at
) values (
  '${id}', 'ws_uninstall_migration', 'prj_uninstall_migration', '${id}', 'production',
  'src_uninstall_migration', 'icfg_uninstall_migration', null, '${status}',
  '{"id":"${id}","status":"${status}","fixture":true}',
  '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
)`;

test("Postgres v117 accepts the uninstalled Capsule status without rewriting rows", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(116);
  try {
    for (const status of ["pending", "active", "stale", "error", "disabled", "destroyed"]) {
      await client.query(insertCapsule(`cap_before_${status}`, status));
    }
    const before = await client.query("select * from takosumi_capsules order by id");
    // The protected predecessor names the inline v35 constraint after the
    // pre-rename table and genuinely refuses the new grace state.
    await expect(client.query(insertCapsule("cap_rejected_uninstalled", "uninstalled")))
      .rejects.toMatchObject({ code: "23514", constraint: "takosumi_opentofu_installations_status_check" });

    const migration = postgresStorageMigrationStatements.find((entry) => entry.version === 117);
    expect(migration?.id).toBe("deploy.capsule_uninstalled_status.expand");
    expect(migration?.down).toBeUndefined();
    const statements = splitSqlStatements(migration!.sql);
    expect(statements).toHaveLength(1);
    await expect(client.transaction(async (transaction) => {
      for (const statement of statements) await transaction.query(statement);
      throw new Error("fixture migration rollback");
    })).rejects.toThrow("fixture migration rollback");
    await expect(client.query(insertCapsule("cap_still_rejected", "uninstalled")))
      .rejects.toMatchObject({ code: "23514" });

    await client.transaction(async (transaction) => {
      for (const statement of statements) await transaction.query(statement);
    });
    expect((await client.query("select * from takosumi_capsules order by id")).rows)
      .toEqual(before.rows);
    const constraints = await client.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'takosumi_capsules'::regclass and contype = 'c'
        order by conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toContain("takosumi_capsules_status_check");
    expect(constraints.rows.map((row) => row.conname))
      .not.toContain("takosumi_opentofu_installations_status_check");

    await client.query(insertCapsule("cap_after_uninstalled", "uninstalled"));
    await client.query(
      "update takosumi_capsules set status = 'uninstalled' where id = 'cap_before_active'",
    );
    await client.query(
      "update takosumi_capsules set status = 'active' where id = 'cap_before_active'",
    );
    await expect(
      client.query("update takosumi_capsules set status = 'unknown' where id = 'cap_before_active'"),
    ).rejects.toMatchObject({ code: "23514", constraint: "takosumi_capsules_status_check" });

    // Re-running the forward statement is a no-op repair, not a narrowing.
    for (const statement of statements) await client.query(statement);
    await client.query(insertCapsule("cap_after_repair", "uninstalled"));
  } finally {
    await client.close();
  }
});
