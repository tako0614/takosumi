import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const PG_FORM_MIGRATION_ID = "registry.service_forms.takoform_v0_identity";
const PG_RECOVERY_MIGRATION_ID = "resources.operation_recovery_state.add";
const D1_FORM_MIGRATION_VERSION = 54;
const D1_FORM_MIGRATION_NAME = "d1_service_form_takoform_v0_identity";
const D1_RECOVERY_MIGRATION_VERSION = 55;
const D1_RECOVERY_MIGRATION_NAME = "d1_resource_operation_recovery_state";
const D1_HOST_RETIREMENT_VERSION = 66;
const D1_HOST_RETIREMENT_NAME = "d1_retired_host_schema_drop_empty";
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const SCHEMA_DIGEST = `sha256:${"b".repeat(64)}`;
const LEGACY_FORM_REF = {
  apiVersion: "forms.takoform.com/v1alpha1",
  kind: "ObjectBucket",
  definitionVersion: "1.0.0",
  schemaDigest: SCHEMA_DIGEST,
};
const LEGACY_IDENTITY = {
  formRef: LEGACY_FORM_REF,
  packageDigest: PACKAGE_DIGEST,
};
const LEGACY_FORM_REF_KEY = [
  LEGACY_FORM_REF.apiVersion,
  LEGACY_FORM_REF.kind,
  LEGACY_FORM_REF.definitionVersion,
  LEGACY_FORM_REF.schemaDigest,
]
  .map(encodeURIComponent)
  .join("|");

function pgMigration(id: string) {
  const migration = postgresStorageMigrationStatements.find(
    (candidate) => candidate.id === id,
  );
  if (!migration) throw new Error(`missing migration ${id}`);
  return migration;
}

async function applyPg(db: PGlite, sql: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) await db.exec(statement);
}

async function pgTableExists(db: PGlite, table: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    `select to_regclass($1) is not null as present`,
    [table],
  );
  return result.rows[0]?.present === true;
}

async function pgColumns(db: PGlite, table: string): Promise<string[]> {
  const result = await db.query<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = current_schema() and table_name = $1
      order by ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

function expectColumns(
  actual: readonly string[],
  expected: readonly string[],
): void {
  for (const column of expected) expect(actual).toContain(column);
}

async function seedPgV95Schema(db: PGlite): Promise<void> {
  await db.exec(`
    create table takosumi_service_form_packages (
      package_digest text primary key,
      status text not null check (status in ('installed','deprecated','revoked')),
      record_json jsonb not null,
      installed_at text not null,
      updated_at text not null
    );
    create index takosumi_service_form_packages_status_updated_digest_idx
      on takosumi_service_form_packages (status, updated_at, package_digest);
    create table takosumi_service_form_definitions (
      form_ref_key text primary key,
      package_digest text not null,
      api_version text not null,
      kind text not null,
      definition_version text not null,
      schema_digest text not null,
      record_json jsonb not null,
      installed_at text not null,
      foreign key (package_digest)
        references takosumi_service_form_packages(package_digest)
    );
    create index takosumi_service_form_definitions_package_idx
      on takosumi_service_form_definitions (package_digest);
    create unique index takosumi_service_form_definitions_ref_package_unique
      on takosumi_service_form_definitions (form_ref_key, package_digest);
    create index takosumi_service_form_definitions_kind_installed_ref_idx
      on takosumi_service_form_definitions
        (kind, installed_at, form_ref_key);
    create table takosumi_service_form_activations (
      id text primary key,
      form_ref_key text not null,
      package_digest text not null,
      scope_type text not null check (scope_type in ('operator','workspace','space')),
      scope_id text,
      status text not null check (status in ('active','inactive')),
      revision integer not null check (revision >= 1),
      record_json jsonb not null,
      created_at text not null,
      updated_at text not null,
      foreign key (form_ref_key, package_digest)
        references takosumi_service_form_definitions
          (form_ref_key, package_digest)
    );
    create index takosumi_service_form_activations_scope_status_updated_id_idx
      on takosumi_service_form_activations
        (scope_type, scope_id, status, updated_at, id);
    create index takosumi_service_form_activations_identity_idx
      on takosumi_service_form_activations
        (form_ref_key, package_digest);
    create table takosumi_resource_shapes (
      id text primary key,
      form_ref_json jsonb,
      package_digest text
    );
    create table takosumi_resolution_locks (
      resource_id text primary key,
      form_ref_json jsonb,
      package_digest text,
      native_resources_json jsonb
    );
    create table takosumi_runs (
      id text primary key,
      run_json jsonb not null
    );
    create table takosumi_backups (
      id text primary key,
      backup_json jsonb not null
    );
  `);
}

async function seedPgLegacyEvidence(db: PGlite): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await db.query(
    `insert into takosumi_service_form_packages
       (package_digest, status, record_json, installed_at, updated_at)
     values ($1, 'installed', $2::jsonb, $3, $3)`,
    [
      PACKAGE_DIGEST,
      JSON.stringify({
        packageDigest: PACKAGE_DIGEST,
        definitionRefs: [LEGACY_FORM_REF],
      }),
      now,
    ],
  );
  await db.query(
    `insert into takosumi_service_form_definitions
       (form_ref_key, package_digest, api_version, kind, definition_version,
        schema_digest, record_json, installed_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      LEGACY_FORM_REF_KEY,
      PACKAGE_DIGEST,
      LEGACY_FORM_REF.apiVersion,
      LEGACY_FORM_REF.kind,
      LEGACY_FORM_REF.definitionVersion,
      LEGACY_FORM_REF.schemaDigest,
      JSON.stringify({ identity: LEGACY_IDENTITY, operations: ["read"] }),
      now,
    ],
  );
  await db.query(
    `insert into takosumi_service_form_activations
       (id, form_ref_key, package_digest, scope_type, scope_id, status,
        revision, record_json, created_at, updated_at)
     values ('activation_legacy', $1, $2, 'operator', null, 'active', 1,
             $3::jsonb, $4, $4)`,
    [
      LEGACY_FORM_REF_KEY,
      PACKAGE_DIGEST,
      JSON.stringify({
        id: "activation_legacy",
        identity: LEGACY_IDENTITY,
        scope: { type: "operator" },
      }),
      now,
    ],
  );
  await db.query(
    `insert into takosumi_resource_shapes
       (id, form_ref_json, package_digest)
     values ('resource_legacy', $1::jsonb, $2)`,
    [JSON.stringify(LEGACY_FORM_REF), PACKAGE_DIGEST],
  );
  await db.query(
    `insert into takosumi_resolution_locks
       (resource_id, form_ref_json, package_digest, native_resources_json)
     values ('resource_legacy', $1::jsonb, $2, $3::jsonb)`,
    [
      JSON.stringify(LEGACY_FORM_REF),
      PACKAGE_DIGEST,
      JSON.stringify([
        {
          type: "proof.object_bucket",
          id: "bucket_legacy",
          form: LEGACY_IDENTITY,
        },
      ]),
    ],
  );
}

test("Postgres takoform v0 migration archives an empty legacy schema and rolls it back without data loss", async () => {
  const migration = pgMigration(PG_FORM_MIGRATION_ID);
  expect(migration.down).toBeDefined();
  const db = new PGlite();
  try {
    await seedPgV95Schema(db);
    await applyPg(db, migration.sql);

    expectColumns(await pgColumns(db, "takosumi_service_form_definitions"), [
      "type",
      "version",
      "schema_digest",
    ]);
    expectColumns(
      await pgColumns(
        db,
        "takosumi_service_form_definitions__takoform_v1alpha1",
      ),
      ["api_version", "kind", "definition_version", "schema_digest"],
    );

    await applyPg(db, migration.down!);
    expectColumns(await pgColumns(db, "takosumi_service_form_definitions"), [
      "api_version",
      "kind",
      "definition_version",
      "schema_digest",
    ]);
    expect(
      await pgTableExists(
        db,
        "takosumi_service_form_definitions__takoform_v1alpha1",
      ),
    ).toBe(false);

    // A structural rollback followed by the same reviewed forward migration is
    // deterministic. Normal production re-entry is prevented by the migration
    // ledger before SQL execution.
    await applyPg(db, migration.sql);
    expectColumns(await pgColumns(db, "takosumi_service_form_definitions"), [
      "type",
      "version",
      "schema_digest",
    ]);
  } finally {
    await db.close();
  }
});

test("Postgres takoform v0 migration rejects populated legacy state before changing tables or pins", async () => {
  const migration = pgMigration(PG_FORM_MIGRATION_ID);
  const db = new PGlite();
  try {
    await seedPgV95Schema(db);
    await seedPgLegacyEvidence(db);

    await expect(applyPg(db, migration.sql)).rejects.toThrow(
      /TAKOFORM_V0_IDENTITY_MIGRATION_REQUIRED/,
    );

    expect(
      await pgTableExists(
        db,
        "takosumi_service_form_packages__takoform_v1alpha1",
      ),
    ).toBe(false);
    expectColumns(await pgColumns(db, "takosumi_service_form_definitions"), [
      "api_version",
      "kind",
      "definition_version",
    ]);
    const packageRows = await db.query<{ record_json: unknown }>(
      `select record_json from takosumi_service_form_packages`,
    );
    expect(packageRows.rows).toHaveLength(1);
    expect(packageRows.rows[0]?.record_json).toEqual({
      packageDigest: PACKAGE_DIGEST,
      definitionRefs: [LEGACY_FORM_REF],
    });
    const pin = await db.query<{
      form_ref_json: unknown;
      package_digest: string;
      native_resources_json: unknown;
    }>(
      `select r.form_ref_json, r.package_digest, l.native_resources_json
         from takosumi_resource_shapes r
         join takosumi_resolution_locks l on l.resource_id = r.id`,
    );
    expect(pin.rows[0]).toEqual({
      form_ref_json: LEGACY_FORM_REF,
      package_digest: PACKAGE_DIGEST,
      native_resources_json: [
        {
          type: "proof.object_bucket",
          id: "bucket_legacy",
          form: LEGACY_IDENTITY,
        },
      ],
    });
  } finally {
    await db.close();
  }
});

test("Postgres Resource operation recovery columns are additive and reversible", async () => {
  const migration = pgMigration(PG_RECOVERY_MIGRATION_ID);
  expect(migration.down).toBeDefined();
  const db = new PGlite();
  try {
    await db.exec(
      `create table takosumi_resource_shapes (
         id text primary key
       );
       insert into takosumi_resource_shapes (id) values ('resource_existing');`,
    );
    await applyPg(db, migration.sql);
    const row = await db.query<{
      revision: bigint;
      pending_operation_json: unknown;
      last_operation_run_id: string | null;
    }>(
      `select revision, pending_operation_json, last_operation_run_id
         from takosumi_resource_shapes
        where id = 'resource_existing'`,
    );
    expect(Number(row.rows[0]?.revision)).toBe(0);
    expect(row.rows[0]?.pending_operation_json).toBeNull();
    expect(row.rows[0]?.last_operation_run_id).toBeNull();

    await applyPg(db, migration.down!);
    expect(await pgColumns(db, "takosumi_resource_shapes")).toEqual(["id"]);
  } finally {
    await db.close();
  }
});

async function seedD1LegacyEvidence(db: SqliteFakeD1): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await db
    .prepare(
      `insert into service_form_packages
         (package_digest, status, record_json, installed_at, updated_at)
       values (?, 'installed', ?, ?, ?)`,
    )
    .bind(
      PACKAGE_DIGEST,
      JSON.stringify({
        packageDigest: PACKAGE_DIGEST,
        definitionRefs: [LEGACY_FORM_REF],
      }),
      now,
      now,
    )
    .run();
  await db
    .prepare(
      `insert into service_form_definitions
         (form_ref_key, package_digest, api_version, kind, definition_version,
          schema_digest, record_json, installed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      LEGACY_FORM_REF_KEY,
      PACKAGE_DIGEST,
      LEGACY_FORM_REF.apiVersion,
      LEGACY_FORM_REF.kind,
      LEGACY_FORM_REF.definitionVersion,
      LEGACY_FORM_REF.schemaDigest,
      JSON.stringify({ identity: LEGACY_IDENTITY, operations: ["read"] }),
      now,
    )
    .run();
  await db
    .prepare(
      `insert into service_form_activations
         (id, form_ref_key, package_digest, scope_type, scope_id, status,
          revision, record_json, created_at, updated_at)
       values ('activation_legacy', ?, ?, 'operator', null, 'active', 1, ?, ?, ?)`,
    )
    .bind(
      LEGACY_FORM_REF_KEY,
      PACKAGE_DIGEST,
      JSON.stringify({
        id: "activation_legacy",
        identity: LEGACY_IDENTITY,
        scope: { type: "operator" },
      }),
      now,
      now,
    )
    .run();
  await db
    .prepare(
      `insert into resource_shapes (
         id, space_id, kind, name, managed_by, spec_json, phase, generation,
         observed_generation, created_at, updated_at, form_ref_json,
         package_digest
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "resource_legacy",
      "workspace_legacy",
      "ObjectBucket",
      "assets",
      "takoform.form-host.v1",
      "{}",
      "Ready",
      1,
      1,
      now,
      now,
      JSON.stringify(LEGACY_FORM_REF),
      PACKAGE_DIGEST,
    )
    .run();
  await db
    .prepare(
      `insert into resolution_locks (
         resource_id, selected_implementation, target, locked, reason_json,
         native_resources_json, locked_at, updated_at, form_ref_json,
         package_digest
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "resource_legacy",
      "plugin:proof",
      "proof",
      1,
      "[]",
      JSON.stringify([
        {
          type: "proof.object_bucket",
          id: "bucket_legacy",
          form: LEGACY_IDENTITY,
        },
      ]),
      now,
      now,
      JSON.stringify(LEGACY_FORM_REF),
      PACKAGE_DIGEST,
    )
    .run();
}

test("D1 takoform v0 migration rejects populated legacy state and preserves registry and pins", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 53 });
  await seedD1LegacyEvidence(db);

  await expect(
    ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 54 }),
  ).rejects.toThrow(/TAKOFORM_V0_IDENTITY_MIGRATION_REQUIRED/);

  const packageCount = await db
    .prepare(`select count(*) as count from service_form_packages`)
    .first<{ count: number }>();
  expect(packageCount?.count).toBe(1);
  const packageRow = await db
    .prepare(
      `select record_json
         from service_form_packages
        where package_digest = ?`,
    )
    .bind(PACKAGE_DIGEST)
    .first<{ record_json: string }>();
  expect(JSON.parse(packageRow!.record_json)).toEqual({
    packageDigest: PACKAGE_DIGEST,
    definitionRefs: [LEGACY_FORM_REF],
  });
  const definitionColumns = await db
    .prepare(`pragma table_info(service_form_definitions)`)
    .all<{ name: string }>();
  expectColumns(
    definitionColumns.results.map((column) => column.name),
    ["api_version", "kind", "definition_version"],
  );
  const pin = await db
    .prepare(
      `select form_ref_json, package_digest
         from resource_shapes where id = 'resource_legacy'`,
    )
    .first<{ form_ref_json: string; package_digest: string }>();
  expect(JSON.parse(pin!.form_ref_json)).toEqual(LEGACY_FORM_REF);
  expect(pin?.package_digest).toBe(PACKAGE_DIGEST);
  const lock = await db
    .prepare(
      `select form_ref_json, package_digest, native_resources_json
         from resolution_locks where resource_id = 'resource_legacy'`,
    )
    .first<{
      form_ref_json: string;
      package_digest: string;
      native_resources_json: string;
    }>();
  expect(JSON.parse(lock!.form_ref_json)).toEqual(LEGACY_FORM_REF);
  expect(lock?.package_digest).toBe(PACKAGE_DIGEST);
  expect(JSON.parse(lock!.native_resources_json)).toEqual([
    {
      type: "proof.object_bucket",
      id: "bucket_legacy",
      form: LEGACY_IDENTITY,
    },
  ]);
  const archive = await db
    .prepare(
      `select name from sqlite_master
        where type = 'table'
          and name = 'service_form_packages__takoform_v1alpha1'`,
    )
    .first<{ name: string }>();
  expect(archive).toBeNull();
  const migration = await db
    .prepare(
      `select version from schema_migrations
        where version = ${D1_FORM_MIGRATION_VERSION}`,
    )
    .first<{ version: number }>();
  expect(migration).toBeNull();
});

test("D1 v55 historical prefix remains replayable before v66 retires the Host schema", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 55 });
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 55 });

  const currentColumns = await db
    .prepare(`pragma table_info(service_form_definitions)`)
    .all<{ name: string }>();
  expectColumns(
    currentColumns.results.map((column) => column.name),
    ["type", "version", "schema_digest"],
  );
  const archiveColumns = await db
    .prepare(
      `pragma table_info(service_form_definitions__takoform_v1alpha1)`,
    )
    .all<{ name: string }>();
  expectColumns(
    archiveColumns.results.map((column) => column.name),
    ["api_version", "kind", "definition_version", "schema_digest"],
  );
  const ledger = await db
    .prepare(
      `select version, name from schema_migrations
       where version in (${D1_FORM_MIGRATION_VERSION}, ${D1_RECOVERY_MIGRATION_VERSION})
       order by version`,
    )
    .all<{ version: number; name: string }>();
  expect(ledger.results).toEqual([
    {
      version: D1_FORM_MIGRATION_VERSION,
      name: D1_FORM_MIGRATION_NAME,
    },
    {
      version: D1_RECOVERY_MIGRATION_VERSION,
      name: D1_RECOVERY_MIGRATION_NAME,
    },
  ]);
  const resourceColumns = await db
    .prepare(`pragma table_info(resource_shapes)`)
    .all<{ name: string; notnull: number; dflt_value: string | null }>();
  expect(
    resourceColumns.results.find((column) => column.name === "revision"),
  ).toMatchObject({ notnull: 1, dflt_value: "0" });
  expectColumns(
    resourceColumns.results.map((column) => column.name),
    ["pending_operation_json", "last_operation_run_id"],
  );

  await ensureD1OpenTofuLedgerSchema(db);
  await ensureD1OpenTofuLedgerSchema(db);
  for (
    const table of [
      "resource_shapes",
      "resolution_locks",
      "service_form_packages",
      "service_form_definitions",
      "service_form_activations",
      "service_form_packages__takoform_v1alpha1",
      "service_form_definitions__takoform_v1alpha1",
      "service_form_activations__takoform_v1alpha1",
    ] as const
  ) {
    expect(
      await db
        .prepare(
          `select name from sqlite_master
           where type = 'table' and name = ?`,
        )
        .bind(table)
        .first(),
      table,
    ).toBeNull();
  }
  expect(
    await db
      .prepare(
        `select version, name from schema_migrations
         where version = ${D1_HOST_RETIREMENT_VERSION}`,
      )
      .first(),
  ).toEqual({
    version: D1_HOST_RETIREMENT_VERSION,
    name: D1_HOST_RETIREMENT_NAME,
  });
});

test("D1 v54 replay safely records a lost ledger response after proving both registries empty", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 54 });
  await db
    .prepare(
      `delete from schema_migrations
        where version = ${D1_FORM_MIGRATION_VERSION}`,
    )
    .run();

  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 54 });

  const ledger = await db
    .prepare(
      `select version, name from schema_migrations
        where version = ${D1_FORM_MIGRATION_VERSION}`,
    )
    .first<{ version: number; name: string }>();
  expect(ledger).toEqual({
    version: D1_FORM_MIGRATION_VERSION,
    name: D1_FORM_MIGRATION_NAME,
  });
  for (
    const table of [
      "service_form_packages",
      "service_form_definitions",
      "service_form_activations",
      "service_form_packages__takoform_v1alpha1",
      "service_form_definitions__takoform_v1alpha1",
      "service_form_activations__takoform_v1alpha1",
    ] as const
  ) {
    const row = await db
      .prepare(`select count(*) as count from ${table}`)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  }
});
