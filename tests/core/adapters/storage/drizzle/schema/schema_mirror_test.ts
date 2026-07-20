import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { ensureD1OpenTofuLedgerSchema } from "../../../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  PGliteSqlClient,
  splitSqlStatements,
} from "../../../../../helpers/deploy-control/pglite_sql_client.ts";
import { postgresStorageMigrationStatements } from "../../../../../../core/adapters/storage/migrations.ts";
import * as d1Schema from "../../../../../../core/adapters/storage/drizzle/schema/d1.ts";
import { deployControlLogicalTables } from "../../../../../../core/adapters/storage/drizzle/schema/logical.ts";
import * as postgresSchema from "../../../../../../core/adapters/storage/drizzle/schema/postgres.ts";

type ColumnMirror = {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
  primary: boolean;
};

type UniqueIndexMirror = {
  name: string;
  columns: readonly string[];
  unique: boolean;
};

type TableLike = Parameters<typeof getTableName>[0];

type SqlitePragmaTableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type SqlitePragmaIndexListRow = {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

type SqlitePragmaIndexInfoRow = {
  seqno: number;
  cid: number;
  name: string;
};

type D1SchemaMigrationRow = {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
};

function columnsOf(table: TableLike): ColumnMirror[] {
  const columns = getTableColumns(table);
  return Object.values(columns).map((column) => {
    const typed = column as {
      name: string;
      notNull: boolean;
      hasDefault: boolean;
      primary?: boolean;
    };
    return {
      name: typed.name,
      notNull: typed.notNull,
      hasDefault: typed.hasDefault,
      primary: typed.primary === true,
    };
  });
}

function sqliteUniqueIndexesOf(
  table: Parameters<typeof getSqliteTableConfig>[0],
): UniqueIndexMirror[] {
  return normalizeIndexes(
    getSqliteTableConfig(table).indexes.map((index) => {
      const config = index.config as {
        name: string;
        columns: Array<{ name: string }>;
        unique?: boolean;
      };
      return {
        name: config.name,
        columns: config.columns.map((column) => column.name),
        unique: config.unique === true,
      };
    }),
  );
}

function pgUniqueIndexesOf(
  table: Parameters<typeof getPgTableConfig>[0],
): UniqueIndexMirror[] {
  return normalizeIndexes(
    getPgTableConfig(table).indexes.map((index) => {
      const config = index.config as {
        name: string;
        columns: Array<{ name: string }>;
        unique?: boolean;
      };
      return {
        name: config.name,
        columns: config.columns.map((column) => column.name),
        unique: config.unique === true,
      };
    }),
  );
}

async function liveD1ColumnsOf(
  db: SqliteFakeD1,
  tableName: string,
): Promise<ColumnMirror[]> {
  const result = await db
    .prepare(`pragma table_info(${tableName})`)
    .all<SqlitePragmaTableInfoRow>();
  return result.results.map((row) => ({
    name: row.name,
    notNull: row.notnull === 1 || row.pk > 0,
    hasDefault: row.dflt_value !== null,
    primary: row.pk > 0,
  }));
}

async function liveD1IndexesOf(
  db: SqliteFakeD1,
  tableName: string,
): Promise<UniqueIndexMirror[]> {
  const indexRows = await db
    .prepare(`pragma index_list(${quoteSqliteIdentifier(tableName)})`)
    .all<SqlitePragmaIndexListRow>();
  const indexes: UniqueIndexMirror[] = [];
  for (const row of indexRows.results ?? []) {
    if (row.origin === "pk" || row.name.startsWith("sqlite_autoindex_")) {
      continue;
    }
    const infoRows = await db
      .prepare(`pragma index_info(${quoteSqliteIdentifier(row.name)})`)
      .all<SqlitePragmaIndexInfoRow>();
    indexes.push({
      name: row.name,
      columns: (infoRows.results ?? []).map((info) => info.name),
      unique: row.unique === 1,
    });
  }
  return normalizeIndexes(indexes);
}

function quoteSqliteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function normalizeIndexes(indexes: readonly UniqueIndexMirror[]) {
  return [...indexes].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

const nn = (name: string): ColumnMirror => ({
  name,
  notNull: true,
  hasDefault: false,
  primary: false,
});

const nullable = (name: string): ColumnMirror => ({
  name,
  notNull: false,
  hasDefault: false,
  primary: false,
});

const pk = (name: string): ColumnMirror => ({
  name,
  notNull: true,
  hasDefault: false,
  primary: true,
});

const defaulted = (name: string): ColumnMirror => ({
  name,
  notNull: true,
  hasDefault: true,
  primary: false,
});

test("D1 Drizzle schema mirrors critical live D1 tables", () => {
  expect(getTableName(d1Schema.connections)).toBe("connections");
  expect(columnsOf(d1Schema.connections)).toEqual([
    pk("id"),
    nullable("space_id"),
    nn("provider"),
    nn("status"),
    nn("connection_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(d1Schema.secretBlobs)).toBe("secret_blobs");
  expect(columnsOf(d1Schema.secretBlobs)).toEqual([
    pk("id"),
    nn("connection_id"),
    nullable("space_id"),
    nn("kind"),
    nn("ciphertext"),
    nn("encrypted_dek"),
    nn("nonce"),
    nn("aad"),
    nn("key_version"),
    nn("created_at"),
    nullable("rotated_at"),
    nn("blob_json"),
  ]);

  expect(getTableName(d1Schema.providerBindingSets)).toBe(
    "provider_env_binding_sets",
  );
  expect(columnsOf(d1Schema.providerBindingSets)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("installation_id"),
    nn("environment"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);
  expect(sqliteUniqueIndexesOf(d1Schema.providerBindingSets)).toContainEqual({
    name: "provider_env_binding_sets_installation_environment_unique",
    columns: ["installation_id", "environment"],
    unique: true,
  });

  // Project is the required ownership boundary; the source column stays
  // nullable only for historical operator migration rows.
  expect(getTableName(d1Schema.capsules)).toBe("capsules");
  expect(columnsOf(d1Schema.capsules)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("project_id"),
    nn("name"),
    nn("slug"),
    // Physically nullable only for historical source-less Capsule rows.
    nullable("source_id"),
    nn("install_config_id"),
    nn("environment"),
    nullable("current_state_version_id"),
    defaulted("current_state_generation"),
    nullable("current_output_snapshot_id"),
    nn("status"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(d1Schema.projects)).toBe("projects");
  expect(columnsOf(d1Schema.projects)).toEqual([
    pk("id"),
    nn("workspace_id"),
    nn("name"),
    nn("slug"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);
  expect(sqliteUniqueIndexesOf(d1Schema.projects)).toContainEqual({
    name: "projects_workspace_slug_unique",
    columns: ["workspace_id", "slug"],
    unique: true,
  });

  expect(getTableName(d1Schema.capsuleCompatibilityReports)).toBe(
    "capsule_compatibility_reports",
  );
  expect(columnsOf(d1Schema.capsuleCompatibilityReports)).toEqual([
    pk("id"),
    nullable("source_id"),
    nullable("installation_id"),
    nn("source_snapshot_id"),
    nn("level"),
    nn("findings_json"),
    nn("providers_json"),
    nn("resources_json"),
    nn("data_sources_json"),
    nn("provisioners_json"),
    defaulted("root_module_variables_json"),
    defaulted("root_module_outputs_json"),
    nn("created_at"),
  ]);

  expect(getTableName(d1Schema.runs)).toBe("runs");
  expect(columnsOf(d1Schema.runs)).toEqual([
    pk("id"),
    nullable("run_group_id"),
    nn("space_id"),
    nullable("source_id"),
    nullable("installation_id"),
    nullable("environment"),
    nn("type"),
    nn("status"),
    nullable("lease_token"),
    nullable("heartbeat_at"),
    nn("run_json"),
    defaulted("created_at"),
  ]);

  expect(getTableName(d1Schema.stateVersions)).toBe("state_versions");
  expect(columnsOf(d1Schema.stateVersions)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("installation_id"),
    nn("environment"),
    nn("generation"),
    nn("object_key"),
    nn("digest"),
    nn("created_by_run_id"),
    nn("created_at"),
  ]);

  expect(getTableName(d1Schema.artifacts)).toBe("artifacts");
  expect(columnsOf(d1Schema.artifacts)).toEqual([
    pk("id"),
    nn("run_id"),
    nn("kind"),
    nn("object_key"),
    nn("digest"),
    nn("size_bytes"),
    nn("created_at"),
  ]);

  expect(getTableName(d1Schema.usageEvents)).toBe("usage_events");
  expect(columnsOf(d1Schema.usageEvents)).toEqual([
    pk("id"),
    nn("workspace_id"),
    nullable("capsule_id"),
    nullable("run_id"),
    nullable("meter_id"),
    nullable("resource_family"),
    nullable("resource_id"),
    nullable("operation"),
    nullable("resource_metadata_json"),
    nn("kind"),
    nn("quantity"),
    nn("usd_micros"),
    nn("rating_status"),
    nn("source"),
    nn("idempotency_key"),
    nn("created_at"),
  ]);

  expect(getTableName(d1Schema.publicHostReservations)).toBe(
    "public_host_reservations",
  );
  expect(columnsOf(d1Schema.publicHostReservations)).toEqual([
    pk("hostname"),
    nn("owner_user_id"),
    nn("workspace_id"),
    nn("installation_id"),
    nn("installation_name"),
    nn("allocation_kind"),
    nn("status"),
    nn("reserved_at"),
    nn("updated_at"),
    nullable("released_at"),
  ]);

  expect(getTableName(d1Schema.credentialMintEvents)).toBe(
    "credential_mint_events",
  );
  expect(columnsOf(d1Schema.credentialMintEvents)).toEqual([
    pk("id"),
    nn("run_id"),
    nn("space_id"),
    nullable("installation_id"),
    nullable("source_id"),
    nn("connection_id"),
    nn("phase"),
    nn("record_json"),
    nn("created_at"),
  ]);

  expect(getTableName(d1Schema.securityFindings)).toBe("security_findings");
  expect(columnsOf(d1Schema.securityFindings)).toEqual([
    pk("id"),
    nn("space_id"),
    nullable("installation_id"),
    nullable("run_id"),
    nn("severity"),
    nn("type"),
    nn("record_json"),
    nn("created_at"),
  ]);

  expect(getTableName(d1Schema.runGroups)).toBe("run_groups");
  expect(columnsOf(d1Schema.runGroups)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("type"),
    nn("record_json"),
    nn("created_at"),
  ]);

  expect(getTableName(d1Schema.auditEvents)).toBe("audit_events");
  expect(columnsOf(d1Schema.auditEvents)).toEqual([
    pk("id"),
    nn("space_id"),
    nullable("actor_id"),
    nn("action"),
    nn("target_type"),
    nn("target_id"),
    nullable("run_id"),
    nn("created_at"),
    nn("record_json"),
  ]);

  expect(getTableName(d1Schema.backups)).toBe("backups");
  expect(columnsOf(d1Schema.backups)).toEqual([
    pk("id"),
    nn("space_id"),
    nullable("installation_id"),
    nullable("environment"),
    nullable("created_by_run_id"),
    nn("record_json"),
    nn("created_at"),
  ]);
});

test("Worker D1 bootstrap mirrors every logical D1 Drizzle table", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);

  for (const logicalName of deployControlLogicalTables) {
    const table = d1Schema[logicalName];
    expect(await liveD1ColumnsOf(db, getTableName(table)), logicalName).toEqual(
      columnsOf(table),
    );
  }
});

test("Worker D1 bootstrap mirrors every logical D1 Drizzle index", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);

  for (const logicalName of deployControlLogicalTables) {
    const table = d1Schema[logicalName];
    const tableName = getTableName(table);
    expect(await liveD1IndexesOf(db, tableName), logicalName).toEqual(
      sqliteUniqueIndexesOf(table),
    );
  }
});

test("Worker D1 bootstrap records canonical schema migration ledger", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);

  expect(await liveD1ColumnsOf(db, "schema_migrations")).toEqual([
    pk("version"),
    nn("name"),
    nn("checksum"),
    nn("applied_at"),
  ]);
  const migrationRows = await db
    .prepare(
      `select version, name, checksum, applied_at
      from schema_migrations
      order by version`,
    )
    .all<D1SchemaMigrationRow>();
  const rows = migrationRows.results ?? [];
  expect(rows.map((row) => row.version)).toEqual([
    1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
    44, 45, 46, 47, 48, 49, 50, 51,
  ]);
  expect(rows.map((row) => row.name)).toEqual([
    "d1_opentofu_connections_and_secret_blobs_shape",
    "d1_opentofu_installations_output_snapshot_pointer",
    "d1_opentofu_runs_projection_columns",
    "d1_opentofu_credential_mint_source_scope",
    "d1_opentofu_backups_installation_run_projection",
    "d1_opentofu_provider_catalog_table",
    "d1_opentofu_provider_materialization_values",
    "d1_opentofu_drizzle_index_parity",
    "d1_opentofu_provider_materialization_constraints",
    "d1_opentofu_provider_catalog_ownership_repair",
    "d1_opentofu_upload_origin_nullable_source_repair",
    "d1_opentofu_usage_event_meter_metadata",
    "d1_opentofu_provider_credential_collapse",
    "d1_opentofu_workspace_capsule_rename",
    "d1_opentofu_compatibility_report_root_interface",
    "d1_opentofu_public_host_reservations",
    "d1_opentofu_public_host_reservations_backfill",
    "d1_opentofu_capsule_active_name_unique",
    "d1_opentofu_install_config_store_key",
    "d1_opentofu_public_host_owner_slots",
    "d1_opentofu_public_host_legacy_grandfather",
    "d1_opentofu_install_config_runner_profile",
    "d1_opentofu_workspace_output_sync",
    "d1_opentofu_workspace_output_sync_retire",
    "d1_resource_shape_resolution_lock_identity",
    "d1_capsule_compatibility_auto_rewrite_retire",
    "d1_workspace_members_create",
    "d1_capsule_install_discriminators_retire",
    "d1_capsule_project_boundary_enforce",
    "d1_resource_execution_state_add",
    "d1_connection_secret_partition_backfill",
    "d1_resource_legacy_state_adoption_add",
    "d1_install_config_trust_level_retire",
    "d1_oss_usage_ledger_clean_cut",
    "d1_install_config_variable_defaults_normalize",
    "d1_usage_event_rating_status",
    "d1_resource_list_keyset_indexes",
    "d1_resource_event_target_keyset_index",
    "d1_resource_observation_schedule_lease",
    "d1_resource_ready_kind_inventory_index",
    "d1_pre_ga_canonical_schema_convergence",
    "d1_service_form_registry",
    "d1_resource_exact_form_identity_add",
    "d1_interface_oauth_resource_claim",
    "d1_interface_form_descriptor_lineage",
    "d1_interface_canonical_table_convergence",
    "d1_generic_offering_catalog",
    "d1_install_config_scope_keyset_index",
  ]);
  for (const row of rows) {
    expect(row.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.applied_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  }
});

test("Worker D1 migration persists historical Connection secret partitions once", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const now = "2026-07-13T00:00:00.000Z";
  const connection = {
    id: "conn_legacy_cloudflare",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    scope: "space",
    spaceId: "ws_legacy",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: now,
    updatedAt: now,
  };
  await db
    .prepare(
      `insert into connections (
        id, space_id, provider, status, connection_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      connection.id,
      connection.spaceId,
      connection.provider,
      connection.status,
      JSON.stringify(connection),
      now,
      now,
    )
    .run();
  await db
    .prepare(
      `insert into secret_blobs (
        id, connection_id, space_id, kind, ciphertext, encrypted_dek, nonce,
        aad, key_version, created_at, rotated_at, blob_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
    )
    .bind(
      "secret_conn_legacy_cloudflare",
      connection.id,
      connection.spaceId,
      "cloudflare_api_token",
      "ciphertext",
      "dek",
      "nonce",
      "{}",
      1,
      now,
      JSON.stringify({
        id: "secret_conn_legacy_cloudflare",
        connectionId: connection.id,
        kind: "cloudflare_api_token",
      }),
    )
    .run();
  await db.prepare(`delete from schema_migrations where version = 34`).run();

  await ensureD1OpenTofuLedgerSchema(db);

  const migratedConnection = await db
    .prepare(`select connection_json from connections where id = ?`)
    .bind(connection.id)
    .first<{ readonly connection_json: string }>();
  expect(
    JSON.parse(migratedConnection?.connection_json ?? "{}").secretPartition,
  ).toBe("cloudflare");
  const migratedBlob = await db
    .prepare(`select kind, blob_json from secret_blobs where connection_id = ?`)
    .bind(connection.id)
    .first<{ readonly kind: string; readonly blob_json: string }>();
  expect(migratedBlob?.kind).toBe("cloudflare");
  expect(JSON.parse(migratedBlob?.blob_json ?? "{}").kind).toBe("cloudflare");
});

test("Worker D1 migration normalizes historical InstallConfig defaults once", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const now = "2026-07-13T00:00:00.000Z";
  const record = {
    id: "cfg_legacy_defaults",
    name: "Legacy defaults",
    variableMapping: {},
    variablePresentation: [
      {
        name: "name",
        label: { ja: "名前", en: "Name" },
        defaultValue: "service-name",
      },
      {
        name: "scoped",
        label: { ja: "範囲名", en: "Scoped name" },
        defaultValue: "service-name-with-space",
      },
      {
        name: "region",
        label: { ja: "地域", en: "Region" },
        defaultValue: "global",
      },
    ],
    outputAllowlist: {},
    policy: {},
    createdAt: now,
    updatedAt: now,
  };
  await db
    .prepare(
      `insert into install_configs
        (id, space_id, record_json, created_at, updated_at)
       values (?, null, ?, ?, ?)`,
    )
    .bind(record.id, JSON.stringify(record), now, now)
    .run();
  await db.prepare(`delete from schema_migrations where version = 38`).run();

  await ensureD1OpenTofuLedgerSchema(db);

  const row = await db
    .prepare(`select record_json from install_configs where id = ?`)
    .bind(record.id)
    .first<{ readonly record_json: string }>();
  const migrated = JSON.parse(row?.record_json ?? "{}") as {
    readonly variablePresentation: readonly {
      readonly defaultValue: unknown;
    }[];
  };
  expect(
    migrated.variablePresentation.map((item) => item.defaultValue),
  ).toEqual([
    { source: "capsule_name" },
    { source: "workspace_scoped_capsule_name" },
    { source: "literal", value: "global" },
  ]);
});

test("Worker D1 migration retires legacy auto-rewritten compatibility reports", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await db
    .prepare(
      `alter table capsule_compatibility_reports
       add column normalized_object_key text`,
    )
    .run();
  await db
    .prepare(
      `alter table capsule_compatibility_reports
       add column normalized_digest text`,
    )
    .run();
  await db
    .prepare(
      `insert into capsule_compatibility_reports (
         id, source_snapshot_id, level, findings_json, providers_json,
         resources_json, data_sources_json, provisioners_json,
         root_module_variables_json, root_module_outputs_json,
         normalized_object_key, normalized_digest, created_at
       ) values (?, ?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?, ?)`,
    )
    .bind(
      "caprep_legacy_auto",
      "snap_legacy",
      "auto_capsulized",
      "legacy/normalized-module.json",
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2026-07-13T00:00:00.000Z",
    )
    .run();
  await db
    .prepare(
      `insert into capsules (
         id, space_id, project_id, name, slug, install_config_id,
         environment, current_state_generation, status, record_json,
         created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(
      "cap_legacy_auto",
      "ws_legacy",
      "prj_legacy",
      "legacy",
      "legacy",
      "cfg_legacy",
      "default",
      "active",
      JSON.stringify({
        id: "cap_legacy_auto",
        compatibilityStatus: "auto_capsulized",
      }),
      "2026-07-13T00:00:00.000Z",
      "2026-07-13T00:00:00.000Z",
    )
    .run();
  await db.prepare(`delete from schema_migrations where version = 29`).run();

  await ensureD1OpenTofuLedgerSchema(db);

  expect(
    await db
      .prepare(
        `select level, normalized_object_key, normalized_digest
         from capsule_compatibility_reports where id = ?`,
      )
      .bind("caprep_legacy_auto")
      .first(),
  ).toEqual({
    level: "ready",
    normalized_object_key: null,
    normalized_digest: null,
  });
  expect(
    await db
      .prepare(
        `select json_extract(record_json, '$.compatibilityStatus') as status
         from capsules where id = ?`,
      )
      .bind("cap_legacy_auto")
      .first(),
  ).toEqual({ status: "ready" });
});

test("Worker D1 bootstrap retires Workspace Output Sync storage", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);

  expect(await liveD1ColumnsOf(db, "workspace_output_sync")).toEqual([]);

  await db.prepare(`delete from schema_migrations where version = 27`).run();
  await db
    .prepare(
      `create table workspace_output_sync (
        workspace_id text primary key,
        enabled integer not null default 1,
        output_revision integer not null default 0,
        reconciled_revision integer not null default 0,
        active_run_group_id text,
        consecutive_passes integer not null default 0,
        updated_at text not null
      )`,
    )
    .run();

  await ensureD1OpenTofuLedgerSchema(db);
  expect(await liveD1ColumnsOf(db, "workspace_output_sync")).toEqual([]);
});

test("Worker D1 owner-slot migrations grandfather legacy reservations", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await db
    .prepare(`delete from schema_migrations where version in (23, 24)`)
    .run();
  await db.prepare(`drop table public_host_reservations`).run();
  await db
    .prepare(
      `create table public_host_reservations (
        hostname text primary key,
        workspace_id text not null,
        installation_id text not null,
        installation_name text not null,
        status text not null,
        reserved_at text not null,
        updated_at text not null,
        released_at text
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into workspaces (id, handle, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    )
    .bind(
      "workspace_alpha",
      "alpha",
      JSON.stringify({
        id: "workspace_alpha",
        handle: "alpha",
        ownerUserId: "owner_same",
      }),
      "2026-07-11T00:00:00.000Z",
      "2026-07-11T00:00:00.000Z",
      "workspace_beta",
      "beta",
      JSON.stringify({
        id: "workspace_beta",
        handle: "beta",
        ownerUserId: "owner_same",
      }),
      "2026-07-11T00:00:00.000Z",
      "2026-07-11T00:00:00.000Z",
    )
    .run();
  await db
    .prepare(
      `insert into public_host_reservations (
         hostname, workspace_id, installation_id, installation_name,
         status, reserved_at, updated_at, released_at
       ) values
         ('alpha-app.app.takos.jp', 'workspace_alpha', 'capsule_scoped', 'scoped',
          'reserved', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', null),
         ('short-name.app.takos.jp', 'workspace_beta', 'capsule_vanity', 'vanity',
          'reserved', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', null)`,
    )
    .run();

  await ensureD1OpenTofuLedgerSchema(db);
  await ensureD1OpenTofuLedgerSchema(db);

  const rows = await db
    .prepare(
      `select hostname, owner_user_id, allocation_kind
       from public_host_reservations
       order by hostname`,
    )
    .all<{
      hostname: string;
      owner_user_id: string;
      allocation_kind: string;
    }>();
  expect(rows.results).toEqual([
    {
      hostname: "alpha-app.app.takos.jp",
      owner_user_id: "owner_same",
      allocation_kind: "scoped",
    },
    {
      hostname: "short-name.app.takos.jp",
      owner_user_id: "owner_same",
      allocation_kind: "scoped",
    },
  ]);
});

test("Worker D1 bootstrap rejects unknown schema migration ledger rows", async () => {
  const db = new SqliteFakeD1();
  await db
    .prepare(
      `create table schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into schema_migrations (version, name, checksum, applied_at)
      values (?, ?, ?, ?)`,
    )
    .bind(
      999,
      "future_unreviewed_schema",
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "2026-06-14T00:00:00.000Z",
    )
    .run();

  await expect(ensureD1OpenTofuLedgerSchema(db)).rejects.toThrow(
    /not present in the current migration catalog/,
  );
});

test("Worker D1 bootstrap rejects schema migration checksum drift", async () => {
  const db = new SqliteFakeD1();
  await db
    .prepare(
      `create table schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into schema_migrations (version, name, checksum, applied_at)
      values (?, ?, ?, ?)`,
    )
    .bind(
      1,
      "d1_opentofu_connections_and_secret_blobs_shape",
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "2026-06-14T00:00:00.000Z",
    )
    .run();

  await expect(ensureD1OpenTofuLedgerSchema(db)).rejects.toThrow(
    /checksum mismatch/,
  );
});

test("Worker D1 bootstrap converts legacy provider_templates to OSS-safe Provider Catalog rows", async () => {
  const db = new SqliteFakeD1();
  await db
    .prepare(
      `create table provider_templates (
      id text primary key,
      provider_source text not null,
      primary_credential_source text not null,
      default_eligible integer not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into provider_templates (
      id,
      provider_source,
      primary_credential_source,
      default_eligible,
      record_json,
      created_at,
      updated_at
    ) values
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "pcat_legacy_gateway",
      "registry.opentofu.org/cloudflare/cloudflare",
      "takosumi_managed",
      1,
      JSON.stringify({
        id: "pcat_legacy_gateway",
        ownershipOptions: ["env"],
      }),
      "2026-06-08T00:00:00.000Z",
      "2026-06-08T00:00:00.000Z",
      "pcat_legacy_secret",
      "registry.opentofu.org/hashicorp/aws",
      "user_env_set",
      0,
      JSON.stringify({
        id: "pcat_legacy_secret",
        ownershipOptions: ["env"],
      }),
      "2026-06-08T00:00:00.000Z",
      "2026-06-08T00:00:00.000Z",
    )
    .run();

  await ensureD1OpenTofuLedgerSchema(db);

  // The live Provider Catalog table is retired (renamed aside) by migration 16;
  // the canonicalized rows live in the recoverable `_retired` table.
  const rows = await db
    .prepare(
      `select id, primary_materialization, gateway_eligible
      from provider_catalog_retired
      where id in ('pcat_legacy_gateway', 'pcat_legacy_secret')
      order by id`,
    )
    .all<{
      id: string;
      primary_materialization: string;
      gateway_eligible: number;
    }>();
  expect(rows.results).toEqual([
    {
      id: "pcat_legacy_gateway",
      primary_materialization: "secret",
      gateway_eligible: 0,
    },
    {
      id: "pcat_legacy_secret",
      primary_materialization: "secret",
      gateway_eligible: 0,
    },
  ]);
});

test("Worker D1 bootstrap additively migrates older ledger tables", async () => {
  const db = new SqliteFakeD1();
  await db
    .prepare(
      `create table connections (
	      id text primary key,
	      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      // Seeded at the v16 (pre-P4-rename) shape — the realistic state a live
      // ledger is in when the v17 rename runs: source_id already nullable (v12),
      // current_output_snapshot_id already present (v2). The boot path renames
      // this table aside to `capsules` and column-moves it (v17).
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
      `create table source_snapshots (
      id text primary key,
      source_id text not null,
      record_json text not null,
      fetched_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `create table runs (
      id text primary key,
      run_group_id text,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      type text not null,
      status text not null,
      run_json text not null,
      created_at text not null default ""
    )`,
    )
    .run();
  await db
    .prepare(
      `create table credential_mint_events (
      id text primary key,
      run_id text not null,
      space_id text not null,
      installation_id text,
      connection_id text not null,
      phase text not null,
      record_json text not null,
      created_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `create table backups (
      id text primary key,
      space_id text not null,
      record_json text not null,
      created_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `create table provider_catalog (
      id text primary key,
      provider_source text not null,
      primary_materialization text not null,
      gateway_eligible integer not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into provider_catalog (
      id,
      provider_source,
      primary_materialization,
      gateway_eligible,
      record_json,
      created_at,
      updated_at
    ) values
      ('pcat_old_gateway', 'registry.opentofu.org/cloudflare/cloudflare', 'takosumi_managed', 1, '{}', '2026-06-08T00:00:00.000Z', '2026-06-08T00:00:00.000Z'),
      ('pcat_old_secret', 'registry.opentofu.org/hashicorp/aws', 'user_env_set', 0, '{}', '2026-06-08T00:00:00.000Z', '2026-06-08T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `create table provider_envs (
      id text primary key,
      space_id text,
      provider_source text not null,
      materialization text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into provider_envs (
      id,
      space_id,
      provider_source,
      materialization,
      status,
      record_json,
      created_at,
      updated_at
    ) values
      ('penv_global_old', null, 'registry.opentofu.org/cloudflare/cloudflare', 'user_env_set', 'ready', '{}', '2026-06-08T00:00:00.000Z', '2026-06-08T00:00:00.000Z'),
      ('penv_space_old', 'space_1', 'registry.opentofu.org/hashicorp/aws', 'user_env_set', 'ready', '{}', '2026-06-08T00:00:00.000Z', '2026-06-08T00:00:00.000Z')`,
    )
    .run();

  await ensureD1OpenTofuLedgerSchema(db);

  expect(await liveD1ColumnsOf(db, "connections")).toContainEqual(
    nullable("space_id"),
  );
  expect(await liveD1ColumnsOf(db, "connections")).toContainEqual(
    nn("provider"),
  );
  expect(await liveD1ColumnsOf(db, "connections")).toContainEqual(
    nn("connection_json"),
  );
  // The seeded `installations` table is renamed to `capsules`, Project is
  // backfilled and then made required, and the retired install discriminator is
  // removed by the later convergence migrations.
  expect(await liveD1ColumnsOf(db, "capsules")).toContainEqual(
    nullable("current_output_snapshot_id"),
  );
  expect(await liveD1ColumnsOf(db, "capsules")).toContainEqual(
    nullable("source_id"),
  );
  expect(await liveD1ColumnsOf(db, "capsules")).toContainEqual(
    nullable("current_state_version_id"),
  );
  expect(await liveD1ColumnsOf(db, "capsules")).toContainEqual(
    nn("project_id"),
  );
  expect(await liveD1ColumnsOf(db, "source_snapshots")).toContainEqual(
    nullable("source_id"),
  );
  const runColumns = await liveD1ColumnsOf(db, "runs");
  expect(runColumns).toContainEqual(nullable("source_id"));
  expect(runColumns).toContainEqual(nullable("installation_id"));
  expect(runColumns).toContainEqual(nullable("environment"));
  expect(await liveD1ColumnsOf(db, "credential_mint_events")).toContainEqual(
    nullable("source_id"),
  );
  const backupColumns = await liveD1ColumnsOf(db, "backups");
  expect(backupColumns).toContainEqual(nullable("installation_id"));
  expect(backupColumns).toContainEqual(nullable("environment"));
  expect(backupColumns).toContainEqual(nullable("created_by_run_id"));
  // Provider Catalog / Provider Env tables are retired (renamed aside) by
  // migration 16; the canonicalized rows live in the recoverable `_retired`
  // tables.
  const providerCatalogRows = await db
    .prepare(
      `select id, primary_materialization
      from provider_catalog_retired
      where id in ('pcat_old_gateway', 'pcat_old_secret')
      order by id`,
    )
    .all<{ id: string; primary_materialization: string }>();
  expect(providerCatalogRows.results).toEqual([
    { id: "pcat_old_gateway", primary_materialization: "secret" },
    { id: "pcat_old_secret", primary_materialization: "secret" },
  ]);
  const providerEnvRows = await db
    .prepare(
      `select id, materialization
      from provider_envs_retired
      where id in ('penv_global_old', 'penv_space_old')
      order by id`,
    )
    .all<{ id: string; materialization: string }>();
  expect(providerEnvRows.results).toEqual([
    { id: "penv_space_old", materialization: "secret" },
  ]);
});

test("Postgres Drizzle schema mirrors critical migration catalog tables", () => {
  expect(getTableName(postgresSchema.connections)).toBe("takosumi_connections");
  expect(columnsOf(postgresSchema.connections)).toEqual([
    pk("id"),
    nullable("space_id"),
    nn("provider"),
    nn("status"),
    nn("connection_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(postgresSchema.secretBlobs)).toBe(
    "takosumi_connection_secret_blobs",
  );
  expect(columnsOf(postgresSchema.secretBlobs)).toEqual([
    pk("id"),
    nn("connection_id"),
    nullable("space_id"),
    nn("kind"),
    nn("ciphertext"),
    nn("encrypted_dek"),
    nn("nonce"),
    nn("aad"),
    nn("key_version"),
    nn("created_at"),
    nullable("rotated_at"),
    nn("blob_json"),
  ]);

  expect(getTableName(postgresSchema.providerBindingSets)).toBe(
    "takosumi_provider_env_binding_sets",
  );
  expect(columnsOf(postgresSchema.providerBindingSets)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("installation_id"),
    nn("environment"),
    nn("profile_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);
  expect(pgUniqueIndexesOf(postgresSchema.providerBindingSets)).toContainEqual({
    name: "takosumi_provider_env_bindings_installation_environment_unique",
    columns: ["installation_id", "environment"],
    unique: true,
  });

  expect(getTableName(postgresSchema.capsules)).toBe("takosumi_capsules");
  expect(columnsOf(postgresSchema.capsules)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("project_id"),
    nn("name"),
    nn("environment"),
    // Physically nullable only for historical source-less Capsule rows.
    nullable("source_id"),
    nn("install_config_id"),
    nullable("current_state_version_id"),
    nn("status"),
    nn("installation_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(postgresSchema.projects)).toBe("takosumi_projects");
  expect(columnsOf(postgresSchema.projects)).toEqual([
    pk("id"),
    nn("workspace_id"),
    nn("name"),
    nn("slug"),
    nn("project_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(postgresSchema.capsuleCompatibilityReports)).toBe(
    "takosumi_capsule_compatibility_reports",
  );
  expect(columnsOf(postgresSchema.capsuleCompatibilityReports)).toEqual([
    pk("id"),
    nullable("source_id"),
    nullable("installation_id"),
    nn("source_snapshot_id"),
    nn("level"),
    nn("findings_json"),
    nn("providers_json"),
    nn("resources_json"),
    nn("data_sources_json"),
    nn("provisioners_json"),
    defaulted("root_module_variables_json"),
    defaulted("root_module_outputs_json"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.runs)).toBe("takosumi_runs");
  expect(columnsOf(postgresSchema.runs)).toEqual([
    pk("id"),
    nn("kind"),
    nn("space_id"),
    nullable("source_id"),
    nullable("installation_id"),
    nn("status"),
    nullable("lease_token"),
    nullable("heartbeat_at"),
    nn("created_at"),
    nn("run_json"),
  ]);

  expect(getTableName(postgresSchema.stateVersions)).toBe(
    "takosumi_state_versions",
  );
  expect(columnsOf(postgresSchema.stateVersions)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("installation_id"),
    nn("environment"),
    nn("generation"),
    nn("snapshot_json"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.usageEvents)).toBe(
    "takosumi_usage_events",
  );
  expect(columnsOf(postgresSchema.usageEvents)).toEqual([
    pk("id"),
    nn("workspace_id"),
    nullable("capsule_id"),
    nullable("run_id"),
    nullable("meter_id"),
    nullable("resource_family"),
    nullable("resource_id"),
    nullable("operation"),
    nullable("resource_metadata_json"),
    nn("kind"),
    nn("quantity"),
    nn("usd_micros"),
    nn("rating_status"),
    nn("source"),
    nn("idempotency_key"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.publicHostReservations)).toBe(
    "takosumi_public_host_reservations",
  );
  expect(columnsOf(postgresSchema.publicHostReservations)).toEqual([
    pk("hostname"),
    nn("owner_user_id"),
    nn("workspace_id"),
    nn("installation_id"),
    nn("installation_name"),
    nn("allocation_kind"),
    nn("status"),
    nn("reserved_at"),
    nn("updated_at"),
    nullable("released_at"),
  ]);

  expect(getTableName(postgresSchema.credentialMintEvents)).toBe(
    "takosumi_credential_mint_events",
  );
  expect(columnsOf(postgresSchema.credentialMintEvents)).toEqual([
    pk("id"),
    nn("run_id"),
    nn("space_id"),
    nullable("installation_id"),
    nullable("source_id"),
    nn("connection_id"),
    nn("phase"),
    nn("event_json"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.securityFindings)).toBe(
    "takosumi_security_findings",
  );
  expect(columnsOf(postgresSchema.securityFindings)).toEqual([
    pk("id"),
    nn("space_id"),
    nullable("installation_id"),
    nullable("run_id"),
    nn("severity"),
    nn("type"),
    nn("finding_json"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.runGroups)).toBe("takosumi_run_groups");
  expect(columnsOf(postgresSchema.runGroups)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("type"),
    nn("group_json"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.auditEvents)).toBe(
    "takosumi_audit_events",
  );
  expect(columnsOf(postgresSchema.auditEvents)).toEqual([
    pk("id"),
    nn("space_id"),
    nullable("actor_id"),
    nn("action"),
    nn("target_type"),
    nn("target_id"),
    nullable("run_id"),
    nn("created_at"),
    nn("event_json"),
  ]);

  expect(getTableName(postgresSchema.backups)).toBe("takosumi_backups");
  expect(columnsOf(postgresSchema.backups)).toEqual([
    pk("id"),
    nn("space_id"),
    nullable("installation_id"),
    nullable("environment"),
    nullable("created_by_run_id"),
    nn("backup_json"),
    nn("created_at"),
  ]);
});

type NameNotNull = { name: string; notNull: boolean };

const nameNotNull = (columns: readonly ColumnMirror[]): NameNotNull[] =>
  columns
    .map((column) => ({ name: column.name, notNull: column.notNull }))
    .sort((left, right) => left.name.localeCompare(right.name));

async function livePgColumnsOf(
  client: PGliteSqlClient,
  tableName: string,
): Promise<NameNotNull[]> {
  const result = await client.rawQuery<{
    column_name: string;
    is_nullable: string;
  }>(
    `select column_name, is_nullable from information_schema.columns ` +
      `where table_name = '${tableName}'`,
  );
  return result.rows
    .map((row) => ({
      name: row.column_name,
      notNull: row.is_nullable === "NO",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function livePgIndexesOf(
  client: PGliteSqlClient,
  tableName: string,
): Promise<UniqueIndexMirror[]> {
  const result = await client.rawQuery<{
    name: string;
    unique: boolean;
    columns: string[];
  }>(
    `select c2.relname as name,
            ix.indisunique as unique,
            array_agg(a.attname order by ord.ordinality) as columns
       from pg_class t
       join pg_index ix on t.oid = ix.indrelid
       join pg_class c2 on c2.oid = ix.indexrelid
       join unnest(ix.indkey) with ordinality as ord(attnum, ordinality) on true
       join pg_attribute a on a.attrelid = t.oid and a.attnum = ord.attnum
      where t.relname = '${tableName}'
        and not ix.indisprimary
      group by c2.relname, ix.indisunique
      order by c2.relname`,
  );
  return normalizeIndexes(
    result.rows.map((row) => ({
      name: row.name,
      columns: row.columns,
      unique: row.unique,
    })),
  );
}

// Single source of truth: the migration catalog's END-STATE schema (applied on
// in-process PGlite) must match the Postgres Drizzle schema column-for-column
// for every deploy-control table — so a Drizzle change without a migration (or
// vice versa) fails CI instead of silently 42P01-ing in production.
test("Postgres migration end-state mirrors the Drizzle schema for every deploy table", async () => {
  const client = await PGliteSqlClient.create();
  try {
    for (const logicalName of deployControlLogicalTables) {
      const table = postgresSchema[logicalName];
      const tableName = getTableName(table);
      const live = await livePgColumnsOf(client, tableName);
      expect(live, tableName).toEqual(nameNotNull(columnsOf(table)));
    }
  } finally {
    await client.close();
  }
});

test("Postgres migration end-state mirrors Drizzle indexes for every deploy table", async () => {
  const client = await PGliteSqlClient.create();
  try {
    for (const logicalName of deployControlLogicalTables) {
      const table = postgresSchema[logicalName];
      const tableName = getTableName(table);
      expect(await livePgIndexesOf(client, tableName), tableName).toEqual(
        pgUniqueIndexesOf(table),
      );
    }
  } finally {
    await client.close();
  }
});

test("Postgres migration normalizes historical InstallConfig defaults once", async () => {
  const migration = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.install_config_variable_defaults.normalize",
  );
  expect(migration).toBeDefined();
  const db = new PGlite();
  try {
    await db.exec(`create table takosumi_install_configs (
      id text primary key,
      config_json jsonb not null
    )`);
    await db.exec(`insert into takosumi_install_configs values (
      'cfg_legacy_defaults',
      '{"variablePresentation":[
        {"name":"name","defaultValue":"service-name"},
        {"name":"scoped","defaultValue":"service-name-with-workspace"},
        {"name":"region","defaultValue":"global"},
        {"name":"count","defaultValue":{"source":"literal","value":3}}
      ]}'::jsonb
    )`);
    for (const statement of splitSqlStatements(migration!.sql)) {
      await db.exec(statement);
    }
    const result = await db.query<{
      config_json: string | Record<string, unknown>;
    }>(
      `select config_json from takosumi_install_configs where id = 'cfg_legacy_defaults'`,
    );
    const raw = result.rows[0]!.config_json;
    const config = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      readonly variablePresentation: readonly {
        readonly defaultValue: unknown;
      }[];
    };
    expect(
      config.variablePresentation.map((item) => item.defaultValue),
    ).toEqual([
      { source: "capsule_name" },
      { source: "workspace_scoped_capsule_name" },
      { source: "literal", value: "global" },
      { source: "literal", value: 3 },
    ]);
  } finally {
    await db.close();
  }
});

test("billing USD micros migration backfills legacy credit rows", async () => {
  const migration = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.billing_usd_micros_columns.add",
  );
  expect(migration).toBeDefined();

  const db = new PGlite();
  try {
    await db.exec(`create table takosumi_plans (
      id text primary key,
      name text not null,
      monthly_base_price integer not null,
      included_credits integer not null,
      limits_json jsonb not null,
      plan_json jsonb not null,
      created_at text not null,
      updated_at text not null
    )`);
    await db.exec(`create table takosumi_credit_balances (
      space_id text primary key,
      available_credits integer not null,
      reserved_credits integer not null,
      monthly_included_credits integer not null,
      purchased_credits integer not null,
      updated_at text not null
    )`);
    await db.exec(`create table takosumi_usage_events (
      id text primary key,
      credits integer not null,
      source text not null
    )`);
    await db.exec(`create table takosumi_credit_reservations (
      id text primary key,
      estimated_credits integer not null
    )`);
    await db.exec(
      `insert into takosumi_plans values ('pro', 'Pro', 20, 12, '{}', '{}', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    );
    await db.exec(
      `insert into takosumi_credit_balances values ('space_1', 42, 3, 10, 35, '2026-06-01T00:00:00.000Z')`,
    );
    await db.exec(
      `insert into takosumi_usage_events values ('usage_invoice', 4, 'billing_reconciliation')`,
    );
    await db.exec(
      `insert into takosumi_credit_reservations values ('creditres_1', 5)`,
    );

    for (const statement of splitSqlStatements(migration!.sql)) {
      await db.exec(statement);
    }

    const plan = await db.query<{ included_usd_micros: number }>(
      `select included_usd_micros from takosumi_plans where id = 'pro'`,
    );
    expect(plan.rows[0]?.included_usd_micros).toBe(12_000_000);
    const balance = await db.query<{
      available_usd_micros: number;
      reserved_usd_micros: number;
      monthly_included_usd_micros: number;
      purchased_usd_micros: number;
    }>(
      `select available_usd_micros, reserved_usd_micros,
              monthly_included_usd_micros, purchased_usd_micros
       from takosumi_credit_balances where space_id = 'space_1'`,
    );
    expect(balance.rows[0]).toEqual({
      available_usd_micros: 42_000_000,
      reserved_usd_micros: 3_000_000,
      monthly_included_usd_micros: 10_000_000,
      purchased_usd_micros: 35_000_000,
    });
    const usage = await db.query<{ usd_micros: number }>(
      `select usd_micros from takosumi_usage_events where id = 'usage_invoice'`,
    );
    expect(usage.rows[0]?.usd_micros).toBe(4_000_000);
    const reservation = await db.query<{ estimated_usd_micros: number }>(
      `select estimated_usd_micros from takosumi_credit_reservations where id = 'creditres_1'`,
    );
    expect(reservation.rows[0]?.estimated_usd_micros).toBe(5_000_000);

    await db.exec(
      `insert into takosumi_plans (
        id, name, monthly_base_price, included_credits,
        limits_json, plan_json, created_at, updated_at
      ) values (
        'lite', 'Lite', 0, 2, '{}', '{}',
        '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
      )`,
    );
    const insertedPlan = await db.query<{ included_usd_micros: number }>(
      `select included_usd_micros from takosumi_plans where id = 'lite'`,
    );
    expect(insertedPlan.rows[0]?.included_usd_micros).toBe(2_000_000);
    await db.exec(
      `update takosumi_credit_balances
       set available_credits = 7, reserved_credits = 4
       where space_id = 'space_1'`,
    );
    const updatedBalance = await db.query<{
      available_usd_micros: number;
      reserved_usd_micros: number;
    }>(
      `select available_usd_micros, reserved_usd_micros
       from takosumi_credit_balances where space_id = 'space_1'`,
    );
    expect(updatedBalance.rows[0]).toEqual({
      available_usd_micros: 7_000_000,
      reserved_usd_micros: 4_000_000,
    });
    await db.exec(
      `insert into takosumi_usage_events (id, credits, source)
       values ('usage_after_migration', 9, 'manual')`,
    );
    const insertedUsage = await db.query<{ usd_micros: number }>(
      `select usd_micros from takosumi_usage_events where id = 'usage_after_migration'`,
    );
    expect(insertedUsage.rows[0]?.usd_micros).toBe(9_000_000);
    await db.exec(
      `update takosumi_credit_reservations
       set estimated_credits = 6
       where id = 'creditres_1'`,
    );
    const updatedReservation = await db.query<{
      estimated_usd_micros: number;
    }>(
      `select estimated_usd_micros from takosumi_credit_reservations where id = 'creditres_1'`,
    );
    expect(updatedReservation.rows[0]?.estimated_usd_micros).toBe(6_000_000);
  } finally {
    await db.close();
  }
});

test("Postgres public host reservation backfill prefers active Capsule outputs", async () => {
  const create = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.public_host_reservations.create",
  );
  const backfill = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.public_host_reservations.backfill",
  );
  expect(create).toBeDefined();
  expect(backfill).toBeDefined();

  const db = new PGlite();
  try {
    await db.exec(`create table takosumi_capsules (
      id text primary key,
      space_id text not null,
      name text not null,
      environment text not null,
      source_id text,
      install_config_id text not null,
      current_state_version_id text,
      status text not null,
      installation_json jsonb not null,
      created_at text not null,
      updated_at text not null
    )`);
    await db.exec(`create table takosumi_outputs (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      state_generation integer not null,
      snapshot_json jsonb not null,
      created_at text not null
    )`);
    for (const statement of splitSqlStatements(create!.sql)) {
      await db.exec(statement);
    }
    await db.exec(`
      insert into takosumi_outputs values
        (
          'out_stale', 'space_stale', 'inst_stale', 1,
          '{"publicOutputs":{"url":"https://shared.app.takos.jp"},"workspaceOutputs":{}}',
          '2026-06-06T00:00:00.000Z'
        ),
        (
          'out_active', 'space_active', 'inst_active', 1,
          '{"publicOutputs":{},"workspaceOutputs":{"app_url":"https://shared.app.takos.jp"}}',
          '2026-06-06T00:01:00.000Z'
        ),
        (
          'out_preview', 'space_preview', 'inst_preview', 1,
          '{"publicOutputs":{"url":"https://preview.workers.dev"},"workspaceOutputs":{}}',
          '2026-06-06T00:02:00.000Z'
        )
    `);
    await db.exec(`
      insert into takosumi_capsules values
        (
          'inst_stale', 'space_stale', 'Shared Stale', 'preview', null,
          'cfg_stale', 'sv_stale', 'stale',
          '{"id":"inst_stale","workspaceId":"space_stale","currentOutputId":"out_stale","currentStateGeneration":1}',
          '2026-06-06T00:00:00.000Z', '2026-06-06T00:00:00.000Z'
        ),
        (
          'inst_active', 'space_active', 'Shared Active', 'preview', null,
          'cfg_active', 'sv_active', 'active',
          '{"id":"inst_active","workspaceId":"space_active","currentOutputId":"out_active","currentStateGeneration":1}',
          '2026-06-06T00:01:00.000Z', '2026-06-06T00:01:00.000Z'
        ),
        (
          'inst_preview', 'space_preview', 'Preview', 'preview', null,
          'cfg_preview', 'sv_preview', 'active',
          '{"id":"inst_preview","workspaceId":"space_preview","currentOutputId":"out_preview","currentStateGeneration":1}',
          '2026-06-06T00:02:00.000Z', '2026-06-06T00:02:00.000Z'
        )
    `);

    for (const statement of splitSqlStatements(backfill!.sql)) {
      await db.exec(statement);
    }
    // Re-run once to guard idempotency and same-owner conflict handling.
    for (const statement of splitSqlStatements(backfill!.sql)) {
      await db.exec(statement);
    }

    const shared = await db.query<{
      workspace_id: string;
      installation_id: string;
      installation_name: string;
      status: string;
    }>(
      `select workspace_id, installation_id, installation_name, status
       from takosumi_public_host_reservations
       where hostname = 'shared.app.takos.jp'`,
    );
    expect(shared.rows).toEqual([
      {
        workspace_id: "space_active",
        installation_id: "inst_active",
        installation_name: "Shared Active",
        status: "reserved",
      },
    ]);

    const preview = await db.query<{ n: number }>(
      `select count(*)::int as n
       from takosumi_public_host_reservations
       where hostname = 'preview.workers.dev'`,
    );
    expect(preview.rows[0]?.n).toBe(0);
  } finally {
    await db.close();
  }
});

test("Postgres owner-slot migrations grandfather legacy reservations", async () => {
  const create = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.public_host_reservations.create",
  );
  const ownerSlots = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.public_host_reservations.owner_slots",
  );
  const grandfather = postgresStorageMigrationStatements.find(
    (entry) =>
      entry.id === "deploy.public_host_reservations.legacy_grandfather",
  );
  expect(create).toBeDefined();
  expect(ownerSlots).toBeDefined();
  expect(grandfather).toBeDefined();

  const db = new PGlite();
  try {
    await db.exec(`create table takosumi_workspaces (
      id text primary key,
      space_json jsonb not null
    )`);
    for (const statement of splitSqlStatements(create!.sql)) {
      await db.exec(statement);
    }
    await db.exec(`insert into takosumi_workspaces values
      ('workspace_alpha', '{"handle":"alpha","ownerUserId":"owner_same"}'),
      ('workspace_beta', '{"handle":"beta","ownerUserId":"owner_same"}')`);
    await db.exec(`insert into takosumi_public_host_reservations (
      hostname, workspace_id, installation_id, installation_name,
      status, reserved_at, updated_at, released_at
    ) values
      ('alpha-app.app.takos.jp', 'workspace_alpha', 'capsule_scoped', 'scoped',
       'reserved', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', null),
      ('short-name.app.takos.jp', 'workspace_beta', 'capsule_vanity', 'vanity',
       'reserved', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', null)`);

    for (const statement of splitSqlStatements(ownerSlots!.sql)) {
      await db.exec(statement);
    }
    for (const statement of splitSqlStatements(grandfather!.sql)) {
      await db.exec(statement);
    }
    for (const statement of splitSqlStatements(grandfather!.sql)) {
      await db.exec(statement);
    }
    for (const statement of splitSqlStatements(ownerSlots!.sql)) {
      await db.exec(statement);
    }

    const rows = await db.query<{
      hostname: string;
      owner_user_id: string;
      allocation_kind: string;
    }>(`select hostname, owner_user_id, allocation_kind
        from takosumi_public_host_reservations
        order by hostname`);
    expect(rows.rows).toEqual([
      {
        hostname: "alpha-app.app.takos.jp",
        owner_user_id: "owner_same",
        allocation_kind: "scoped",
      },
      {
        hostname: "short-name.app.takos.jp",
        owner_user_id: "owner_same",
        allocation_kind: "scoped",
      },
    ]);
  } finally {
    await db.close();
  }
});

// Sharper guard for the table this wave reshapes: the runs ledger must carry the
// status / lease_token / heartbeat_at columns in both the migration end-state
// and the Drizzle schema, with matching nullability.
test("takosumi_runs migration end-state carries the lease columns", async () => {
  const client = await PGliteSqlClient.create();
  try {
    const live = await livePgColumnsOf(client, "takosumi_runs");
    expect(live).toEqual(nameNotNull(columnsOf(postgresSchema.runs)));
    expect(live).toContainEqual({ name: "status", notNull: true });
    expect(live).toContainEqual({ name: "lease_token", notNull: false });
    expect(live).toContainEqual({ name: "heartbeat_at", notNull: false });
  } finally {
    await client.close();
  }
});

test("Postgres migration end-state retires the Provider Catalog / Provider Env tables", async () => {
  const client = await PGliteSqlClient.create();
  try {
    // The live tables are renamed aside (non-destructive) by the credential
    // collapse migration; only the recoverable `_retired` names remain.
    const liveCatalog = await client.rawQuery<{ n: number }>(
      `select count(*)::int as n from information_schema.tables ` +
        `where table_name = 'takosumi_provider_catalog'`,
    );
    expect(liveCatalog.rows[0]?.n).toBe(0);
    const liveEnvs = await client.rawQuery<{ n: number }>(
      `select count(*)::int as n from information_schema.tables ` +
        `where table_name = 'takosumi_provider_envs'`,
    );
    expect(liveEnvs.rows[0]?.n).toBe(0);
    const retired = await client.rawQuery<{ name: string }>(
      `select table_name as name from information_schema.tables ` +
        `where table_name in ('takosumi_provider_catalog_retired', 'takosumi_provider_envs_retired') ` +
        `order by table_name`,
    );
    expect(retired.rows.map((row) => row.name)).toEqual([
      "takosumi_provider_catalog_retired",
      "takosumi_provider_envs_retired",
    ]);
  } finally {
    await client.close();
  }
});
