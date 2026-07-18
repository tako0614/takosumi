import { expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
  fenceControlD1Schema,
  SqliteControlD1Database,
  verifyControlD1Schema,
} from "../../../deploy/platform/control_d1_schema.ts";
import { runControlD1SchemaCli } from "../../../deploy/platform/control_d1_schema_cli.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import {
  CloudflareControlD1RestDatabase,
  ControlD1RestError,
} from "../../../deploy/platform/control_d1_schema_rest.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import {
  acquireControlD1MaintenanceFence,
  assertControlD1MaintenanceInactive,
  ControlD1MaintenanceError,
  readControlD1MaintenanceState,
  releaseControlD1MaintenanceFence,
} from "../../../worker/src/d1_schema_maintenance.ts";

const SOURCE_COMMIT = "a".repeat(40);
const NOW = "2026-07-16T00:00:00.000Z";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function seedLiveV24ConvergenceRows(
  database: D1Database,
  environment: "staging" | "production",
): Promise<void> {
  await database
    .prepare(
      `insert into workspaces
         (id, handle, record_json, created_at, updated_at)
       values ('ws_live_v24', 'live-v24', ?, ?, ?)`,
    )
    .bind(JSON.stringify({ fixture: environment }), NOW, NOW)
    .run();
  await database
    .prepare(
      `insert into capsule_compatibility_reports (
         id, source_id, installation_id, source_snapshot_id, level,
         findings_json, providers_json, resources_json, data_sources_json,
         provisioners_json, normalized_object_key, normalized_digest,
         root_module_variables_json, root_module_outputs_json, created_at
       ) values (
         'compat_live_v24', 'source_live_v24', 'capsule_live_v24',
         'snapshot_live_v24', 'ready', '[]', '[]', '[]', '[]', '[]',
         'retired/object', 'sha256:retired', '["input"]', '["output"]', ?
       )`,
    )
    .bind(NOW)
    .run();
  await database
    .prepare(
      `insert into resolution_locks (
         resource_id, selected_implementation, target, locked, reason_json,
         portability, native_resources_json, locked_at, updated_at
       ) values (
         'resource_live_v24', 'adapter.test', 'target_live_v24', 1, '{}',
         'portable', '[]', ?, ?
       )`,
    )
    .bind(NOW, NOW)
    .run();
  await database
    .prepare(
      `insert into resource_shapes (
         id, space_id, project, environment, kind, name, managed_by,
         spec_json, phase, generation, observed_generation, outputs_json,
         conditions_json, labels_json, created_at, updated_at
       ) values (
         'resource_live_v24', 'ws_live_v24', 'default', 'default',
         'Service', 'live-v24', 'takosumi', '{}', 'Ready', 2, 2, '{}',
         '[]', '{}', ?, ?
       )`,
    )
    .bind(NOW, NOW)
    .run();
  await database
    .prepare(
      `insert into runs (
         id, run_group_id, space_id, source_id, installation_id, environment,
         type, status, lease_token, heartbeat_at, run_json, created_at
       ) values (
         'run_live_v24', 'group_live_v24', 'ws_live_v24', 'source_live_v24',
         'capsule_live_v24', 'default', 'apply', 'succeeded', 'lease-v24', 42,
         '{}', ?
       )`,
    )
    .bind(NOW)
    .run();
  await database
    .prepare(
      `insert into state_versions (
         id, space_id, installation_id, environment, generation, object_key,
         digest, created_by_run_id, created_at
       ) values (
         'state_live_v24', 'ws_live_v24', 'capsule_live_v24', 'default', 7,
         'state/live-v24', 'sha256:state-live-v24', 'run_live_v24', ?
       )`,
    )
    .bind(NOW)
    .run();
}

async function readLiveV24ConvergenceRows(database: D1Database) {
  return {
    workspace: await database
      .prepare(
        `select id, handle, record_json, created_at, updated_at
         from workspaces where id = 'ws_live_v24'`,
      )
      .first(),
    compatibility: await database
      .prepare(
        `select id, source_id, installation_id, source_snapshot_id, level,
                findings_json, providers_json, resources_json,
                data_sources_json, provisioners_json,
                root_module_variables_json, root_module_outputs_json,
                created_at
         from capsule_compatibility_reports where id = 'compat_live_v24'`,
      )
      .first(),
    resolutionLock: await database
      .prepare(
        `select resource_id, selected_implementation, target, locked,
                reason_json, portability, native_resources_json, locked_at,
                updated_at
         from resolution_locks where resource_id = 'resource_live_v24'`,
      )
      .first(),
    resource: await database
      .prepare(
        `select id, space_id, project, environment, kind, name, managed_by,
                spec_json, phase, generation, observed_generation,
                outputs_json, conditions_json, labels_json, created_at,
                updated_at
         from resource_shapes where id = 'resource_live_v24'`,
      )
      .first(),
    run: await database
      .prepare(
        `select id, run_group_id, space_id, source_id, installation_id,
                environment, type, status, lease_token, heartbeat_at,
                run_json, created_at
         from runs where id = 'run_live_v24'`,
      )
      .first(),
    stateVersion: await database
      .prepare(
        `select id, space_id, installation_id, environment, generation,
                object_key, digest, created_by_run_id, created_at
         from state_versions where id = 'state_live_v24'`,
      )
      .first(),
  };
}

async function legacyApplicationSchemaSnapshot(database: D1Database) {
  const objects = await database
    .prepare(
      `select type, name, tbl_name, sql
       from sqlite_master
       where type in ('table', 'index', 'view')
         and name not like 'sqlite_%'
         and name != '_takosumi_control_schema_maintenance'
       order by type, name`,
    )
    .all();
  const ledger = await database
    .prepare(
      `select version, name, checksum, applied_at
       from schema_migrations order by version`,
    )
    .all();
  return { objects: objects.results ?? [], ledger: ledger.results ?? [] };
}

test("control D1 plan captures the full OSS schema and migration ledger", async () => {
  const plan = await buildControlD1SchemaPlan();
  expect(plan.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(plan.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(plan.ledgerDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(plan.migrations.at(-1)?.version).toBe(47);
  expect(plan.migrations).toHaveLength(44);
  expect(plan.tables.some((table) => table.name === "target_pools")).toBe(true);
  expect(
    plan.tables.some((table) => table.name === "takosumi_target_pools"),
  ).toBe(false);
  const usageEvents = plan.tables.find(
    (table) => table.name === "usage_events",
  );
  expect(usageEvents?.sql).toContain("CHECK");
  expect(
    usageEvents?.indexes.some(
      (index) => index.name.startsWith("sqlite_autoindex_") && index.unique,
    ),
  ).toBe(true);
  expect(usageEvents?.columns.every((column) => column.hidden === 0)).toBe(
    true,
  );
});

test("control D1 verify is read-only and accepts host extension tables", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(
        `create table cloud_extension_state (
          id text primary key,
          record_json text not null
        )`,
      )
      .run();
    await database
      .prepare(
        `create view cloud_extension_view as
         select id from cloud_extension_state`,
      )
      .run();
    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.status).toBe("ready");
    expect(verification.issues).toEqual([]);
    expect(verification.latestMigrationVersion).toBe(47);
  } finally {
    database.close();
  }
});

test("control D1 verification inventories triggers and views attached to OSS tables", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(
        `create trigger unexpected_workspace_trigger
         after insert on workspaces
         begin
           select 1;
         end`,
      )
      .run();
    await database
      .prepare(
        `create view unexpected_workspace_view as
         select id from workspaces`,
      )
      .run();
    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.status).toBe("mismatch");
    expect(verification.issues).toContain("schema_attached_object_mismatch");
  } finally {
    database.close();
  }
});

test("control D1 apply converges a fresh database and records every version", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "test",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
    });
    expect(applied.verification.status).toBe("ready");
    expect(applied.beforeMigrationVersions).toEqual([]);
    expect(applied.appliedMigrationVersions).toEqual(
      plan.migrations.map((migration) => migration.version),
    );
  } finally {
    database.close();
  }
});

test("control D1 fenced apply converges a populated v24 destructive schema", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(`delete from schema_migrations where version >= 25`)
      .run();
    await database
      .prepare(
        `alter table install_configs
         add column install_type text not null default 'opentofu_module'`,
      )
      .run();
    await database
      .prepare(
        `alter table install_configs
         add column trust_level text not null default 'trusted'`,
      )
      .run();
    await database.prepare(`drop table capsules`).run();
    await database
      .prepare(
        `create table capsules (
          id text primary key,
          space_id text not null,
          project_id text,
          name text not null,
          slug text not null,
          source_id text,
          install_type text not null,
          install_config_id text not null,
          environment text not null,
          current_state_version_id text,
          current_state_generation integer not null default 0,
          current_output_snapshot_id text,
          status text not null,
          record_json text not null,
          created_at text not null,
          updated_at text not null
        )`,
      )
      .run();
    await database.prepare(`drop table usage_events`).run();
    await database
      .prepare(
        `create table usage_events (
          id text primary key,
          space_id text not null,
          installation_id text,
          run_id text,
          meter_id text,
          resource_family text,
          resource_id text,
          operation text,
          resource_metadata_json text,
          kind text not null,
          quantity real not null,
          usd_micros integer,
          source text not null,
          idempotency_key text not null,
          created_at text not null
        )`,
      )
      .run();
    await database
      .prepare(`create table billing_accounts (id text primary key)`)
      .run();
    await database
      .prepare(
        `insert into workspaces
           (id, handle, record_json, created_at, updated_at)
         values ('ws_v24', 'v24', ?, ?, ?)`,
      )
      .bind(JSON.stringify({ id: "ws_v24", ownerUserId: "acct_v24" }), NOW, NOW)
      .run();
    await database
      .prepare(
        `insert into projects
           (id, workspace_id, name, slug, record_json, created_at, updated_at)
         values ('prj_default_ws_v24', 'ws_v24', 'Default', 'default', '{}', ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await database
      .prepare(
        `insert into install_configs
           (id, space_id, record_json, created_at, updated_at,
            install_type, trust_level)
         values ('cfg_v24', 'ws_v24', ?, ?, ?, 'opentofu_module', 'trusted')`,
      )
      .bind(
        JSON.stringify({
          id: "cfg_v24",
          installType: "opentofu_module",
          trustLevel: "trusted",
        }),
        NOW,
        NOW,
      )
      .run();
    await database
      .prepare(
        `insert into capsules (
           id, space_id, project_id, name, slug, source_id, install_type,
           install_config_id, environment, current_state_generation, status,
           record_json, created_at, updated_at
         ) values (
           'cap_v24', 'ws_v24', null, 'Demo', 'demo', null,
           'opentofu_module', 'cfg_v24', 'default', 0, 'active', ?, ?, ?
         )`,
      )
      .bind(
        JSON.stringify({ id: "cap_v24", installType: "opentofu_module" }),
        NOW,
        NOW,
      )
      .run();
    await database
      .prepare(
        `insert into usage_events (
           id, space_id, installation_id, kind, quantity, usd_micros, source,
           idempotency_key, created_at
         ) values (
           'usage_v24', 'ws_v24', 'cap_v24', 'request', 1, 999, 'legacy',
           'usage-v24', ?
         )`,
      )
      .bind(NOW)
      .run();
    await database
      .prepare(`insert into billing_accounts (id) values ('retired')`)
      .run();

    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "test",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
    });

    expect(applied.verification.status).toBe("ready");
    expect(applied.appliedMigrationVersions).toEqual(
      plan.migrations
        .filter((migration) => migration.version >= 25)
        .map((migration) => migration.version),
    );
    expect(
      await database
        .prepare(`select project_id from capsules where id = 'cap_v24'`)
        .first(),
    ).toEqual({ project_id: "prj_default_ws_v24" });
    expect(
      await database
        .prepare(
          `select usd_micros, rating_status
           from usage_events where id = 'usage_v24'`,
        )
        .first(),
    ).toEqual({ usd_micros: 0, rating_status: "unrated" });
    expect(
      await database
        .prepare(
          `select name from sqlite_master
           where type = 'table' and name = 'billing_accounts'`,
        )
        .first(),
    ).toBeNull();
  } finally {
    database.close();
  }
});

for (const fixture of [
  {
    environment: "staging",
    file: "staging-schema.sql",
    sha256: "1fa2455c3d880f99f727be07404190439a5588e492116df8c4dff6fd64e5c86e",
  },
  {
    environment: "production",
    file: "production-schema.sql",
    sha256: "76b930c0fde893d49ef9b9bf2738f9882103d5de0da18f134593e52f2f349848",
  },
] as const) {
  test(`control D1 candidate converges the ${fixture.environment} live v24 schema export`, async () => {
    const plan = await buildControlD1SchemaPlan();
    const database = new SqliteControlD1Database();
    const sql = await Bun.file(
      resolve(
        import.meta.dir,
        "../../fixtures/control-d1-live-v24",
        fixture.file,
      ),
    ).text();
    try {
      expect(await sha256Hex(sql)).toBe(fixture.sha256);
      database.exec(sql);
      for (const migration of plan.migrations.filter(
        (entry) => entry.version <= 24,
      )) {
        await database
          .prepare(
            `insert into schema_migrations (version, name, checksum, applied_at)
             values (?, ?, ?, ?)`,
          )
          .bind(migration.version, migration.name, migration.checksum, NOW)
          .run();
      }

      await seedLiveV24ConvergenceRows(database, fixture.environment);
      const before = await readLiveV24ConvergenceRows(database);
      const applied = await applyControlD1Schema(database, plan, {
        sourceCommit: SOURCE_COMMIT,
        environment: "test",
        activatedAt: NOW,
        releasedAt: () => NOW,
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {},
        retainMaintenanceFence: true,
      });

      expect(applied.maintenanceStatus).toBe("retained");
      expect(applied.verification.status).toBe("ready");
      expect(applied.appliedMigrationVersions).toEqual(
        plan.migrations
          .filter((entry) => entry.version >= 25)
          .map((entry) => entry.version),
      );
      for (const table of ["resource_shapes", "resolution_locks"] as const) {
        expect(
          await database
            .prepare(
              `select form_ref_json, package_digest from ${table} limit 1`,
            )
            .first(),
        ).toEqual({ form_ref_json: null, package_digest: null });
      }
      expect(await readLiveV24ConvergenceRows(database)).toEqual(before);
      await expect(
        database
          .prepare(
            `insert into workspaces
               (id, handle, record_json, created_at, updated_at)
             values ('blocked', 'blocked', '{}', ?, ?)`,
          )
          .bind(NOW, NOW)
          .run(),
      ).rejects.toThrow("takosumi control schema maintenance");
    } finally {
      database.close();
    }
  });
}

test("control D1 apply recovers a committed fence release after a lost response", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    let batchCalls = 0;
    const lostReleaseResponse: D1Database = {
      prepare(query) {
        return database.prepare(query);
      },
      async batch(statements) {
        batchCalls += 1;
        const result = await database.batch(statements);
        if (batchCalls === 2) throw new Error("lost release response");
        return result;
      },
    };

    const applied = await applyControlD1Schema(lostReleaseResponse, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "test",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
    });
    expect(batchCalls).toBe(2);
    expect(applied.verification.status).toBe("ready");
    expect((await verifyControlD1Schema(database, plan)).status).toBe("ready");
  } finally {
    database.close();
  }
});

test("control D1 verification detects CHECK drift with identical columns", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(`alter table usage_events rename to usage_events__with_check`)
      .run();
    await database
      .prepare(
        `create table usage_events (
          id text primary key,
          workspace_id text not null,
          capsule_id text,
          run_id text,
          meter_id text,
          resource_family text,
          resource_id text,
          operation text,
          resource_metadata_json text,
          kind text not null,
          quantity real not null,
          usd_micros integer not null,
          rating_status text not null,
          source text not null,
          idempotency_key text not null,
          created_at text not null
        )`,
      )
      .run();
    await database.prepare(`drop table usage_events__with_check`).run();
    await database
      .prepare(
        `create index usage_events_workspace_idx
         on usage_events (workspace_id)`,
      )
      .run();
    await database
      .prepare(`create index usage_events_run_idx on usage_events (run_id)`)
      .run();
    await database
      .prepare(
        `create unique index usage_events_idempotency_key_unique
         on usage_events (idempotency_key)`,
      )
      .run();

    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.status).toBe("mismatch");
    expect(verification.issues).toContain("schema_table_mismatch:usage_events");
  } finally {
    database.close();
  }
});

test("control D1 maintenance fence blocks direct writes and readiness", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        environment: "test",
      },
      NOW,
    );
    await expect(assertControlD1MaintenanceInactive(database)).rejects.toThrow(
      "maintenance_fence_active",
    );
    await expect(
      database
        .prepare(
          `insert into workspaces
             (id, handle, record_json, created_at, updated_at)
           values ('blocked', 'blocked', '{}', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.issues).toContain("maintenance_fence_active");
  } finally {
    database.close();
  }
});

test("control D1 maintenance guards user tables but never D1 internal _cf_KV", async () => {
  const database = new SqliteControlD1Database();
  try {
    await database
      .prepare(`create table "_cf_KV" (key text primary key, value text)`)
      .run();
    await database
      .prepare(`create table user_records (id text primary key, value text)`)
      .run();
    await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: `sha256:${"b".repeat(64)}`,
        environment: "test",
      },
      NOW,
    );

    const triggers = await database
      .prepare(
        `select name, tbl_name from sqlite_master
         where type = 'trigger' and name like '_takosumi_schema_fence_%'
         order by name`,
      )
      .all<{ readonly name: string; readonly tbl_name: string }>();
    expect(
      (triggers.results ?? []).filter((row) => row.tbl_name === "_cf_KV"),
    ).toEqual([]);
    expect(
      (triggers.results ?? [])
        .filter((row) => row.tbl_name === "user_records")
        .map((row) => row.name),
    ).toEqual([
      "_takosumi_schema_fence_user_records_delete",
      "_takosumi_schema_fence_user_records_insert",
      "_takosumi_schema_fence_user_records_update",
    ]);

    await expect(
      database
        .prepare(`insert into "_cf_KV" (key, value) values ('one', 'allowed')`)
        .run(),
    ).resolves.toMatchObject({ success: true });
    await expect(
      database
        .prepare(
          `insert into user_records (id, value) values ('one', 'blocked')`,
        )
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
  } finally {
    database.close();
  }
});

test("control D1 maintenance state fails closed on missing, contradictory, or malformed state", async () => {
  for (const corrupt of [
    `delete from _takosumi_control_schema_maintenance where singleton = 1`,
    `update _takosumi_control_schema_maintenance
     set active = 0, migration_bypass = 1, released_at = '${NOW}'
     where singleton = 1`,
    `update _takosumi_control_schema_maintenance
     set source_commit = 'malformed'
     where singleton = 1`,
  ]) {
    const database = new SqliteControlD1Database();
    try {
      await ensureD1OpenTofuLedgerSchema(database);
      await acquireControlD1MaintenanceFence(
        database,
        {
          sourceCommit: SOURCE_COMMIT,
          manifestDigest: `sha256:${"b".repeat(64)}`,
          environment: "test",
        },
        NOW,
      );
      await database.prepare(corrupt).run();
      await expect(
        assertControlD1MaintenanceInactive(database),
      ).rejects.toThrow("maintenance_fence_invalid");
      await expect(
        database
          .prepare(
            `insert into workspaces
               (id, handle, record_json, created_at, updated_at)
             values ('corrupt', 'corrupt', '{}', ?, ?)`,
          )
          .bind(NOW, NOW)
          .run(),
      ).rejects.toThrow("takosumi control schema maintenance");
    } finally {
      database.close();
    }
  }
});

test("legacy fence leaves the production v24 application schema and ledger immutable", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const sql = await Bun.file(
    resolve(
      import.meta.dir,
      "../../fixtures/control-d1-live-v24/production-schema.sql",
    ),
  ).text();
  try {
    database.exec(sql);
    for (const migration of plan.migrations.filter(
      (entry) => entry.version <= 24,
    )) {
      await database
        .prepare(
          `insert into schema_migrations (version, name, checksum, applied_at)
           values (?, ?, ?, ?)`,
        )
        .bind(migration.version, migration.name, migration.checksum, NOW)
        .run();
    }
    const before = await legacyApplicationSchemaSnapshot(database);
    const fenced = await fenceControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "production",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
    });

    expect(fenced.maintenanceFence.environment).toBe("production");
    expect(fenced.maintenanceFence.databaseRole).toBe("legacy");
    expect(fenced.maintenanceFence.releasePolicy).toBe("never");
    expect(await legacyApplicationSchemaSnapshot(database)).toEqual(before);
    expect(
      await database
        .prepare(`select max(version) as version from schema_migrations`)
        .first(),
    ).toEqual({ version: 24 });
    await expect(
      database
        .prepare(
          `insert into workspaces
             (id, handle, record_json, created_at, updated_at)
           values ('legacy-blocked', 'legacy-blocked', '{}', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
    await expect(
      releaseControlD1MaintenanceFence(database, fenced.maintenanceFence, NOW),
    ).rejects.toThrow("maintenance_fence_not_releasable");
    await expect(
      applyControlD1Schema(database, plan, {
        sourceCommit: SOURCE_COMMIT,
        environment: "production",
        activatedAt: NOW,
        releasedAt: () => NOW,
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {},
      }),
    ).rejects.toThrow("maintenance_fence_occupied");
    expect(await readControlD1MaintenanceState(database)).toMatchObject({
      status: "active",
      fence: { databaseRole: "legacy", releasePolicy: "never" },
    });
  } finally {
    database.close();
  }
});

test("control D1 verification fails closed on ledger and retired-table drift", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(
        `update schema_migrations
         set checksum = ?
         where version = 43`,
      )
      .bind(`sha256:${"0".repeat(64)}`)
      .run();
    await database
      .prepare(`create table workspace_output_sync (workspace_id text)`)
      .run();
    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.status).toBe("mismatch");
    expect(verification.issues).toContain("migration_ledger_mismatch");
    expect(verification.issues).toContain(
      "retired_table_present:workspace_output_sync",
    );
  } finally {
    database.close();
  }
});

test("control D1 CLI plan and apply dry-run never create a remote target", async () => {
  for (const argv of [
    ["plan"],
    ["apply", "--environment", "production", "--dry-run"],
  ]) {
    let remoteCalls = 0;
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      argv,
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => NOW,
        createRemoteDatabase: () => {
          remoteCalls += 1;
          throw new Error("remote must not be called");
        },
      },
    );
    expect(code).toBe(0);
    expect(remoteCalls).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      status: "planned",
      sourceCommit: SOURCE_COMMIT,
    });
  }
});

test("control D1 CLI verify reports a ready remote ledger", async () => {
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      ["verify", "--environment", "staging"],
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => NOW,
        createRemoteDatabase: () => ({
          database,
          configurationDigest: `sha256:${"1".repeat(64)}`,
        }),
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      mode: "verify",
      environment: "staging",
      status: "ready",
      verification: { latestMigrationVersion: 47 },
    });
  } finally {
    database.close();
  }
});

test("control D1 CLI apply requires exact manifest confirmation", async () => {
  const output: string[] = [];
  const code = await runControlD1SchemaCli(
    ["apply", "--environment", "production"],
    {},
    (value) => output.push(value),
    { sourceCommit: SOURCE_COMMIT, now: () => NOW },
  );
  expect(code).toBe(1);
  expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
    status: "failed",
    failureCode: "manifest_confirmation_required",
  });
});

test("control D1 CLI exposes stable maintenance codes without raw detail", async () => {
  const planOutput: string[] = [];
  expect(
    await runControlD1SchemaCli(
      ["plan"],
      {},
      (value) => planOutput.push(value),
      { sourceCommit: SOURCE_COMMIT, now: () => NOW },
    ),
  ).toBe(0);
  const manifestDigest = JSON.parse(planOutput.at(-1) ?? "{}")
    .manifestDigest as string;
  const output: string[] = [];
  const code = await runControlD1SchemaCli(
    ["apply", "--environment", "staging", "--confirm-manifest", manifestDigest],
    {},
    (value) => output.push(value),
    {
      sourceCommit: SOURCE_COMMIT,
      now: () => NOW,
      inspectSourceCheckout: async () => ({
        head: SOURCE_COMMIT,
        clean: true,
      }),
      createRemoteDatabase: () => {
        throw new ControlD1MaintenanceError(
          "maintenance_table_name_invalid:secret-token remote detail",
        );
      },
    },
  );
  expect(code).toBe(1);
  expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
    status: "failed",
    failureCode: "maintenance_table_name_invalid",
  });
  expect(output.join("\n")).not.toContain("secret-token");
  expect(output.join("\n")).not.toContain("remote detail");
});

test("control D1 CLI rejects a dirty source before opening the remote target", async () => {
  const planOutput: string[] = [];
  expect(
    await runControlD1SchemaCli(
      ["plan"],
      {},
      (value) => planOutput.push(value),
      { sourceCommit: SOURCE_COMMIT, now: () => NOW },
    ),
  ).toBe(0);
  const manifestDigest = JSON.parse(planOutput.at(-1) ?? "{}")
    .manifestDigest as string;
  let remoteCalls = 0;
  const output: string[] = [];
  const code = await runControlD1SchemaCli(
    ["apply", "--environment", "staging", "--confirm-manifest", manifestDigest],
    {},
    (value) => output.push(value),
    {
      sourceCommit: SOURCE_COMMIT,
      now: () => NOW,
      inspectSourceCheckout: async () => ({
        head: SOURCE_COMMIT,
        clean: false,
      }),
      createRemoteDatabase: () => {
        remoteCalls += 1;
        throw new Error("remote must not be opened");
      },
    },
  );
  expect(code).toBe(1);
  expect(remoteCalls).toBe(0);
  expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
    status: "failed",
    failureCode: "source_checkout_dirty",
  });
});

test("control D1 REST adapter emits the documented single and batch shapes", async () => {
  const requests: { readonly url: string; readonly body: unknown }[] = [];
  const database = new CloudflareControlD1RestDatabase({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "secret-token",
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Response.json({
        success: true,
        result: [{ success: true, results: [{ value: "ready" }] }],
      });
    },
  });

  const first = await database
    .prepare("select ? as value")
    .bind("ready")
    .first<{ readonly value: string }>();
  expect(first).toEqual({ value: "ready" });
  await database.batch([
    database.prepare("insert into demo (id) values (?)").bind("one"),
    database.prepare("insert into demo (id) values (?)").bind("two"),
  ]);

  expect(requests[0]).toEqual({
    url: "https://api.cloudflare.com/client/v4/accounts/account_123/d1/database/database_456/query",
    body: { sql: "select ? as value", params: ["ready"] },
  });
  expect(requests[1]?.body).toEqual({
    batch: [
      { sql: "insert into demo (id) values (?)", params: ["one"] },
      { sql: "insert into demo (id) values (?)", params: ["two"] },
    ],
  });
  expect(JSON.stringify(requests)).not.toContain("secret-token");
});

test("control D1 REST failures expose only a stable code", async () => {
  const database = new CloudflareControlD1RestDatabase({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "secret-token",
    fetch: async () =>
      Response.json(
        { success: false, errors: [{ message: "secret-token remote detail" }] },
        { status: 500 },
      ),
  });

  let failure: unknown;
  try {
    await database.prepare("select 1").all();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ControlD1RestError);
  expect(String(failure)).toContain("cloudflare_d1_query_failed");
  expect(String(failure)).not.toContain("secret-token");
  expect(String(failure)).not.toContain("remote detail");
});
