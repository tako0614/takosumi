/**
 * Boot-convergence tests for the D1 OpenTofu ledger schema mechanism.
 *
 * Guards the P0 invariant that makes the 17-noun rename (P4) safe: guarded
 * table renames run BEFORE the final-name `create table if not exists`
 * ensure-DDL, and the same boot path converges on fresh, existing, and
 * already-renamed databases without bricking the control DB.
 */
import { expect, test } from "bun:test";

import {
  applyD1GuardedTableRenames,
  createCloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
  verifyD1OpenTofuLedgerSchemaPredeployed,
} from "../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import {
  acquireControlD1MaintenanceFence,
  assertControlD1MaintenanceInactive,
  readControlD1MaintenanceGuardInventory,
  readControlD1MaintenanceReleaseReceiptDetails,
  releaseControlD1MaintenanceFence,
} from "../../../worker/src/d1_schema_maintenance.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

async function tableNames(db: SqliteFakeD1): Promise<Set<string>> {
  const result = await db
    .prepare(`select name from sqlite_master where type = 'table'`)
    .all<{ name: string }>();
  return new Set((result.results ?? []).map((row) => row.name));
}

async function indexNames(
  db: SqliteFakeD1,
  table: string,
): Promise<Set<string>> {
  const result = await db
    .prepare(
      `select name from sqlite_master
       where type = 'index' and tbl_name = ? and sql is not null`,
    )
    .bind(table)
    .all<{ name: string }>();
  return new Set((result.results ?? []).map((row) => row.name));
}

async function rowsForTable(
  db: SqliteFakeD1,
  table: string,
): Promise<readonly Record<string, unknown>[]> {
  const result = await db
    .prepare(`select * from ${table}`)
    .all<Record<string, unknown>>();
  return result.results ?? [];
}

test("ensureD1OpenTofuLedgerSchema converges on a fresh database", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const tables = await tableNames(db);
  for (const expected of [
    "workspaces",
    "projects",
    "sources",
    "capsules",
    "connections",
  ]) {
    expect(tables.has(expected)).toBe(true);
  }
});

test("v68 adds nullable compatibility declarations without upgrading legacy evidence", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 67 });
  expect(
    await d1ColumnNamesForTest(db, "capsule_compatibility_reports"),
  ).not.toContain("root_module_variable_declarations_json");
  await db
    .prepare(
      `insert into capsule_compatibility_reports (
         id, source_id, source_snapshot_id, module_path, level,
         findings_json, providers_json, resources_json, data_sources_json,
         provisioners_json, root_module_variables_json,
         root_module_outputs_json, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "caprep_v67_legacy_declarations",
      "source_v67_legacy_declarations",
      "snapshot_v67_legacy_declarations",
      ".",
      "ready",
      "[]",
      JSON.stringify({ providerPackages: [], rootProviderRequirements: [] }),
      "[]",
      "[]",
      "[]",
      JSON.stringify(["project_name"]),
      "[]",
      "2026-09-05T00:00:00.000Z",
    )
    .run();

  await ensureD1OpenTofuLedgerSchema(db);

  expect(
    await d1ColumnNamesForTest(db, "capsule_compatibility_reports"),
  ).toContain("root_module_variable_declarations_json");
  expect(
    await db
      .prepare(
        `select root_module_variable_declarations_json as declarations
         from capsule_compatibility_reports
         where id = ?`,
      )
      .bind("caprep_v67_legacy_declarations")
      .first(),
  ).toEqual({ declarations: null });
  expect(
    await db
      .prepare(
        `select version, name, checksum from schema_migrations
         where version = 68`,
      )
      .first(),
  ).toEqual({
    version: 68,
    name: "d1_capsule_compatibility_variable_declarations",
    checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
  });
  const store = createCloudflareD1OpenTofuControlStore(db, {
    schemaMode: "predeployed",
  });
  const report = await store.getCapsuleCompatibilityReport(
    "caprep_v67_legacy_declarations",
  );
  expect(report).toBeDefined();
  expect(
    report
      ? Object.hasOwn(report, "rootModuleVariableDeclarations")
      : undefined,
  ).toBe(false);
});

test("v61/v62 create an empty Resource identity fence without historical backfill", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 60 });
  await db
    .prepare(
      `insert into resource_shapes (
         id, space_id, kind, name, managed_by, spec_json, phase,
         generation, observed_generation, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "resource_identity_fence_legacy",
      "workspace_identity_fence",
      "ObjectBucket",
      "legacy",
      "user",
      "{}",
      "Ready",
      7,
      7,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    )
    .run();

  expect((await tableNames(db)).has("resource_identity_fences")).toBe(false);
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 62 });

  expect(await rowsForTable(db, "resource_identity_fences")).toEqual([]);
  expect(
    await db
      .prepare(
        `select generation from resource_shapes
         where id = 'resource_identity_fence_legacy'`,
      )
      .first(),
  ).toEqual({ generation: 7 });
  expect(
    await db
      .prepare(`select version, name from schema_migrations where version = 62`)
      .first(),
  ).toEqual({
    version: 62,
    name: "d1_resource_identity_fence_owner_receipt",
  });
  expect(await d1ColumnNamesForTest(db, "resource_identity_fences")).toContain(
    "retired_owner_json",
  );
});

test("v63 adds indexed personal bootstrap identity without marking existing personal rows", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 62 });
  const oldest = {
    id: "workspace_existing_oldest",
    handle: "existing-oldest",
    displayName: "Existing oldest",
    type: "personal",
    ownerUserId: "owner_existing",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const newer = {
    ...oldest,
    id: "workspace_existing_newer",
    handle: "existing-newer",
    displayName: "Existing newer",
    createdAt: "2026-08-01T00:01:00.000Z",
    updatedAt: "2026-08-01T00:01:00.000Z",
  };
  for (const workspace of [oldest, newer]) {
    await db
      .prepare(
        `insert into workspaces
           (id, handle, record_json, created_at, updated_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(
        workspace.id,
        workspace.handle,
        JSON.stringify(workspace),
        workspace.createdAt,
        workspace.updatedAt,
      )
      .run();
  }

  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 63 });

  const workspaceIndexes = await indexNames(db, "workspaces");
  expect(workspaceIndexes.has("workspaces_owner_type_created_idx")).toBe(true);
  expect(
    workspaceIndexes.has("workspaces_personal_bootstrap_owner_unique"),
  ).toBe(true);
  expect(
    await db
      .prepare(
        `select id, owner_user_id, workspace_type,
                personal_bootstrap_owner_id
         from workspaces
         where owner_user_id = ? and workspace_type = 'personal'
         order by created_at, id`,
      )
      .bind(oldest.ownerUserId)
      .all(),
  ).toMatchObject({
    results: [
      {
        id: oldest.id,
        owner_user_id: oldest.ownerUserId,
        workspace_type: "personal",
        personal_bootstrap_owner_id: null,
      },
      {
        id: newer.id,
        owner_user_id: newer.ownerUserId,
        workspace_type: "personal",
        personal_bootstrap_owner_id: null,
      },
    ],
  });
});

test("v60 restores populated current and archived Service Form rows with inline parent keys", async () => {
  const db = new SqliteFakeD1();
  const now = "2026-08-01T00:00:00.000Z";
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 59 });

  await db
    .prepare(
      `insert into service_form_packages
         (package_digest, status, record_json, installed_at, updated_at)
       values (?, 'installed', ?, ?, ?)`,
    )
    .bind("pkg_current", '{"package":"current"}', now, now)
    .run();
  await db
    .prepare(
      `insert into service_form_packages__takoform_v1alpha1
         (package_digest, status, record_json, installed_at, updated_at)
       values (?, 'installed', ?, ?, ?)`,
    )
    .bind("pkg_archive", '{"package":"archive"}', now, now)
    .run();
  await db
    .prepare(
      `insert into service_form_definitions
         (form_ref_key, package_digest, type, version, schema_digest,
          record_json, installed_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "form_current",
      "pkg_current",
      "ObjectBucket",
      "1.0.0",
      "sha256:current",
      '{"definition":"current"}',
      now,
    )
    .run();
  await db
    .prepare(
      `insert into service_form_activations
         (id, form_ref_key, package_digest, scope_type, scope_id, status,
          revision, record_json, created_at, updated_at)
       values (?, ?, ?, 'operator', null, 'active', 1, ?, ?, ?)`,
    )
    .bind(
      "activation_current",
      "form_current",
      "pkg_current",
      '{"activation":"current"}',
      now,
      now,
    )
    .run();
  await db
    .prepare(
      `insert into service_form_definitions__takoform_v1alpha1
         (form_ref_key, package_digest, api_version, kind,
          definition_version, schema_digest, record_json, installed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "form_archive",
      "pkg_archive",
      "forms.takoform.com/v1alpha1",
      "ObjectBucket",
      "1.0.0",
      "sha256:archive",
      '{"definition":"archive"}',
      now,
    )
    .run();
  await db
    .prepare(
      `insert into service_form_activations__takoform_v1alpha1
         (id, form_ref_key, package_digest, scope_type, scope_id, status,
          revision, record_json, created_at, updated_at)
       values (?, ?, ?, 'operator', null, 'active', 2, ?, ?, ?)`,
    )
    .bind(
      "activation_archive",
      "form_archive",
      "pkg_archive",
      '{"activation":"archive"}',
      now,
      now,
    )
    .run();

  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 60 });

  expect(await rowsForTable(db, "service_form_definitions")).toEqual([
    {
      form_ref_key: "form_current",
      package_digest: "pkg_current",
      type: "ObjectBucket",
      version: "1.0.0",
      schema_digest: "sha256:current",
      record_json: '{"definition":"current"}',
      installed_at: now,
    },
  ]);
  expect(await rowsForTable(db, "service_form_activations")).toEqual([
    {
      id: "activation_current",
      form_ref_key: "form_current",
      package_digest: "pkg_current",
      scope_type: "operator",
      scope_id: null,
      status: "active",
      revision: 1,
      record_json: '{"activation":"current"}',
      created_at: now,
      updated_at: now,
    },
  ]);
  expect(
    await rowsForTable(db, "service_form_definitions__takoform_v1alpha1"),
  ).toEqual([
    {
      form_ref_key: "form_archive",
      package_digest: "pkg_archive",
      api_version: "forms.takoform.com/v1alpha1",
      kind: "ObjectBucket",
      definition_version: "1.0.0",
      schema_digest: "sha256:archive",
      record_json: '{"definition":"archive"}',
      installed_at: now,
    },
  ]);
  expect(
    await rowsForTable(db, "service_form_activations__takoform_v1alpha1"),
  ).toEqual([
    {
      id: "activation_archive",
      form_ref_key: "form_archive",
      package_digest: "pkg_archive",
      scope_type: "operator",
      scope_id: null,
      status: "active",
      revision: 2,
      record_json: '{"activation":"archive"}',
      created_at: now,
      updated_at: now,
    },
  ]);

  for (const [table, externalIndex] of [
    ["service_form_definitions", "service_form_definitions_ref_package_unique"],
    [
      "service_form_definitions__takoform_v1alpha1",
      "service_form_definitions__takoform_v1alpha1_ref_package_unique",
    ],
  ] as const) {
    expect(await indexNames(db, table)).not.toContain(externalIndex);
  }
  expect(await indexNames(db, "service_form_definitions")).toEqual(
    new Set([
      "service_form_definitions_package_idx",
      "service_form_definitions_type_installed_ref_idx",
    ]),
  );
  expect(await indexNames(db, "service_form_activations")).toEqual(
    new Set([
      "service_form_activations_scope_status_updated_id_idx",
      "service_form_activations_identity_idx",
    ]),
  );
  expect(
    await indexNames(db, "service_form_definitions__takoform_v1alpha1"),
  ).toEqual(
    new Set([
      "service_form_definitions__takoform_v1alpha1_package_idx",
      "service_form_definitions__takoform_v1alpha1_kind_installed_ref_idx",
    ]),
  );
  expect(
    await indexNames(db, "service_form_activations__takoform_v1alpha1"),
  ).toEqual(
    new Set([
      "service_form_activations__takoform_v1alpha1_scope_status_updated_id_idx",
      "service_form_activations__takoform_v1alpha1_identity_idx",
    ]),
  );
  expect((await db.prepare(`pragma foreign_key_check`).all()).results).toEqual(
    [],
  );
  expect(
    await db
      .prepare(`select version, name from schema_migrations where version = 60`)
      .first(),
  ).toEqual({
    version: 60,
    name: "d1_service_form_restore_safe_unique_constraints",
  });

  expect(() =>
    db
      .prepare(
        `insert into service_form_activations
           (id, form_ref_key, package_digest, scope_type, scope_id, status,
            revision, record_json, created_at, updated_at)
         values ('activation_bad_fk', 'form_current', 'pkg_missing',
                 'operator', null, 'active', 1, '{}', ?, ?)`,
      )
      .bind(now, now)
      .run(),
  ).toThrow(/foreign key/i);

  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 60 });
  expect(
    await db
      .prepare(
        `select count(*) as count from schema_migrations where version = 60`,
      )
      .first<{ readonly count: number }>(),
  ).toEqual({ count: 1 });
  expect(await rowsForTable(db, "service_form_activations")).toHaveLength(1);
  expect(
    await rowsForTable(db, "service_form_activations__takoform_v1alpha1"),
  ).toHaveLength(1);
});

test("v60 Service Form rebuild rolls back all shadow tables on a batch failure", async () => {
  const db = new SqliteFakeD1();
  const now = "2026-08-01T00:00:00.000Z";
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 59 });
  await db
    .prepare(
      `insert into service_form_packages
         (package_digest, status, record_json, installed_at, updated_at)
       values ('pkg_rollback', 'installed', '{}', ?, ?)`,
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      `insert into service_form_definitions
         (form_ref_key, package_digest, type, version, schema_digest,
          record_json, installed_at)
       values ('form_rollback', 'pkg_rollback', 'ObjectBucket', '1',
               'sha256:rollback', '{}', ?)`,
    )
    .bind(now)
    .run();
  await db.prepare(`drop table service_form_activations`).run();
  await db
    .prepare(
      `create table service_form_activations (
        id text primary key,
        form_ref_key text not null,
        package_digest text not null,
        scope_type text not null,
        scope_id text,
        status text not null,
        revision integer not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (form_ref_key, package_digest)
          references service_form_definitions(form_ref_key, package_digest)
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into service_form_activations
         (id, form_ref_key, package_digest, scope_type, scope_id, status,
          revision, record_json, created_at, updated_at)
       values ('activation_rollback', 'form_rollback', 'pkg_rollback',
               'invalid', null, 'active', 1, '{}', ?, ?)`,
    )
    .bind(now, now)
    .run();

  expect(ensureD1OpenTofuLedgerSchema(db)).rejects.toThrow(
    /check constraint failed/i,
  );
  expect(await tableNames(db)).not.toContain(
    "service_form_definitions__takosumi_v60",
  );
  expect(await tableNames(db)).not.toContain(
    "service_form_activations__takosumi_v60",
  );
  expect(await tableNames(db)).not.toContain(
    "service_form_definitions__takoform_v1alpha1__takosumi_v60",
  );
  expect(await tableNames(db)).not.toContain(
    "service_form_activations__takoform_v1alpha1__takosumi_v60",
  );
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 60`)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare(
        `select form_ref_key, package_digest
           from service_form_definitions where form_ref_key = 'form_rollback'`,
      )
      .first(),
  ).toEqual({ form_ref_key: "form_rollback", package_digest: "pkg_rollback" });
});

test("v57 migrates observability into the canonical D1 lineage", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 56 });
  expect((await tableNames(db)).has("takosumi_observability_metrics")).toBe(
    false,
  );

  await db
    .prepare(
      `create table takosumi_observability_metrics (
        id text primary key,
        name text not null,
        kind text not null,
        value real not null,
        tags_json text,
        space_id text,
        group_id text,
        actor_json text,
        payload_json text,
        observed_at text not null,
        request_id text,
        correlation_id text,
        created_at text not null default current_timestamp
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into takosumi_observability_metrics
         (id, name, kind, value, observed_at)
       values ('metric_legacy', 'legacy', 'counter', 1, ?)`,
    )
    .bind("2026-07-29T00:00:00.000Z")
    .run();

  await ensureD1OpenTofuLedgerSchema(db);

  const tables = await tableNames(db);
  for (const table of [
    "takosumi_observability_audit",
    "takosumi_observability_metrics",
    "takosumi_observability_traces",
  ]) {
    expect(tables.has(table)).toBe(true);
  }
  expect(await indexNames(db, "takosumi_observability_audit")).toEqual(
    new Set(["takosumi_observability_audit_occurred_idx"]),
  );
  expect(await indexNames(db, "takosumi_observability_metrics")).toEqual(
    new Set([
      "takosumi_observability_metrics_name_idx",
      "takosumi_observability_metrics_observed_idx",
      "takosumi_observability_metrics_space_idx",
    ]),
  );
  expect(await indexNames(db, "takosumi_observability_traces")).toEqual(
    new Set([
      "takosumi_observability_traces_space_idx",
      "takosumi_observability_traces_started_idx",
      "takosumi_observability_traces_trace_idx",
    ]),
  );
  expect(
    await db
      .prepare(
        `select id, name, kind, value, unit
         from takosumi_observability_metrics where id = 'metric_legacy'`,
      )
      .first(),
  ).toEqual({
    id: "metric_legacy",
    name: "legacy",
    kind: "counter",
    value: 1,
    unit: null,
  });
  expect(
    await db
      .prepare(`select version, name from schema_migrations where version = 57`)
      .first(),
  ).toEqual({ version: 57, name: "d1_observability_schema" });
});

test("v58 adds Interface authorization indexes without rewriting rows", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 57 });
  expect(await indexNames(db, "interfaces")).not.toContain(
    "interfaces_authorized_page_idx",
  );
  expect(await indexNames(db, "interface_bindings")).not.toContain(
    "interface_bindings_authorized_current_idx",
  );

  await db
    .prepare(
      `insert into interfaces (
         id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
         generation, resolved_revision, record_json, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "if_v58",
      "workspace_v58",
      "Capsule",
      "capsule_v58",
      "launcher",
      "interface.ui.surface",
      "Resolved",
      1,
      1,
      '{"interface":"preserved"}',
      "2026-07-29T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
    )
    .run();
  await db
    .prepare(
      `insert into interface_bindings (
         id, workspace_id, interface_id, subject_kind, subject_id, phase,
         generation, record_json, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "ifbind_v58",
      "workspace_v58",
      "if_v58",
      "Principal",
      "principal_v58",
      "Ready",
      1,
      '{"binding":"preserved"}',
      "2026-07-29T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
    )
    .run();

  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 58 });

  expect(await indexNames(db, "interfaces")).toContain(
    "interfaces_authorized_page_idx",
  );
  expect(await indexNames(db, "interface_bindings")).toContain(
    "interface_bindings_authorized_current_idx",
  );
  expect(
    await db
      .prepare(`select record_json from interfaces where id = 'if_v58'`)
      .first(),
  ).toEqual({ record_json: '{"interface":"preserved"}' });
  expect(
    await db
      .prepare(
        `select record_json from interface_bindings
         where id = 'ifbind_v58'`,
      )
      .first(),
  ).toEqual({ record_json: '{"binding":"preserved"}' });
  expect(
    await db
      .prepare(`select version, name from schema_migrations where version = 58`)
      .first(),
  ).toEqual({
    version: 58,
    name: "d1_interface_authorization_indexes",
  });
});

test("retired provider_envs/provider_catalog tables are renamed aside, not live", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const tables = await tableNames(db);
  // The live Provider Catalog / Provider Env tables are retired (migration 16
  // renames them aside). The historical chain still materializes them on a fresh
  // DB, so the rename-aside leaves the `_retired` names present and recoverable.
  expect(tables.has("provider_envs")).toBe(false);
  expect(tables.has("provider_catalog")).toBe(false);
  expect(tables.has("provider_envs_retired")).toBe(true);
  expect(tables.has("provider_catalog_retired")).toBe(true);
});

test("ensureD1OpenTofuLedgerSchema is idempotent across reboots", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  // A second (and third) boot against the now-populated schema must not throw.
  await ensureD1OpenTofuLedgerSchema(db);
  await ensureD1OpenTofuLedgerSchema(db);
  const tables = await tableNames(db);
  expect(tables.has("capsules")).toBe(true);
});

test("predeployed verification is strictly read-only", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const queries: string[] = [];
  const readOnlyDb: D1Database = {
    prepare(query) {
      queries.push(query.trim());
      if (!/^(?:select|pragma)\b/iu.test(query.trim())) {
        throw new Error("predeployed verification attempted a write");
      }
      return db.prepare(query);
    },
    async batch() {
      throw new Error("predeployed verification attempted a batch");
    },
  };

  await verifyD1OpenTofuLedgerSchemaPredeployed(readOnlyDb);
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((query) => /^(?:select|pragma)\b/iu.test(query))).toBe(
    true,
  );
});

test("predeployed verification accepts only the exact current v68 ledger", async () => {
  const predecessor = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(predecessor, {
    throughMigrationVersion: 62,
  });
  await expect(
    verifyD1OpenTofuLedgerSchemaPredeployed(predecessor),
  ).rejects.toThrow("D1 OpenTofu predeployed schema verification failed");
  expect(
    (await indexNames(predecessor, "workspaces")).has(
      "workspaces_personal_bootstrap_owner_unique",
    ),
  ).toBe(false);

  const current = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(current);
  await verifyD1OpenTofuLedgerSchemaPredeployed(current);
  expect((await tableNames(current)).has("resource_identity_fences")).toBe(
    false,
  );

  const tooOld = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(tooOld, { throughMigrationVersion: 61 });
  await expect(verifyD1OpenTofuLedgerSchemaPredeployed(tooOld)).rejects.toThrow(
    "D1 OpenTofu predeployed schema verification failed",
  );

  const missing = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(missing);
  await missing
    .prepare(`delete from schema_migrations where version = 43`)
    .run();
  await expect(
    verifyD1OpenTofuLedgerSchemaPredeployed(missing),
  ).rejects.toThrow("D1 OpenTofu predeployed schema verification failed");

  const extra = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(extra);
  await extra
    .prepare(
      `insert into schema_migrations (version, name, checksum, applied_at)
       values (69, 'unexpected', ?, '2026-08-05T00:00:00.000Z')`,
    )
    .bind(`sha256:${"f".repeat(64)}`)
    .run();
  await expect(verifyD1OpenTofuLedgerSchemaPredeployed(extra)).rejects.toThrow(
    "D1 OpenTofu predeployed schema verification failed",
  );
});

test("predeployed maintenance readiness uses one direct indexed read", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const fence = await acquireControlD1MaintenanceFence(
    db,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "test",
      databaseRole: "in_place",
      releasePolicy: "in_place",
    },
    "2026-07-16T00:00:00.000Z",
  );
  await releaseControlD1MaintenanceFence(db, fence, "2026-07-16T00:01:00.000Z");
  const queries: string[] = [];
  const observed: D1Database = {
    prepare(query) {
      queries.push(query.trim());
      return db.prepare(query);
    },
    batch: db.batch.bind(db),
  };

  await assertControlD1MaintenanceInactive(observed);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("where singleton = 1");
  expect(queries[0]).not.toContain("sqlite_master");
});

test("maintenance release accepts missing transport meta only with the exact durable null-digest receipt", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const fence = await acquireControlD1MaintenanceFence(
    db,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "test",
      databaseRole: "in_place",
      releasePolicy: "in_place",
    },
    "2026-07-16T00:00:00.000Z",
  );
  const imported: D1Database = {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      const results = await db.batch(statements);
      return results.map((result) => ({
        success: result.success,
        ...(result.results ? { results: result.results } : {}),
      }));
    },
  };
  const releasedAt = "2026-07-16T00:01:00.000Z";

  await releaseControlD1MaintenanceFence(imported, fence, releasedAt);

  expect(await readControlD1MaintenanceReleaseReceiptDetails(db)).toEqual({
    fence,
    releasedAt,
    releaseReadinessDigest: null,
  });
  expect(await readControlD1MaintenanceGuardInventory(db)).toMatchObject({
    guardTriggerCount: 0,
    triggers: [],
    triggerSqlDigests: [],
  });
});

test("predeployed exact Workspace reads readiness and data in one statement", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const initialFence = await acquireControlD1MaintenanceFence(
    db,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "test",
      databaseRole: "in_place",
      releasePolicy: "in_place",
    },
    "2026-08-15T00:00:00.000Z",
  );
  await releaseControlD1MaintenanceFence(
    db,
    initialFence,
    "2026-08-15T00:00:01.000Z",
  );
  const workspace = {
    id: "ws_exact_batched",
    handle: "exact-batched",
    displayName: "Exact batched",
    ownerUserId: "account_exact_batched",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
  await db
    .prepare(
      `insert into workspaces
         (id, handle, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?)`,
    )
    .bind(
      workspace.id,
      workspace.handle,
      JSON.stringify(workspace),
      workspace.createdAt,
      workspace.updatedAt,
    )
    .run();
  let prepareCalls = 0;
  let batchCalls = 0;
  const queries: string[] = [];
  const observed: D1Database = {
    prepare(query) {
      prepareCalls += 1;
      queries.push(query);
      return db.prepare(query);
    },
    async batch(statements) {
      batchCalls += 1;
      return await db.batch(statements);
    },
  };

  const firstStore = createCloudflareD1OpenTofuControlStore(observed, {
    schemaMode: "predeployed",
  });
  expect(await firstStore.getWorkspace(workspace.id)).toEqual(workspace);

  const secondStore = createCloudflareD1OpenTofuControlStore(observed, {
    schemaMode: "predeployed",
  });
  expect(await secondStore.getWorkspace(workspace.id)).toEqual(workspace);
  expect(prepareCalls).toBe(2);
  expect(batchCalls).toBe(0);
  expect(queries[0]).toContain("pragma_table_info('schema_migrations')");
  expect(queries[0]).toContain("FROM workspaces");
  expect(queries[1]).not.toContain("pragma_table_info('schema_migrations')");

  await acquireControlD1MaintenanceFence(
    db,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "test",
      databaseRole: "in_place",
      releasePolicy: "in_place",
    },
    "2026-08-15T00:01:00.000Z",
  );
  const fencedStore = createCloudflareD1OpenTofuControlStore(observed, {
    schemaMode: "predeployed",
  });
  await expect(fencedStore.getWorkspace(workspace.id)).rejects.toThrow(
    "maintenance_fence_active",
  );
  expect(prepareCalls).toBe(3);
  expect(batchCalls).toBe(0);
});

test("predeployed account Workspace page reads readiness, total, and data in one statement", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const fence = await acquireControlD1MaintenanceFence(
    db,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "test",
      databaseRole: "in_place",
      releasePolicy: "in_place",
    },
    "2026-07-16T00:00:00.000Z",
  );
  await releaseControlD1MaintenanceFence(db, fence, "2026-07-16T00:01:00.000Z");
  const workspace = {
    id: "ws_batched",
    handle: "batched",
    displayName: "Batched",
    ownerUserId: "account_batched",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
  await db
    .prepare(
      `insert into workspaces
         (id, handle, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?)`,
    )
    .bind(
      workspace.id,
      workspace.handle,
      JSON.stringify(workspace),
      workspace.createdAt,
      workspace.updatedAt,
    )
    .run();
  await db
    .prepare(
      `insert into workspace_members
         (id, workspace_id, account_id, status, record_json, created_at, updated_at)
       values (?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(
      "wsm_batched",
      workspace.id,
      workspace.ownerUserId,
      JSON.stringify({
        id: "wsm_batched",
        workspaceId: workspace.id,
        accountId: workspace.ownerUserId,
        roles: ["owner"],
        status: "active",
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      }),
      workspace.createdAt,
      workspace.updatedAt,
    )
    .run();
  const newerWorkspace = {
    ...workspace,
    id: "ws_batched_newer",
    handle: "batched-newer",
    displayName: "Batched newer",
    createdAt: "2026-07-16T00:01:00.000Z",
    updatedAt: "2026-07-16T00:01:00.000Z",
  };
  await db
    .prepare(
      `insert into workspaces
         (id, handle, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?)`,
    )
    .bind(
      newerWorkspace.id,
      newerWorkspace.handle,
      JSON.stringify(newerWorkspace),
      newerWorkspace.createdAt,
      newerWorkspace.updatedAt,
    )
    .run();
  await db
    .prepare(
      `insert into workspace_members
         (id, workspace_id, account_id, status, record_json, created_at, updated_at)
       values (?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(
      "wsm_batched_newer",
      newerWorkspace.id,
      newerWorkspace.ownerUserId,
      JSON.stringify({
        id: "wsm_batched_newer",
        workspaceId: newerWorkspace.id,
        accountId: newerWorkspace.ownerUserId,
        roles: ["owner"],
        status: "active",
        createdAt: newerWorkspace.createdAt,
        updatedAt: newerWorkspace.updatedAt,
      }),
      newerWorkspace.createdAt,
      newerWorkspace.updatedAt,
    )
    .run();
  let prepareCalls = 0;
  let batchCalls = 0;
  const queries: string[] = [];
  const observed: D1Database = {
    prepare(query) {
      prepareCalls += 1;
      queries.push(query);
      return db.prepare(query);
    },
    async batch(statements) {
      batchCalls += 1;
      return await db.batch(statements);
    },
  };
  const firstStore = createCloudflareD1OpenTofuControlStore(observed, {
    schemaMode: "predeployed",
  });

  const first = await firstStore.listWorkspacesForAccountPage(
    workspace.ownerUserId,
    {
      includeArchived: true,
      includeTotal: true,
      order: "updated_desc",
      limit: 1,
    },
  );
  expect(first.items.map((item) => item.id)).toEqual([newerWorkspace.id]);
  expect(first.total).toBe(2);
  expect(first.nextCursor).toBeString();
  // The platform constructs a new store per request. A warm isolate must reuse
  // the immutable schema proof through the shared D1 binding while still
  // executing the per-request maintenance-fence read.
  const secondStore = createCloudflareD1OpenTofuControlStore(observed, {
    schemaMode: "predeployed",
  });
  const second = await secondStore.listWorkspacesForAccountPage(
    workspace.ownerUserId,
    {
      includeArchived: true,
      includeTotal: true,
      order: "updated_desc",
      cursor: first.nextCursor,
      limit: 1,
    },
  );

  expect(prepareCalls).toBe(2);
  expect(batchCalls).toBe(0);
  expect(queries[0]).toContain("pragma_table_info('schema_migrations')");
  expect(queries[1]).not.toContain("pragma_table_info('schema_migrations')");
  expect(second.items.map((item) => item.id)).toEqual([workspace.id]);
  expect(second.total).toBe(2);
  expect(second.nextCursor).toBeUndefined();
});

test("predeployed account Workspace statement fails closed on an active fence", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await acquireControlD1MaintenanceFence(
    db,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "test",
      databaseRole: "in_place",
      releasePolicy: "in_place",
    },
    "2026-07-16T00:00:00.000Z",
  );
  let prepareCalls = 0;
  let batchCalls = 0;
  const observed: D1Database = {
    prepare(query) {
      prepareCalls += 1;
      return db.prepare(query);
    },
    async batch(statements) {
      batchCalls += 1;
      return await db.batch(statements);
    },
  };
  const store = createCloudflareD1OpenTofuControlStore(observed, {
    schemaMode: "predeployed",
  });

  await expect(
    store.listWorkspacesForAccountPage("account_batched", {
      includeArchived: true,
      includeTotal: false,
      order: "updated_desc",
      limit: 100,
    }),
  ).rejects.toThrow("maintenance_fence_active");
  expect(prepareCalls).toBe(1);
  expect(batchCalls).toBe(0);
});

test("predeployed store fails closed without request-time bootstrap", async () => {
  const db = new SqliteFakeD1();
  const store = createCloudflareD1OpenTofuControlStore(db, {
    schemaMode: "predeployed",
  });

  await expect(store.listWorkspaces()).rejects.toThrow(
    "D1 OpenTofu predeployed schema verification failed",
  );
  expect((await tableNames(db)).has("workspaces")).toBe(false);
  expect((await tableNames(db)).has("schema_migrations")).toBe(false);
});

test("a warmed store observes a newly acquired maintenance fence", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const store = createCloudflareD1OpenTofuControlStore(db, {
    schemaMode: "predeployed",
  });
  expect(await store.listWorkspaces()).toEqual([]);

  await acquireControlD1MaintenanceFence(
    db,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "test",
    },
    "2026-07-16T00:00:00.000Z",
  );

  await expect(store.listWorkspaces()).rejects.toThrow(
    "maintenance_fence_active",
  );
});

test("predeployed verification rejects checksum drift", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await db
    .prepare(`update schema_migrations set checksum = ? where version = 43`)
    .bind(`sha256:${"0".repeat(64)}`)
    .run();

  await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db)).rejects.toThrow(
    "D1 OpenTofu predeployed schema verification failed",
  );
});

test("destructive usage migration and ledger insert roll back and retry atomically", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await db.prepare(`drop table usage_events`).run();
  await db
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
        source text not null,
        idempotency_key text not null,
        created_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into usage_events (
         id, workspace_id, kind, quantity, usd_micros, source,
         idempotency_key, created_at
       ) values ('usage_retry', 'ws_retry', 'request', 1, 123, 'legacy',
                 'usage-retry', '2026-07-16T00:00:00.000Z')`,
    )
    .run();
  await db.prepare(`delete from schema_migrations where version = 39`).run();

  let injected = false;
  const failingDb: D1Database = {
    prepare(query) {
      return db.prepare(query);
    },
    async batch(statements) {
      if (!injected && statements.length > 2) {
        injected = true;
        return await db.batch([
          ...statements.slice(0, -1),
          db.prepare(`insert into table_that_does_not_exist values (1)`),
          statements.at(-1)!,
        ]);
      }
      return await db.batch(statements);
    },
  };

  await expect(ensureD1OpenTofuLedgerSchema(failingDb)).rejects.toThrow();
  expect(injected).toBe(true);
  expect(await d1ColumnNamesForTest(db, "usage_events")).not.toContain(
    "rating_status",
  );
  expect(
    await db
      .prepare(`select usd_micros from usage_events where id = 'usage_retry'`)
      .first(),
  ).toEqual({ usd_micros: 123 });
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 39`)
      .first(),
  ).toBeNull();

  await ensureD1OpenTofuLedgerSchema(db);
  expect(await d1ColumnNamesForTest(db, "usage_events")).toContain(
    "rating_status",
  );
  expect(
    await db
      .prepare(
        `select usd_micros, rating_status
         from usage_events where id = 'usage_retry'`,
      )
      .first(),
  ).toEqual({ usd_micros: 0, rating_status: "unrated" });
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 39`)
      .first(),
  ).toEqual({ version: 39 });
});

async function d1ColumnNamesForTest(
  db: SqliteFakeD1,
  table: string,
): Promise<readonly string[]> {
  const result = await db
    .prepare(`pragma table_info(${table})`)
    .all<{ readonly name: string }>();
  return (result.results ?? []).map((row) => row.name);
}

test("install config metadata converges to the canonical store key", async () => {
  const db = new SqliteFakeD1();
  await db
    .prepare(
      `create table install_configs (
        id text primary key,
        space_id text,
        install_type text not null,
        trust_level text not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    )
    .run();
  const retiredOnly = {
    id: "icfg_retired_only",
    name: "retired-only",
    catalog: { inputs: [{ name: "public_subdomain" }] },
  };
  const both = {
    id: "icfg_both",
    name: "both",
    catalog: { inputs: [{ name: "stale" }] },
    store: { inputs: [{ name: "current" }] },
  };
  for (const config of [retiredOnly, both]) {
    await db
      .prepare(
        `insert into install_configs
          (id, space_id, install_type, trust_level, record_json, created_at, updated_at)
         values (?, null, 'opentofu_module', 'trusted', ?, ?, ?)`,
      )
      .bind(
        config.id,
        JSON.stringify(config),
        "2026-07-10T00:00:00.000Z",
        "2026-07-10T00:00:00.000Z",
      )
      .run();
  }

  await ensureD1OpenTofuLedgerSchema(db);

  const rows = await db
    .prepare(`select id, record_json from install_configs order by id`)
    .all<{ id: string; record_json: string }>();
  const configs = new Map(
    (rows.results ?? []).map((row) => [row.id, JSON.parse(row.record_json)]),
  );
  expect(configs.get("icfg_retired_only")).toMatchObject({
    store: { inputs: [{ name: "public_subdomain" }] },
  });
  expect(configs.get("icfg_both")).toMatchObject({
    store: { inputs: [{ name: "current" }] },
  });
  expect(configs.get("icfg_retired_only")).not.toHaveProperty("catalog");
  expect(configs.get("icfg_both")).not.toHaveProperty("catalog");
});

test("connections is created exactly once (no duplicate ensure-DDL)", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  // bun:sqlite would have thrown on a duplicate `create table` without
  // `if not exists`; assert the table is present and single in sqlite_master.
  const result = await db
    .prepare(
      `select count(*) as n from sqlite_master where type = 'table' and name = 'connections'`,
    )
    .first<{ n: number }>();
  expect(result?.n).toBe(1);
});

test("applyD1GuardedTableRenames renames an existing table and preserves rows", async () => {
  const db = new SqliteFakeD1();
  await db.prepare(`create table old_demo (id text primary key, v text)`).run();
  await db.prepare(`insert into old_demo (id, v) values ('a', 'keep')`).run();

  await applyD1GuardedTableRenames(db, [{ from: "old_demo", to: "new_demo" }]);

  const tables = await tableNames(db);
  expect(tables.has("new_demo")).toBe(true);
  expect(tables.has("old_demo")).toBe(false);
  const row = await db
    .prepare(`select v from new_demo where id = 'a'`)
    .first<{ v: string }>();
  expect(row?.v).toBe("keep");
});

test("applyD1GuardedTableRenames is a no-op when the source is absent (fresh DB)", async () => {
  const db = new SqliteFakeD1();
  await applyD1GuardedTableRenames(db, [{ from: "old_demo", to: "new_demo" }]);
  const tables = await tableNames(db);
  expect(tables.has("new_demo")).toBe(false);
  expect(tables.has("old_demo")).toBe(false);
});

test("applyD1GuardedTableRenames is a no-op when the target already exists", async () => {
  const db = new SqliteFakeD1();
  await db.prepare(`create table new_demo (id text primary key, v text)`).run();
  await db.prepare(`insert into new_demo (id, v) values ('a', 'final')`).run();
  // A stale source left behind must NOT clobber the already-renamed target.
  await db.prepare(`create table old_demo (id text primary key, v text)`).run();
  await db.prepare(`insert into old_demo (id, v) values ('a', 'stale')`).run();

  await applyD1GuardedTableRenames(db, [{ from: "old_demo", to: "new_demo" }]);

  const row = await db
    .prepare(`select v from new_demo where id = 'a'`)
    .first<{ v: string }>();
  expect(row?.v).toBe("final");
});
