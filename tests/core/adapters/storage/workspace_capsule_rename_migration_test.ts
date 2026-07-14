/**
 * Round-trip tests for the P4 17-noun rename storage migrations.
 *
 * Postgres (PGlite): seeds a legacy takosumi_spaces / takosumi_opentofu_installations
 * / takosumi_state_snapshots / takosumi_output_snapshots / takosumi_output_shares
 * snapshot, runs the forward catalog migrations
 *   - deploy.workspace_capsule_rename            (v57, structural)
 *   - deploy.projects_default_backfill           (v58, data)
 *   - deploy.workspace_capsule_blob_key_rewrite  (v59, data, reversible)
 *   - deploy.retire_deployment_tracking          (v60, value-translation, forward-only)
 * and asserts the table renames, the default-Project backfill, the
 * retired-Deployment value-translation (capsules.current_state_version_id from the
 * highest-generation StateVersion), and the record_json blob-key rewrites. The
 * reversible migrations' `down` clauses are exercised back to the legacy names.
 *
 * D1 (SqliteFakeD1): seeds the same legacy ledger shape and runs the in-code boot
 * path (applyD1PreCreateRenames + migration 17,
 * `d1_opentofu_workspace_capsule_rename`), asserting the same end state.
 */
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const PG_MIGRATION_IDS = [
  "deploy.workspace_capsule_rename",
  "deploy.projects_default_backfill",
  "deploy.workspace_capsule_blob_key_rewrite",
  "deploy.retire_deployment_tracking",
] as const;

function pgMigration(id: string) {
  const migration = postgresStorageMigrationStatements.find(
    (entry) => entry.id === id,
  );
  if (!migration) throw new Error(`missing migration ${id}`);
  return migration;
}

async function applyPg(db: PGlite, sql: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) await db.exec(statement);
}

async function pgTableExists(db: PGlite, name: string): Promise<boolean> {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables where table_name = $1`,
    [name],
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

async function seedPgLegacy(db: PGlite): Promise<void> {
  await db.exec(`create table takosumi_spaces (
    id text primary key,
    handle text not null,
    space_json jsonb not null,
    created_at text not null,
    updated_at text not null
  )`);
  await db.exec(`create table takosumi_opentofu_installations (
    id text primary key,
    space_id text not null,
    name text not null,
    environment text not null,
    source_id text,
    install_config_id text not null,
    current_deployment_id text,
    status text not null,
    installation_json jsonb not null,
    created_at text not null,
    updated_at text not null
  )`);
  await db.exec(`create table takosumi_state_snapshots (
    id text primary key,
    space_id text not null,
    installation_id text not null,
    environment text not null,
    generation integer not null,
    snapshot_json jsonb not null,
    created_at text not null
  )`);
  await db.exec(`create table takosumi_output_snapshots (
    id text primary key,
    space_id text not null,
    installation_id text not null,
    state_generation integer not null,
    snapshot_json jsonb not null,
    created_at text not null
  )`);
  await db.exec(`create table takosumi_output_shares (
    id text primary key,
    from_space_id text not null,
    to_space_id text not null,
    producer_installation_id text not null,
    status text not null,
    share_json jsonb not null,
    created_at text not null
  )`);

  await db.exec(
    `insert into takosumi_spaces values (
       'ws_1', 'acme',
       '{"id":"ws_1","handle":"acme","ownerUserId":"user_1"}',
       '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
     )`,
  );
  await db.exec(
    `insert into takosumi_opentofu_installations values (
       'cap_1', 'ws_1', 'web', 'production', 'src_1', 'cfg_1', 'dep_old', 'active',
       '{"id":"cap_1","spaceId":"ws_1","name":"web","environment":"production","currentStateVersionId":"dep_old","currentOutputId":"out_1","status":"active"}',
       '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
     )`,
  );
  await db.exec(
    `insert into takosumi_state_snapshots values
       ('sv_1', 'ws_1', 'cap_1', 'production', 1,
        '{"id":"sv_1","spaceId":"ws_1","installationId":"cap_1","environment":"production","generation":1}',
        '2026-06-01T00:00:00.000Z'),
       ('sv_2', 'ws_1', 'cap_1', 'production', 2,
        '{"id":"sv_2","spaceId":"ws_1","installationId":"cap_1","environment":"production","generation":2}',
        '2026-06-02T00:00:00.000Z')`,
  );
  await db.exec(
    `insert into takosumi_output_snapshots values (
       'out_1', 'ws_1', 'cap_1', 2,
       '{"id":"out_1","spaceId":"ws_1","installationId":"cap_1","stateGeneration":2}',
       '2026-06-02T00:00:00.000Z'
     )`,
  );
  await db.exec(
    `insert into takosumi_output_shares values (
       'share_1', 'ws_1', 'ws_2', 'cap_1', 'active',
       '{"id":"share_1","fromSpaceId":"ws_1","toSpaceId":"ws_2","producerInstallationId":"cap_1","status":"active"}',
       '2026-06-02T00:00:00.000Z'
     )`,
  );
}

test("Postgres P4 rename migrations rename, backfill, value-translate and rewrite blobs", async () => {
  for (const id of PG_MIGRATION_IDS) expect(pgMigration(id)).toBeDefined();
  // The three structural/reversible migrations carry a down; value-translation is
  // forward-only.
  expect(pgMigration("deploy.workspace_capsule_rename").down).toBeDefined();
  expect(pgMigration("deploy.projects_default_backfill").down).toBeDefined();
  expect(
    pgMigration("deploy.workspace_capsule_blob_key_rewrite").down,
  ).toBeDefined();
  expect(pgMigration("deploy.retire_deployment_tracking").down).toBeUndefined();

  const db = new PGlite();
  try {
    await seedPgLegacy(db);
    for (const id of PG_MIGRATION_IDS) await applyPg(db, pgMigration(id).sql);

    // Tables renamed.
    expect(await pgTableExists(db, "takosumi_workspaces")).toBe(true);
    expect(await pgTableExists(db, "takosumi_capsules")).toBe(true);
    expect(await pgTableExists(db, "takosumi_state_versions")).toBe(true);
    expect(await pgTableExists(db, "takosumi_outputs")).toBe(true);
    expect(await pgTableExists(db, "takosumi_projects")).toBe(true);
    expect(await pgTableExists(db, "takosumi_opentofu_installations")).toBe(
      false,
    );

    // Default Project backfilled per Workspace; Capsule points at it.
    const project = await db.query<{ workspace_id: string; slug: string }>(
      `select workspace_id, slug from takosumi_projects where id = 'prj_default_ws_1'`,
    );
    expect(project.rows[0]).toEqual({ workspace_id: "ws_1", slug: "default" });
    const capsule = await db.query<{
      project_id: string;
      current_state_version_id: string;
    }>(
      `select project_id, current_state_version_id from takosumi_capsules where id = 'cap_1'`,
    );
    expect(capsule.rows[0]?.project_id).toBe("prj_default_ws_1");
    // retire_deployment_tracking value-translation: the highest-generation
    // StateVersion (sv_2), NOT the retired deployment id 'dep_old'.
    expect(capsule.rows[0]?.current_state_version_id).toBe("sv_2");

    // installation_json blob keys rewritten + value-translated.
    const capsuleJson = await db.query<{
      workspace_id: string | null;
      space_id: string | null;
      current_state_version_id: string | null;
      current_deployment_id: string | null;
      current_output_id: string | null;
      project_id: string | null;
    }>(
      `select installation_json->>'workspaceId' as workspace_id,
              installation_json->>'spaceId' as space_id,
              installation_json->>'currentStateVersionId' as current_state_version_id,
              installation_json->>'currentDeploymentId' as current_deployment_id,
              installation_json->>'currentOutputId' as current_output_id,
              installation_json->>'projectId' as project_id
       from takosumi_capsules where id = 'cap_1'`,
    );
    expect(capsuleJson.rows[0]).toEqual({
      workspace_id: "ws_1",
      space_id: null,
      current_state_version_id: "sv_2",
      current_deployment_id: null,
      current_output_id: "out_1",
      project_id: "prj_default_ws_1",
    });

    const stateJson = await db.query<{ w: string | null; c: string | null }>(
      `select snapshot_json->>'workspaceId' as w, snapshot_json->>'capsuleId' as c
       from takosumi_state_versions where id = 'sv_2'`,
    );
    expect(stateJson.rows[0]).toEqual({ w: "ws_1", c: "cap_1" });

    const outputJson = await db.query<{ w: string | null; c: string | null }>(
      `select snapshot_json->>'workspaceId' as w, snapshot_json->>'capsuleId' as c
       from takosumi_outputs where id = 'out_1'`,
    );
    expect(outputJson.rows[0]).toEqual({ w: "ws_1", c: "cap_1" });

    const shareJson = await db.query<{
      f: string | null;
      t: string | null;
      p: string | null;
    }>(
      `select share_json->>'fromWorkspaceId' as f,
              share_json->>'toWorkspaceId' as t,
              share_json->>'producerCapsuleId' as p
       from takosumi_output_shares where id = 'share_1'`,
    );
    expect(shareJson.rows[0]).toEqual({ f: "ws_1", t: "ws_2", p: "cap_1" });

    // Reverse the reversible migrations (blob rewrite -> backfill -> structural)
    // back to the legacy names. (Value-translation is forward-only.)
    await applyPg(
      db,
      pgMigration("deploy.workspace_capsule_blob_key_rewrite").down!,
    );
    await applyPg(db, pgMigration("deploy.projects_default_backfill").down!);
    await applyPg(db, pgMigration("deploy.workspace_capsule_rename").down!);

    expect(await pgTableExists(db, "takosumi_opentofu_installations")).toBe(
      true,
    );
    expect(await pgTableExists(db, "takosumi_spaces")).toBe(true);
    expect(await pgTableExists(db, "takosumi_state_snapshots")).toBe(true);
    expect(await pgTableExists(db, "takosumi_output_snapshots")).toBe(true);
    expect(await pgTableExists(db, "takosumi_projects")).toBe(false);
    const reversed = await db.query<{ w: string | null; s: string | null }>(
      `select snapshot_json->>'workspaceId' as w, snapshot_json->>'spaceId' as s
       from takosumi_state_snapshots where id = 'sv_2'`,
    );
    expect(reversed.rows[0]).toEqual({ w: null, s: "ws_1" });
  } finally {
    await db.close();
  }
});

async function seedD1Legacy(db: SqliteFakeD1): Promise<void> {
  await db
    .prepare(
      `create table spaces (
        id text primary key, handle text not null, record_json text not null,
        created_at text not null, updated_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `create table installations (
        id text primary key,
        space_id text not null,
        name text not null,
        slug text not null,
        source_id text,
        install_type text not null,
        install_config_id text not null,
        environment text not null,
        current_deployment_id text,
        current_state_generation integer not null default 0,
        current_output_snapshot_id text,
        status text not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null,
        unique (space_id, name, environment)
      )`,
    )
    .run();
  await db
    .prepare(
      `create table state_snapshots (
        id text primary key, space_id text not null, installation_id text not null,
        environment text not null, generation integer not null, object_key text not null,
        digest text not null, created_by_run_id text not null, created_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `create table output_snapshots (
        id text primary key, space_id text not null, installation_id text not null,
        state_generation integer not null, record_json text not null, created_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `create table output_shares (
        id text primary key, from_space_id text not null, to_space_id text not null,
        producer_installation_id text not null, status text not null,
        record_json text not null, created_at text not null
      )`,
    )
    .run();

  await db
    .prepare(
      `insert into spaces values ('ws_1','acme','{"id":"ws_1","handle":"acme","ownerUserId":"user_1"}','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `insert into installations values (
        'cap_1','ws_1','web','web','src_1','opentofu_module','cfg_1','production',
        'dep_old',2,'out_1','active',
        '{"id":"cap_1","spaceId":"ws_1","name":"web","environment":"production","currentStateVersionId":"dep_old","currentOutputId":"out_1","status":"active"}',
        '2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z'
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into state_snapshots values
        ('sv_1','ws_1','cap_1','production',1,'k1','d1','run_1','2026-06-01T00:00:00.000Z'),
        ('sv_2','ws_1','cap_1','production',2,'k2','d2','run_2','2026-06-02T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `insert into output_snapshots values (
        'out_1','ws_1','cap_1',2,
        '{"id":"out_1","spaceId":"ws_1","installationId":"cap_1","stateGeneration":2}',
        '2026-06-02T00:00:00.000Z'
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into output_shares values (
        'share_1','ws_1','ws_2','cap_1','active',
        '{"id":"share_1","fromSpaceId":"ws_1","toSpaceId":"ws_2","producerInstallationId":"cap_1","status":"active"}',
        '2026-06-02T00:00:00.000Z'
      )`,
    )
    .run();
}

test("D1 P4 rename boot path renames, backfills, value-translates and rewrites blobs", async () => {
  const db = new SqliteFakeD1();
  await seedD1Legacy(db);
  await ensureD1OpenTofuLedgerSchema(db);

  const tables = await db
    .prepare(`select name from sqlite_master where type = 'table'`)
    .all<{ name: string }>();
  const tableSet = new Set((tables.results ?? []).map((row) => row.name));
  expect(tableSet.has("capsules")).toBe(true);
  expect(tableSet.has("workspaces")).toBe(true);
  expect(tableSet.has("state_versions")).toBe(true);
  expect(tableSet.has("outputs")).toBe(true);
  expect(tableSet.has("projects")).toBe(true);
  expect(tableSet.has("installations")).toBe(false);

  const project = await db
    .prepare(
      `select workspace_id, slug from projects where id = 'prj_default_ws_1'`,
    )
    .first<{ workspace_id: string; slug: string }>();
  expect(project).toEqual({ workspace_id: "ws_1", slug: "default" });

  const capsule = await db
    .prepare(
      `select project_id, current_state_version_id,
              json_extract(record_json,'$.workspaceId') as ws,
              json_extract(record_json,'$.spaceId') as sp,
              json_extract(record_json,'$.currentStateVersionId') as csv,
              json_extract(record_json,'$.currentDeploymentId') as cdep,
              json_extract(record_json,'$.currentOutputId') as cout,
              json_extract(record_json,'$.currentOutputSnapshotId') as coutsnap,
              json_extract(record_json,'$.projectId') as proj
       from capsules where id = 'cap_1'`,
    )
    .first<Record<string, string | null>>();
  expect(capsule?.project_id).toBe("prj_default_ws_1");
  expect(capsule?.current_state_version_id).toBe("sv_2");
  expect(capsule?.ws).toBe("ws_1");
  expect(capsule?.sp).toBeNull();
  expect(capsule?.csv).toBe("sv_2");
  expect(capsule?.cdep).toBeNull();
  expect(capsule?.cout).toBe("out_1");
  expect(capsule?.coutsnap).toBeNull();
  expect(capsule?.proj).toBe("prj_default_ws_1");

  const output = await db
    .prepare(
      `select json_extract(record_json,'$.workspaceId') as ws,
              json_extract(record_json,'$.capsuleId') as cap,
              json_extract(record_json,'$.spaceId') as sp
       from outputs where id = 'out_1'`,
    )
    .first<Record<string, string | null>>();
  expect(output).toEqual({ ws: "ws_1", cap: "cap_1", sp: null });

  const share = await db
    .prepare(
      `select json_extract(record_json,'$.fromWorkspaceId') as f,
              json_extract(record_json,'$.toWorkspaceId') as t,
              json_extract(record_json,'$.producerCapsuleId') as p,
              json_extract(record_json,'$.fromSpaceId') as fs
       from output_shares where id = 'share_1'`,
    )
    .first<Record<string, string | null>>();
  expect(share).toEqual({ f: "ws_1", t: "ws_2", p: "cap_1", fs: null });

  // Idempotent across reboots.
  await ensureD1OpenTofuLedgerSchema(db);
  const reCapsule = await db
    .prepare(
      `select current_state_version_id from capsules where id = 'cap_1'`,
    )
    .first<{ current_state_version_id: string }>();
  expect(reCapsule?.current_state_version_id).toBe("sv_2");
});
