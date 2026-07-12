import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const MIGRATION_ID = "deploy.install_config_runner_profile.normalize";
const RETIRED_PROFILE_IDS = [
  "cloudflare-default",
  "aws-provider-env-candidate",
  "gcp-provider-env-candidate",
  "azure-provider-env-candidate",
  "kubernetes-provider-env-candidate",
  "github-provider-env-candidate",
  "digitalocean-provider-env-candidate",
  "hcloud-provider-env-candidate",
  "vultr-provider-env-candidate",
  "scaleway-provider-env-candidate",
  "openstack-provider-env-candidate",
  "docker-custom-example",
  "generic-opentofu-provider",
] as const;

test("Postgres normalizes current InstallConfig runner profiles without rewriting historical Runs", async () => {
  const migration = postgresStorageMigrationStatements.find(
    (entry) => entry.id === MIGRATION_ID,
  );
  expect(migration).toBeDefined();
  expect(migration?.down).toBeUndefined();

  const db = new PGlite();
  try {
    await db.exec(`create table takosumi_install_configs (
      id text primary key,
      config_json jsonb not null
    )`);
    await db.exec(`create table takosumi_runs (
      id text primary key,
      run_json jsonb not null
    )`);
    for (const [index, runnerId] of RETIRED_PROFILE_IDS.entries()) {
      await db.query(
        `insert into takosumi_install_configs (id, config_json)
         values ($1::text, jsonb_build_object(
           'id', $1::text,
           'runnerId', $2::text
         ))`,
        [`cfg_${index}`, runnerId],
      );
    }
    await db.exec(`insert into takosumi_install_configs values
      ('cfg_custom', '{"id":"cfg_custom","runnerId":"private-network"}'),
      ('cfg_unset', '{"id":"cfg_unset"}')`);
    await db.exec(`insert into takosumi_runs values
      ('run_old', '{"id":"run_old","runnerProfileId":"cloudflare-default"}')`);

    for (const statement of splitSqlStatements(migration!.sql)) {
      await db.exec(statement);
    }
    for (const statement of splitSqlStatements(migration!.sql)) {
      await db.exec(statement);
    }

    const configs = await db.query<{ id: string; runner_id: string | null }>(
      `select id, config_json ->> 'runnerId' as runner_id
       from takosumi_install_configs order by id`,
    );
    expect(
      configs.rows
        .filter((row) => row.id.startsWith("cfg_") && /^cfg_\d+$/.test(row.id))
        .every((row) => row.runner_id === "opentofu-default"),
    ).toBe(true);
    expect(configs.rows.find((row) => row.id === "cfg_custom")?.runner_id).toBe(
      "private-network",
    );
    expect(configs.rows.find((row) => row.id === "cfg_unset")?.runner_id).toBe(
      null,
    );
    const run = await db.query<{ runner_id: string }>(
      `select run_json ->> 'runnerProfileId' as runner_id
       from takosumi_runs where id = 'run_old'`,
    );
    expect(run.rows[0]?.runner_id).toBe("cloudflare-default");
  } finally {
    await db.close();
  }
});

test("D1 normalizes current InstallConfig runner profiles without rewriting historical Runs", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await db.prepare(`delete from schema_migrations where version = 25`).run();

  for (const [index, runnerId] of RETIRED_PROFILE_IDS.entries()) {
    const id = `cfg_${index}`;
    await db
      .prepare(
        `insert into install_configs (
           id, space_id, install_type, trust_level, record_json, created_at, updated_at
         ) values (?, null, 'opentofu_module', 'untrusted', ?, '', '')`,
      )
      .bind(id, JSON.stringify({ id, runnerId }))
      .run();
  }
  await db
    .prepare(
      `insert into install_configs (
         id, space_id, install_type, trust_level, record_json, created_at, updated_at
       ) values
         ('cfg_custom', null, 'opentofu_module', 'untrusted', ?, '', ''),
         ('cfg_unset', null, 'opentofu_module', 'untrusted', ?, '', '')`,
    )
    .bind(
      JSON.stringify({ id: "cfg_custom", runnerId: "private-network" }),
      JSON.stringify({ id: "cfg_unset" }),
    )
    .run();
  const historicalRun = {
    id: "run_old",
    runnerProfileId: "cloudflare-default",
  };
  await db
    .prepare(
      `insert into runs (
         id, space_id, type, status, run_json, created_at
       ) values ('run_old', 'workspace_test', 'plan', 'succeeded', ?, '')`,
    )
    .bind(JSON.stringify(historicalRun))
    .run();

  await ensureD1OpenTofuLedgerSchema(db);
  await ensureD1OpenTofuLedgerSchema(db);

  const configs = await db
    .prepare(
      `select id, json_extract(record_json, '$.runnerId') as runner_id
       from install_configs order by id`,
    )
    .all<{ id: string; runner_id: string | null }>();
  const rows = configs.results ?? [];
  expect(
    rows
      .filter((row) => /^cfg_\d+$/.test(row.id))
      .every((row) => row.runner_id === "opentofu-default"),
  ).toBe(true);
  expect(rows.find((row) => row.id === "cfg_custom")?.runner_id).toBe(
    "private-network",
  );
  expect(rows.find((row) => row.id === "cfg_unset")?.runner_id).toBeNull();
  const run = await db
    .prepare(`select run_json from runs where id = 'run_old'`)
    .first<{ run_json: string }>();
  expect(JSON.parse(run?.run_json ?? "null")).toEqual(historicalRun);
});
