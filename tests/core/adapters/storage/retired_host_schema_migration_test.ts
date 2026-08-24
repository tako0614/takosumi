import { expect, test } from "bun:test";
import { Client as PostgresClient } from "pg";

import { buildControlD1SchemaPlan } from "../../../../deploy/platform/control_d1_schema.ts";
import { StorageMigrationRunner } from "../../../../core/adapters/storage/migration-runner/mod.ts";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import type {
  SqlClient,
  SqlQueryResult,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import {
  D1_RETIRED_HOST_SCHEMA_RETIREMENT_STATEMENTS,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import {
  PGliteSqlClient,
  splitSqlStatements,
} from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const D1_RETIRED_HOST_TABLES = [
  "offering_catalogs",
  "portable_host_idempotency",
  "resource_identity_fences",
  "resource_shapes",
  "resolution_locks",
  "service_form_activations",
  "service_form_activations__takoform_v1alpha1",
  "service_form_definitions",
  "service_form_definitions__takoform_v1alpha1",
  "service_form_packages",
  "service_form_packages__takoform_v1alpha1",
  "space_policies",
  "target_pools",
] as const;

const POSTGRES_RETIRED_HOST_TABLES = [
  "takosumi_offering_catalogs",
  "takosumi_resource_identity_fences",
  "takosumi_resource_shapes",
  "takosumi_resolution_locks",
  "takosumi_service_form_activations",
  "takosumi_service_form_activations__takoform_v1alpha1",
  "takosumi_service_form_definitions",
  "takosumi_service_form_definitions__takoform_v1alpha1",
  "takosumi_service_form_packages",
  "takosumi_service_form_packages__takoform_v1alpha1",
  "takosumi_space_policies",
  "takosumi_target_pools",
] as const;

const POSTGRES_RETIREMENT_LOCK_TABLES = [
  "takosumi_interface_bindings",
  "takosumi_interfaces",
  ...POSTGRES_RETIRED_HOST_TABLES,
] as const;

const RETAINED_INTERFACE_COLUMNS = [
  "id",
  "workspace_id",
  "owner_kind",
  "owner_id",
  "name",
  "interface_type",
  "phase",
  "generation",
  "resolved_revision",
  "oauth_resource_uri",
  "record_json",
  "created_at",
  "updated_at",
] as const;

const RETAINED_INTERFACE_BINDING_COLUMNS = [
  "id",
  "workspace_id",
  "interface_id",
  "subject_kind",
  "subject_id",
  "phase",
  "generation",
  "record_json",
  "created_at",
  "updated_at",
] as const;

const historicalPostgresCatalogDigest =
  "sha256:b3524023b8193396319bd208491fcd2b12729d681ed50a239a750ec75e45dda3";
const historicalD1CatalogDigest =
  "sha256:95ce6c8fb12de29f662ad6a5c45a63f9c6bc600150cc2d6fd8092eb88a023edd";
const disposablePostgresUrl =
  process.env.TAKOSUMI_TEST_DISPOSABLE_POSTGRES_URL?.trim() ?? "";

test("historical Host migration identities remain byte-identical", async () => {
  const postgresPlan = await new StorageMigrationRunner(emptySqlClient(), {
    migrations: postgresStorageMigrationStatements.filter(
      (migration) => migration.version <= 109,
    ),
  }).plan();
  expect(
    sha256(
      JSON.stringify(
        postgresPlan.pending.map(({ migration, checksum }) => ({
          id: migration.id,
          version: migration.version,
          checksum,
        })),
      ),
    ),
  ).toBe(historicalPostgresCatalogDigest);

  const d1Plan = await buildControlD1SchemaPlan();
  expect(
    sha256(
      JSON.stringify(
        d1Plan.migrations.filter((migration) => migration.version <= 65),
      ),
    ),
  ).toBe(historicalD1CatalogDigest);
});

test("retirement preflights every retired table before the first physical drop", () => {
  const d1Sql = D1_RETIRED_HOST_SCHEMA_RETIREMENT_STATEMENTS.join("\n");
  const d1FirstDrop = d1Sql.indexOf("drop table");
  expect(d1FirstDrop).toBeGreaterThan(0);
  for (const table of D1_RETIRED_HOST_TABLES) {
    const preflight = d1Sql.indexOf(`select 1 from ${table}`);
    expect(preflight, `D1 preflight for ${table}`).toBeGreaterThan(0);
    expect(preflight, `D1 preflight precedes drops for ${table}`).toBeLessThan(
      d1FirstDrop,
    );
  }

  const postgresSql = postgresStorageMigrationStatements.find(
    (migration) => migration.version === 110,
  )?.sql;
  expect(postgresSql).toBeDefined();
  const postgresStatements = splitSqlStatements(postgresSql!);
  const lockStatement = postgresStatements[0] ?? "";
  expect(/^lock\s+table\b/iu.test(lockStatement)).toBe(true);
  expect(
    lockStatement
      .replace(/^lock table\s+/iu, "")
      .replace(/\s+in access exclusive mode$/iu, "")
      .split(",")
      .map((table) => table.trim()),
  ).toEqual(POSTGRES_RETIREMENT_LOCK_TABLES);
  expect(postgresStatements[1]?.toLowerCase().startsWith("do ")).toBe(true);

  const postgresFirstDrop = postgresSql!.indexOf("drop table");
  expect(postgresFirstDrop).toBeGreaterThan(0);
  for (const table of POSTGRES_RETIRED_HOST_TABLES) {
    const preflight = postgresSql!.indexOf(`select 1 from ${table}`);
    expect(preflight, `Postgres preflight for ${table}`).toBeGreaterThan(0);
    expect(
      preflight,
      `Postgres preflight precedes drops for ${table}`,
    ).toBeLessThan(postgresFirstDrop);
  }
});

test("D1 v66 blocks exact retained Resource/Form evidence atomically and preserves benign generic rows", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 65 });

  await insertD1Interface(db, {
    id: "interface_benign",
    recordJson: genericInterfaceRecord("interface_benign"),
  });
  await insertD1Binding(db, {
    id: "binding_benign",
    interfaceId: "interface_benign",
    recordJson: genericBindingRecord("binding_benign", "interface_benign"),
  });
  await insertD1Interface(db, {
    id: "interface_benign_capsule",
    ownerKind: "Capsule",
    recordJson: genericInterfaceRecord("interface_benign_capsule", {
      ownerKind: "Capsule",
      materializedFrom: { source: "capsule_blueprint", key: "primary" },
    }),
  });
  await insertD1Binding(db, {
    id: "binding_benign_capsule",
    interfaceId: "interface_benign_capsule",
    subjectKind: "Capsule",
    recordJson: genericBindingRecord(
      "binding_benign_capsule",
      "interface_benign_capsule",
      { subjectKind: "Capsule" },
    ),
  });

  const interfaceBlockers = [
    {
      id: "interface_resource_column",
      ownerKind: "Resource",
      recordJson: genericInterfaceRecord("interface_resource_column"),
    },
    {
      id: "interface_resource_record",
      recordJson: genericInterfaceRecord("interface_resource_record", {
        ownerKind: "Resource",
      }),
    },
    {
      id: "interface_form_columns",
      recordJson: genericInterfaceRecord("interface_form_columns"),
      formRefKey: "form://legacy/1",
      formSchemaDigest: "sha256:legacy",
      descriptorName: "legacy.http",
      descriptorVersion: "1",
    },
    {
      id: "interface_form_record",
      recordJson: genericInterfaceRecord("interface_form_record", {
        materializedFrom: {
          source: "form_descriptor",
          formRefKey: "form://legacy/1",
          formSchemaDigest: "sha256:legacy",
          descriptorName: "legacy.http",
          descriptorVersion: "1",
        },
      }),
    },
    {
      id: "interface_resource_input",
      recordJson: genericInterfaceRecord("interface_resource_input", {
        inputSource: "resource_output",
      }),
    },
    {
      id: "interface_resource_provenance",
      recordJson: genericInterfaceRecord("interface_resource_provenance", {
        provenanceSource: "resource_output",
      }),
    },
    {
      id: "interface_non_object_record",
      recordJson: "Resource form_descriptor resource_output",
    },
    {
      id: "interface_malformed_object_record",
      recordJson: { note: "missing the required Interface structure" },
    },
    {
      id: "interface_malformed_record",
      recordJson: "{not-json",
      rawRecordJson: true,
    },
  ] as const;

  for (const blocker of interfaceBlockers) {
    await insertD1Interface(db, blocker);
    const before = await d1FullRow(db, "interfaces", blocker.id);
    await expect(ensureD1OpenTofuLedgerSchema(db)).rejects.toThrow(
      /retained_interface_host_evidence_requires_operator_disposition/u,
    );
    expect(await d1FullRow(db, "interfaces", blocker.id)).toEqual(before);
    await expectD1RetirementNotAdvanced(db);
    await db.prepare(`delete from interfaces where id = ?`).bind(blocker.id).run();
  }

  const bindingBlockers = [
    {
      id: "binding_resource_column",
      subjectKind: "Resource",
      recordJson: genericBindingRecord(
        "binding_resource_column",
        "interface_benign",
      ),
    },
    {
      id: "binding_resource_record",
      recordJson: genericBindingRecord(
        "binding_resource_record",
        "interface_benign",
        { subjectKind: "Resource" },
      ),
    },
    {
      id: "binding_form_record",
      recordJson: genericBindingRecord(
        "binding_form_record",
        "interface_benign",
        { materializedFromSource: "form_host_descriptor" },
      ),
    },
    {
      id: "binding_resource_materialization_record",
      recordJson: genericBindingRecord(
        "binding_resource_materialization_record",
        "interface_benign",
        { materializedFromSource: "capsule_resource_binding" },
      ),
    },
    {
      id: "binding_non_object_record",
      recordJson: "Resource form_host_descriptor",
    },
    {
      id: "binding_malformed_object_record",
      recordJson: { note: "missing the required Binding structure" },
    },
    {
      id: "binding_malformed_record",
      recordJson: "{not-json",
      rawRecordJson: true,
    },
  ] as const;

  for (const blocker of bindingBlockers) {
    await insertD1Binding(db, {
      ...blocker,
      interfaceId: "interface_benign",
    });
    const before = await d1FullRow(db, "interface_bindings", blocker.id);
    await expect(ensureD1OpenTofuLedgerSchema(db)).rejects.toThrow(
      /retained_interface_host_evidence_requires_operator_disposition/u,
    );
    expect(await d1FullRow(db, "interface_bindings", blocker.id)).toEqual(
      before,
    );
    await expectD1RetirementNotAdvanced(db);
    await db
      .prepare(`delete from interface_bindings where id = ?`)
      .bind(blocker.id)
      .run();
  }

  const interfaceBefore = await d1RetainedRow(
    db,
    "interfaces",
    RETAINED_INTERFACE_COLUMNS,
    "interface_benign",
  );
  const bindingBefore = await d1RetainedRow(
    db,
    "interface_bindings",
    RETAINED_INTERFACE_BINDING_COLUMNS,
    "binding_benign",
  );
  const capsuleInterfaceBefore = await d1RetainedRow(
    db,
    "interfaces",
    RETAINED_INTERFACE_COLUMNS,
    "interface_benign_capsule",
  );
  const capsuleBindingBefore = await d1RetainedRow(
    db,
    "interface_bindings",
    RETAINED_INTERFACE_BINDING_COLUMNS,
    "binding_benign_capsule",
  );

  await ensureD1OpenTofuLedgerSchema(db);

  expect(
    await d1RetainedRow(
      db,
      "interfaces",
      RETAINED_INTERFACE_COLUMNS,
      "interface_benign",
    ),
  ).toEqual(interfaceBefore);
  expect(
    await d1RetainedRow(
      db,
      "interface_bindings",
      RETAINED_INTERFACE_BINDING_COLUMNS,
      "binding_benign",
    ),
  ).toEqual(bindingBefore);
  expect(
    await d1RetainedRow(
      db,
      "interfaces",
      RETAINED_INTERFACE_COLUMNS,
      "interface_benign_capsule",
    ),
  ).toEqual(capsuleInterfaceBefore);
  expect(
    await d1RetainedRow(
      db,
      "interface_bindings",
      RETAINED_INTERFACE_BINDING_COLUMNS,
      "binding_benign_capsule",
    ),
  ).toEqual(capsuleBindingBefore);
  expect(await d1Columns(db, "interfaces")).toEqual(RETAINED_INTERFACE_COLUMNS);
  await expectD1RetirementAdvanced(db);
});

test("Postgres v110 blocks exact retained Resource/Form evidence atomically and preserves benign generic rows", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(109);
  const retirement = postgresStorageMigrationStatements.find(
    (migration) => migration.version === 110,
  );
  expect(retirement).toBeDefined();
  try {
    await insertPostgresInterface(client, {
      id: "interface_benign",
      recordJson: genericInterfaceRecord("interface_benign"),
    });
    await insertPostgresBinding(client, {
      id: "binding_benign",
      interfaceId: "interface_benign",
      recordJson: genericBindingRecord("binding_benign", "interface_benign"),
    });
    await insertPostgresInterface(client, {
      id: "interface_benign_capsule",
      ownerKind: "Capsule",
      recordJson: genericInterfaceRecord("interface_benign_capsule", {
        ownerKind: "Capsule",
        materializedFrom: { source: "capsule_blueprint", key: "primary" },
      }),
    });
    await insertPostgresBinding(client, {
      id: "binding_benign_capsule",
      interfaceId: "interface_benign_capsule",
      subjectKind: "Capsule",
      recordJson: genericBindingRecord(
        "binding_benign_capsule",
        "interface_benign_capsule",
        { subjectKind: "Capsule" },
      ),
    });

    const interfaceBlockers = [
      {
        id: "interface_resource_column",
        ownerKind: "Resource",
        recordJson: genericInterfaceRecord("interface_resource_column"),
      },
      {
        id: "interface_resource_record",
        recordJson: genericInterfaceRecord("interface_resource_record", {
          ownerKind: "Resource",
        }),
      },
      {
        id: "interface_form_columns",
        recordJson: genericInterfaceRecord("interface_form_columns"),
        formRefKey: "form://legacy/1",
        formSchemaDigest: "sha256:legacy",
        descriptorName: "legacy.http",
        descriptorVersion: "1",
      },
      {
        id: "interface_form_record",
        recordJson: genericInterfaceRecord("interface_form_record", {
          materializedFrom: {
            source: "form_descriptor",
            formRefKey: "form://legacy/1",
            formSchemaDigest: "sha256:legacy",
            descriptorName: "legacy.http",
            descriptorVersion: "1",
          },
        }),
      },
      {
        id: "interface_resource_input",
        recordJson: genericInterfaceRecord("interface_resource_input", {
          inputSource: "resource_output",
        }),
      },
      {
        id: "interface_resource_provenance",
        recordJson: genericInterfaceRecord("interface_resource_provenance", {
          provenanceSource: "resource_output",
        }),
      },
      {
        id: "interface_non_object_record",
        recordJson: "Resource form_descriptor resource_output",
      },
      {
        id: "interface_malformed_object_record",
        recordJson: { note: "missing the required Interface structure" },
      },
    ] as const;

    for (const blocker of interfaceBlockers) {
      await insertPostgresInterface(client, blocker);
      const before = await postgresFullRow(client, "takosumi_interfaces", blocker.id);
      await expectPostgresRetirementBlocked(client, retirement!.sql);
      expect(
        await postgresFullRow(client, "takosumi_interfaces", blocker.id),
      ).toEqual(before);
      await client.exec(
        `delete from takosumi_interfaces where id = '${blocker.id}'`,
      );
    }

    const bindingBlockers = [
      {
        id: "binding_resource_column",
        subjectKind: "Resource",
        recordJson: genericBindingRecord(
          "binding_resource_column",
          "interface_benign",
        ),
      },
      {
        id: "binding_resource_record",
        recordJson: genericBindingRecord(
          "binding_resource_record",
          "interface_benign",
          { subjectKind: "Resource" },
        ),
      },
      {
        id: "binding_form_record",
        recordJson: genericBindingRecord(
          "binding_form_record",
          "interface_benign",
          { materializedFromSource: "form_host_descriptor" },
        ),
      },
      {
        id: "binding_resource_materialization_record",
        recordJson: genericBindingRecord(
          "binding_resource_materialization_record",
          "interface_benign",
          { materializedFromSource: "capsule_resource_binding" },
        ),
      },
      {
        id: "binding_non_object_record",
        recordJson: "Resource form_host_descriptor",
      },
      {
        id: "binding_malformed_object_record",
        recordJson: { note: "missing the required Binding structure" },
      },
    ] as const;

    for (const blocker of bindingBlockers) {
      await insertPostgresBinding(client, {
        ...blocker,
        interfaceId: "interface_benign",
      });
      const before = await postgresFullRow(
        client,
        "takosumi_interface_bindings",
        blocker.id,
      );
      await expectPostgresRetirementBlocked(client, retirement!.sql);
      expect(
        await postgresFullRow(
          client,
          "takosumi_interface_bindings",
          blocker.id,
        ),
      ).toEqual(before);
      await client.exec(
        `delete from takosumi_interface_bindings where id = '${blocker.id}'`,
      );
    }

    const interfaceBefore = await postgresRetainedRow(
      client,
      "takosumi_interfaces",
      RETAINED_INTERFACE_COLUMNS,
      "interface_benign",
    );
    const bindingBefore = await postgresRetainedRow(
      client,
      "takosumi_interface_bindings",
      RETAINED_INTERFACE_BINDING_COLUMNS,
      "binding_benign",
    );
    const capsuleInterfaceBefore = await postgresRetainedRow(
      client,
      "takosumi_interfaces",
      RETAINED_INTERFACE_COLUMNS,
      "interface_benign_capsule",
    );
    const capsuleBindingBefore = await postgresRetainedRow(
      client,
      "takosumi_interface_bindings",
      RETAINED_INTERFACE_BINDING_COLUMNS,
      "binding_benign_capsule",
    );
    await applyPostgresRetirement(client, retirement!.sql);
    expect(
      await postgresRetainedRow(
        client,
        "takosumi_interfaces",
        RETAINED_INTERFACE_COLUMNS,
        "interface_benign",
      ),
    ).toEqual(interfaceBefore);
    expect(
      await postgresRetainedRow(
        client,
        "takosumi_interface_bindings",
        RETAINED_INTERFACE_BINDING_COLUMNS,
        "binding_benign",
      ),
    ).toEqual(bindingBefore);
    expect(
      await postgresRetainedRow(
        client,
        "takosumi_interfaces",
        RETAINED_INTERFACE_COLUMNS,
        "interface_benign_capsule",
      ),
    ).toEqual(capsuleInterfaceBefore);
    expect(
      await postgresRetainedRow(
        client,
        "takosumi_interface_bindings",
        RETAINED_INTERFACE_BINDING_COLUMNS,
        "binding_benign_capsule",
      ),
    ).toEqual(capsuleBindingBefore);
    expect(
      new Set(await postgresColumns(client, "takosumi_interfaces")),
    ).toEqual(new Set(RETAINED_INTERFACE_COLUMNS));
  } finally {
    await client.close();
  }
});

test.skipIf(!disposablePostgresUrl)(
  "Postgres v110 blocks a writer between preflight and drop without silent row loss",
  async () => {
    const retirement = postgresStorageMigrationStatements.find(
      (migration) => migration.version === 110,
    );
    expect(retirement).toBeDefined();
    const statements = splitSqlStatements(retirement!.sql);
    const schema = `retired_host_race_${crypto.randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const admin = new PostgresClient({ connectionString: disposablePostgresUrl });
    const migrator = new PostgresClient({
      connectionString: disposablePostgresUrl,
    });
    const writer = new PostgresClient({ connectionString: disposablePostgresUrl });
    let migrationOpen = false;
    let writerAttempt:
      | Promise<
        | { readonly status: "fulfilled" }
        | { readonly status: "rejected"; readonly error: unknown }
      >
      | undefined;

    await Promise.all([admin.connect(), migrator.connect(), writer.connect()]);
    try {
      await admin.query(`create schema ${quotedSchema}`);
      for (const client of [admin, migrator, writer]) {
        await client.query(`set search_path to ${quotedSchema}`);
        await client.query(`set statement_timeout = '5s'`);
      }
      await admin.query(`create table storage_migrations (
        id text primary key,
        version integer not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
      for (const table of POSTGRES_RETIRED_HOST_TABLES) {
        await admin.query(`create table ${table} (id text primary key)`);
      }
      await admin.query(`create table takosumi_interfaces (
        id text primary key,
        workspace_id text not null,
        owner_kind text not null,
        owner_id text not null,
        name text not null,
        interface_type text not null,
        phase text not null,
        generation integer not null,
        resolved_revision integer not null,
        oauth_resource_uri text,
        form_ref_key text,
        form_schema_digest text,
        descriptor_name text,
        descriptor_version text,
        record_json jsonb not null,
        created_at text not null,
        updated_at text not null
      )`);
      await admin.query(`create table takosumi_interface_bindings (
        id text primary key,
        workspace_id text not null,
        interface_id text not null,
        subject_kind text not null,
        subject_id text not null,
        phase text not null,
        generation integer not null,
        record_json jsonb not null,
        created_at text not null,
        updated_at text not null
      )`);

      await migrator.query("begin");
      migrationOpen = true;
      await migrator.query(statements[0]!);
      await migrator.query(statements[1]!);

      writerAttempt = writer
        .query(
          `insert into takosumi_resource_shapes (id)
           values ('writer_between_preflight_and_drop')`,
        )
        .then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
      expect(
        await waitForPostgresRelationLock(admin, writer.processID),
      ).toBe(true);

      for (const statement of statements.slice(2)) {
        await migrator.query(statement);
      }
      await migrator.query(
        `insert into storage_migrations
           (id, version, checksum, applied_at)
         values
           ('retired.host_schema.drop_empty', 110, 'test-only', now())`,
      );
      await migrator.query("commit");
      migrationOpen = false;

      const writerResult = await writerAttempt;
      expect(writerResult.status).toBe("rejected");
      expect(
        (
          await admin.query<{ readonly version: number }>(
            `select version from storage_migrations where version = 110`,
          )
        ).rows,
      ).toEqual([{ version: 110 }]);
      for (const table of POSTGRES_RETIRED_HOST_TABLES) {
        expect(
          (
            await admin.query<{ readonly relation: string | null }>(
              `select to_regclass($1) as relation`,
              [table],
            )
          ).rows,
          table,
        ).toEqual([{ relation: null }]);
      }
    } finally {
      if (migrationOpen) {
        await migrator.query("rollback").catch(() => undefined);
      }
      if (writerAttempt) await writerAttempt;
      await admin
        .query(`drop schema if exists ${quotedSchema} cascade`)
        .catch(() => undefined);
      await Promise.allSettled([admin.end(), migrator.end(), writer.end()]);
    }
  },
  15_000,
);

test("fresh D1 schema retains migration history without retired Host tables", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);

  const tables = await d1TableNames(db);
  for (const table of D1_RETIRED_HOST_TABLES) {
    expect(tables.has(table), table).toBe(false);
  }
  expect(
    await db
      .prepare(`select version, name from schema_migrations where version = 66`)
      .first(),
  ).toEqual({
    version: 66,
    name: "d1_retired_host_schema_drop_empty",
  });
});

test("D1 Host retirement refuses populated state without advancing lineage", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 65 });
  await db
    .prepare(
      `insert into resource_shapes (
         id, space_id, kind, name, managed_by, spec_json, phase,
         generation, observed_generation, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "resource_retirement_blocker",
      "workspace_retirement_blocker",
      "HistoricalForm",
      "must-dispose",
      "external-host",
      "{}",
      "Ready",
      1,
      1,
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
    )
    .run();

  await expect(ensureD1OpenTofuLedgerSchema(db)).rejects.toThrow(
    /retired_host_rows_require_operator_disposition/u,
  );
  expect(
    await db
      .prepare(
        `select id from resource_shapes where id = 'resource_retirement_blocker'`,
      )
      .first(),
  ).toEqual({ id: "resource_retirement_blocker" });
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 66`)
      .first(),
  ).toBeNull();
  for (const table of D1_RETIRED_HOST_TABLES) {
    expect((await d1TableNames(db)).has(table), table).toBe(true);
  }
});

test("D1 Offering rows independently block all Host drops and ledger advance", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 65 });
  await db
    .prepare(
      `insert into offering_catalogs (
         catalog_key, catalog_id, catalog_version, effective_at,
         record_json, created_at, created_by
       ) values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "offering_retirement_blocker",
      "legacy-offering",
      "1.0.0",
      "2026-08-23T00:00:00.000Z",
      "{}",
      "2026-08-23T00:00:00.000Z",
      "operator:test",
    )
    .run();

  await expect(ensureD1OpenTofuLedgerSchema(db)).rejects.toThrow(
    /retired_host_rows_require_operator_disposition/u,
  );
  expect(
    await db
      .prepare(
        `select catalog_key from offering_catalogs
         where catalog_key = 'offering_retirement_blocker'`,
      )
      .first(),
  ).toEqual({ catalog_key: "offering_retirement_blocker" });
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 66`)
      .first(),
  ).toBeNull();
  for (const table of D1_RETIRED_HOST_TABLES) {
    expect((await d1TableNames(db)).has(table), table).toBe(true);
  }
});

test("fresh Postgres schema retains migration history without retired Host tables", async () => {
  const client = await PGliteSqlClient.create();
  try {
    for (const table of POSTGRES_RETIRED_HOST_TABLES) {
      expect(await postgresTableExists(client, table), table).toBe(false);
    }
  } finally {
    await client.close();
  }
});

test("Postgres Host retirement refuses populated state without advancing lineage", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(109);
  const retirement = postgresStorageMigrationStatements.find(
    (migration) => migration.version === 110,
  );
  expect(retirement).toBeDefined();
  try {
    await client.exec(`insert into takosumi_resource_shapes (
      id, space_id, kind, name, managed_by, spec_json, phase,
      generation, observed_generation, created_at, updated_at
    ) values (
      'resource_retirement_blocker', 'workspace_retirement_blocker',
      'HistoricalForm', 'must-dispose', 'external-host', '{}'::jsonb, 'Ready',
      1, 1, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
    )`);

    await expect(
      client.transaction(async (transaction) => {
        for (const statement of splitSqlStatements(retirement!.sql)) {
          await transaction.query(statement);
        }
        await transaction.query(
          `insert into storage_migrations
             (id, version, checksum, applied_at)
           values
             ('retired.host_schema.drop_empty', 110, 'test-only', now())`,
        );
      }),
    ).rejects.toThrow(/RETIRED_HOST_ROWS_REQUIRE_OPERATOR_DISPOSITION/u);
    expect(
      (
        await client.rawQuery<{ id: string }>(
        `select id from takosumi_resource_shapes
         where id = 'resource_retirement_blocker'`,
        )
      ).rows,
    ).toEqual([{ id: "resource_retirement_blocker" }]);
    expect(
      (
        await client.rawQuery<{ version: number }>(
          `select version from storage_migrations where version = 110`,
        )
      ).rows,
    ).toEqual([]);
    for (const table of POSTGRES_RETIRED_HOST_TABLES) {
      expect(await postgresTableExists(client, table), table).toBe(true);
    }
  } finally {
    await client.close();
  }
});

test("Postgres Offering rows independently block all Host drops and ledger advance", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(109);
  const retirement = postgresStorageMigrationStatements.find(
    (migration) => migration.version === 110,
  );
  expect(retirement).toBeDefined();
  try {
    await client.exec(`insert into takosumi_offering_catalogs (
      catalog_key, catalog_id, catalog_version, effective_at,
      record_json, created_at, created_by
    ) values (
      'offering_retirement_blocker', 'legacy-offering', '1.0.0',
      '2026-08-23T00:00:00.000Z', '{}'::jsonb,
      '2026-08-23T00:00:00.000Z', 'operator:test'
    )`);

    await expect(
      client.transaction(async (transaction) => {
        for (const statement of splitSqlStatements(retirement!.sql)) {
          await transaction.query(statement);
        }
        await transaction.query(
          `insert into storage_migrations
             (id, version, checksum, applied_at)
           values
             ('retired.host_schema.drop_empty', 110, 'test-only', now())`,
        );
      }),
    ).rejects.toThrow(/RETIRED_HOST_ROWS_REQUIRE_OPERATOR_DISPOSITION/u);
    expect(
      (
        await client.rawQuery<{ catalog_key: string }>(
          `select catalog_key from takosumi_offering_catalogs
           where catalog_key = 'offering_retirement_blocker'`,
        )
      ).rows,
    ).toEqual([{ catalog_key: "offering_retirement_blocker" }]);
    expect(
      (
        await client.rawQuery<{ version: number }>(
          `select version from storage_migrations where version = 110`,
        )
      ).rows,
    ).toEqual([]);
    for (const table of POSTGRES_RETIRED_HOST_TABLES) {
      expect(await postgresTableExists(client, table), table).toBe(true);
    }
  } finally {
    await client.close();
  }
});

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return `sha256:${hasher.digest("hex")}`;
}

function emptySqlClient(): SqlClient {
  const client: SqlClient & SqlTransaction = {
    async query<Row extends Record<string, unknown>>(): Promise<
      SqlQueryResult<Row>
    > {
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(
      fn: (transaction: SqlTransaction) => T | Promise<T>,
    ): Promise<T> {
      return await fn(client);
    },
  };
  return client;
}

async function d1TableNames(db: SqliteFakeD1): Promise<Set<string>> {
  const result = await db
    .prepare(`select name from sqlite_master where type = 'table'`)
    .all<{ name: string }>();
  return new Set((result.results ?? []).map((row) => row.name));
}

async function postgresTableExists(
  client: PGliteSqlClient,
  table: string,
): Promise<boolean> {
  const result = await client.rawQuery<{ exists: boolean }>(
    `select to_regclass('${table}') is not null as exists`,
  );
  return result.rows[0]?.exists === true;
}

async function waitForPostgresRelationLock(
  observer: PostgresClient,
  processId: number,
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      readonly wait_event_type: string | null;
      readonly wait_event: string | null;
    }>(
      `select wait_event_type, wait_event
       from pg_catalog.pg_stat_activity
       where pid = $1`,
      [processId],
    );
    if (
      result.rows[0]?.wait_event_type === "Lock" &&
      result.rows[0]?.wait_event === "relation"
    ) {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}

interface InterfaceSeed {
  readonly id: string;
  readonly ownerKind?: string;
  readonly recordJson: unknown;
  readonly rawRecordJson?: boolean;
  readonly formRefKey?: string;
  readonly formSchemaDigest?: string;
  readonly descriptorName?: string;
  readonly descriptorVersion?: string;
}

interface BindingSeed {
  readonly id: string;
  readonly interfaceId: string;
  readonly subjectKind?: string;
  readonly recordJson: unknown;
  readonly rawRecordJson?: boolean;
}

function genericInterfaceRecord(
  id: string,
  options: {
    readonly ownerKind?: string;
    readonly materializedFrom?: Readonly<Record<string, unknown>>;
    readonly inputSource?: string;
    readonly provenanceSource?: string;
  } = {},
): Readonly<Record<string, unknown>> {
  const now = "2026-08-23T00:00:00.000Z";
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id,
      workspaceId: "workspace_generic",
      name: id,
      ownerRef: {
        kind: options.ownerKind ?? "Workspace",
        id: "workspace_generic",
      },
      generation: 3,
      materializedFrom: options.materializedFrom ?? {
        source: "portable_iac",
        descriptorName: "generic.http",
        descriptorVersion: "1",
      },
      createdAt: now,
      updatedAt: now,
    },
    spec: {
      type: "generic.http",
      version: "1",
      document: {
        note:
          "benign prose may mention Resource, form_descriptor, and resource_output",
      },
      inputs: {
        endpoint: {
          source: options.inputSource ?? "literal",
          ...(options.inputSource === "resource_output"
            ? { resourceId: "resource_legacy", outputName: "endpoint" }
            : { value: "https://example.invalid" }),
        },
      },
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 3,
      resolvedRevision: 7,
      provenance: {
        endpoint: {
          source: options.provenanceSource ?? "literal",
          ...(options.provenanceSource === "resource_output"
            ? { resourceId: "resource_legacy", resourceGeneration: 1 }
            : { specGeneration: 3 }),
        },
      },
    },
  };
}

function genericBindingRecord(
  id: string,
  interfaceId: string,
  options: {
    readonly subjectKind?: string;
    readonly materializedFromSource?: string;
  } = {},
): Readonly<Record<string, unknown>> {
  const now = "2026-08-23T00:00:00.000Z";
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "InterfaceBinding",
    metadata: {
      id,
      workspaceId: "workspace_generic",
      generation: 5,
      materializedFrom: {
        source: options.materializedFromSource ?? "capsule_required_interface",
        capsuleId: "capsule_generic",
        requirementKey: "generic",
        interfaceType: "generic.http",
        interfaceVersion: "1",
      },
      createdAt: now,
      updatedAt: now,
    },
    spec: {
      interfaceId,
      subjectRef: {
        kind: options.subjectKind ?? "Principal",
        id: `subject_${id}`,
      },
      permissions: ["read"],
      delivery: { type: "none" },
    },
    status: {
      phase: "Ready",
      observedInterfaceRevision: 7,
    },
  };
}

async function insertD1Interface(
  db: SqliteFakeD1,
  input: InterfaceSeed,
): Promise<void> {
  const now = "2026-08-23T00:00:00.000Z";
  await db
    .prepare(
      `insert into interfaces (
         id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
         generation, resolved_revision, oauth_resource_uri, form_ref_key,
         form_schema_digest, descriptor_name, descriptor_version, record_json,
         created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      "workspace_generic",
      input.ownerKind ?? "Workspace",
      "workspace_generic",
      input.id,
      "generic.http",
      "Resolved",
      3,
      7,
      null,
      input.formRefKey ?? null,
      input.formSchemaDigest ?? null,
      input.descriptorName ?? null,
      input.descriptorVersion ?? null,
      input.rawRecordJson
        ? String(input.recordJson)
        : JSON.stringify(input.recordJson),
      now,
      now,
    )
    .run();
}

async function insertD1Binding(
  db: SqliteFakeD1,
  input: BindingSeed,
): Promise<void> {
  const now = "2026-08-23T00:00:00.000Z";
  await db
    .prepare(
      `insert into interface_bindings (
         id, workspace_id, interface_id, subject_kind, subject_id, phase,
         generation, record_json, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      "workspace_generic",
      input.interfaceId,
      input.subjectKind ?? "Principal",
      `subject_${input.id}`,
      "Ready",
      5,
      input.rawRecordJson
        ? String(input.recordJson)
        : JSON.stringify(input.recordJson),
      now,
      now,
    )
    .run();
}

async function d1FullRow(
  db: SqliteFakeD1,
  table: "interfaces" | "interface_bindings",
  id: string,
): Promise<Record<string, unknown> | null> {
  return await db.prepare(`select * from ${table} where id = ?`).bind(id).first();
}

async function d1RetainedRow(
  db: SqliteFakeD1,
  table: "interfaces" | "interface_bindings",
  columns: readonly string[],
  id: string,
): Promise<Record<string, unknown> | null> {
  return await db
    .prepare(`select ${columns.join(", ")} from ${table} where id = ?`)
    .bind(id)
    .first();
}

async function d1Columns(
  db: SqliteFakeD1,
  table: string,
): Promise<readonly string[]> {
  const result = await db
    .prepare(`pragma table_info(${table})`)
    .all<{ readonly name: string }>();
  return (result.results ?? []).map((column) => column.name);
}

async function expectD1RetirementNotAdvanced(db: SqliteFakeD1): Promise<void> {
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 66`)
      .first(),
  ).toBeNull();
  const tables = await d1TableNames(db);
  for (const table of D1_RETIRED_HOST_TABLES) {
    expect(tables.has(table), table).toBe(true);
  }
  expect(tables.has("interfaces")).toBe(true);
  expect(tables.has("interface_bindings")).toBe(true);
}

async function expectD1RetirementAdvanced(db: SqliteFakeD1): Promise<void> {
  expect(
    await db
      .prepare(`select version from schema_migrations where version = 66`)
      .first(),
  ).toEqual({ version: 66 });
  const tables = await d1TableNames(db);
  for (const table of D1_RETIRED_HOST_TABLES) {
    expect(tables.has(table), table).toBe(false);
  }
  expect(tables.has("interfaces")).toBe(true);
  expect(tables.has("interface_bindings")).toBe(true);
}

async function insertPostgresInterface(
  client: PGliteSqlClient,
  input: InterfaceSeed,
): Promise<void> {
  const now = "2026-08-23T00:00:00.000Z";
  await client.query(
    `insert into takosumi_interfaces (
       id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
       generation, resolved_revision, oauth_resource_uri, form_ref_key,
       form_schema_digest, descriptor_name, descriptor_version, record_json,
       created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15::jsonb, $16, $17
     )`,
    [
      input.id,
      "workspace_generic",
      input.ownerKind ?? "Workspace",
      "workspace_generic",
      input.id,
      "generic.http",
      "Resolved",
      3,
      7,
      null,
      input.formRefKey ?? null,
      input.formSchemaDigest ?? null,
      input.descriptorName ?? null,
      input.descriptorVersion ?? null,
      JSON.stringify(input.recordJson),
      now,
      now,
    ],
  );
}

async function insertPostgresBinding(
  client: PGliteSqlClient,
  input: BindingSeed,
): Promise<void> {
  const now = "2026-08-23T00:00:00.000Z";
  await client.query(
    `insert into takosumi_interface_bindings (
       id, workspace_id, interface_id, subject_kind, subject_id, phase,
       generation, record_json, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      input.id,
      "workspace_generic",
      input.interfaceId,
      input.subjectKind ?? "Principal",
      `subject_${input.id}`,
      "Ready",
      5,
      JSON.stringify(input.recordJson),
      now,
      now,
    ],
  );
}

async function postgresFullRow(
  client: PGliteSqlClient,
  table: "takosumi_interfaces" | "takosumi_interface_bindings",
  id: string,
): Promise<Record<string, unknown> | undefined> {
  return (
    await client.rawQuery<Record<string, unknown>>(
      `select * from ${table} where id = '${id}'`,
    )
  ).rows[0];
}

async function postgresRetainedRow(
  client: PGliteSqlClient,
  table: "takosumi_interfaces" | "takosumi_interface_bindings",
  columns: readonly string[],
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const projection = columns
    .map((column) =>
      column === "record_json" ? "record_json::text as record_json" : column,
    )
    .join(", ");
  return (
    await client.rawQuery<Record<string, unknown>>(
      `select ${projection} from ${table} where id = '${id}'`,
    )
  ).rows[0];
}

async function postgresColumns(
  client: PGliteSqlClient,
  table: string,
): Promise<readonly string[]> {
  const result = await client.rawQuery<{ readonly column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = current_schema() and table_name = '${table}'
      order by ordinal_position`,
  );
  return result.rows.map((column) => column.column_name);
}

async function applyPostgresRetirement(
  client: PGliteSqlClient,
  sql: string,
): Promise<void> {
  await client.transaction(async (transaction) => {
    for (const statement of splitSqlStatements(sql)) {
      await transaction.query(statement);
    }
    await transaction.query(
      `insert into storage_migrations
         (id, version, applied_at)
       values
         ('retired.host_schema.drop_empty', 110, now())`,
    );
  });
}

async function expectPostgresRetirementBlocked(
  client: PGliteSqlClient,
  sql: string,
): Promise<void> {
  await expect(applyPostgresRetirement(client, sql)).rejects.toThrow(
    /RETAINED_INTERFACE_HOST_EVIDENCE_REQUIRES_OPERATOR_DISPOSITION/u,
  );
  expect(
    (
      await client.rawQuery<{ readonly version: number }>(
        `select version from storage_migrations where version = 110`,
      )
    ).rows,
  ).toEqual([]);
  for (const table of POSTGRES_RETIRED_HOST_TABLES) {
    expect(await postgresTableExists(client, table), table).toBe(true);
  }
  expect(await postgresTableExists(client, "takosumi_interfaces")).toBe(true);
  expect(
    await postgresTableExists(client, "takosumi_interface_bindings"),
  ).toBe(true);
}
