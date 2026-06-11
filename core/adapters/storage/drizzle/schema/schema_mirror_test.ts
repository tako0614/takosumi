import { expect, test } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { ensureD1OpenTofuLedgerSchema } from "../../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../../domains/deploy-control/sqlite_fake_d1.ts";
import * as d1Schema from "./d1.ts";
import { deployControlLogicalTables } from "./logical.ts";
import * as postgresSchema from "./postgres.ts";

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
  return getSqliteTableConfig(table).indexes.map((index) => {
    const config = index.config as {
      name: string;
      columns: Array<{ name: string }>;
      unique: boolean;
    };
    return {
      name: config.name,
      columns: config.columns.map((column) => column.name),
      unique: config.unique,
    };
  });
}

function pgUniqueIndexesOf(
  table: Parameters<typeof getPgTableConfig>[0],
): UniqueIndexMirror[] {
  return getPgTableConfig(table).indexes.map((index) => {
    const config = index.config as {
      name: string;
      columns: Array<{ name: string }>;
      unique: boolean;
    };
    return {
      name: config.name,
      columns: config.columns.map((column) => column.name),
      unique: config.unique,
    };
  });
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

  expect(getTableName(d1Schema.operatorConnectionDefaults)).toBe(
    "operator_connection_defaults",
  );
  expect(columnsOf(d1Schema.operatorConnectionDefaults)).toEqual([
    pk("id"),
    nn("provider"),
    nn("connection_id"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);
  expect(
    sqliteUniqueIndexesOf(d1Schema.operatorConnectionDefaults),
  ).toContainEqual({
    name: "operator_connection_defaults_provider_idx",
    columns: ["provider"],
    unique: true,
  });

  expect(getTableName(d1Schema.installations)).toBe("installations");
  expect(columnsOf(d1Schema.installations)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("name"),
    nn("slug"),
    // Nullable: upload-origin installations (takosumi deploy) have no Source.
    nullable("source_id"),
    nn("install_type"),
    nn("install_config_id"),
    nn("environment"),
    nullable("current_deployment_id"),
    defaulted("current_state_generation"),
    nullable("current_output_snapshot_id"),
    nn("status"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

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
    nullable("normalized_object_key"),
    nullable("normalized_digest"),
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
    nn("run_json"),
    defaulted("created_at"),
  ]);

  expect(getTableName(d1Schema.stateSnapshots)).toBe("state_snapshots");
  expect(columnsOf(d1Schema.stateSnapshots)).toEqual([
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

  expect(getTableName(d1Schema.deployments)).toBe("deployments");
  expect(columnsOf(d1Schema.deployments)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("installation_id"),
    nn("environment"),
    nn("apply_run_id"),
    nn("source_snapshot_id"),
    nullable("dependency_snapshot_id"),
    nn("state_generation"),
    nn("output_snapshot_id"),
    nn("outputs_public_json"),
    nn("status"),
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

  expect(getTableName(d1Schema.billingAccounts)).toBe("billing_accounts");
  expect(columnsOf(d1Schema.billingAccounts)).toEqual([
    pk("id"),
    nn("owner_type"),
    nn("owner_id"),
    nn("provider"),
    nn("status"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(d1Schema.billingPlans)).toBe("plans");
  expect(columnsOf(d1Schema.billingPlans)).toEqual([
    pk("id"),
    nn("name"),
    nn("monthly_base_price"),
    nn("included_credits"),
    nn("limits_json"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(d1Schema.spaceSubscriptions)).toBe("space_subscriptions");
  expect(columnsOf(d1Schema.spaceSubscriptions)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("billing_account_id"),
    nn("plan_id"),
    nn("status"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(d1Schema.creditBalances)).toBe("credit_balances");
  expect(columnsOf(d1Schema.creditBalances)).toEqual([
    pk("space_id"),
    nn("available_credits"),
    nn("reserved_credits"),
    nn("monthly_included_credits"),
    nn("purchased_credits"),
    nn("updated_at"),
  ]);

  expect(getTableName(d1Schema.usageEvents)).toBe("usage_events");
  expect(columnsOf(d1Schema.usageEvents)).toEqual([
    pk("id"),
    nn("space_id"),
    nullable("installation_id"),
    nullable("run_id"),
    nn("kind"),
    nn("quantity"),
    nn("credits"),
    nn("source"),
    nn("idempotency_key"),
    nn("created_at"),
  ]);

  expect(getTableName(d1Schema.creditReservations)).toBe("credit_reservations");
  expect(columnsOf(d1Schema.creditReservations)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("run_id"),
    nn("estimated_credits"),
    nn("status"),
    nn("mode"),
    nn("record_json"),
    nn("created_at"),
    nn("expires_at"),
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

test("Worker D1 bootstrap additively migrates older ledger tables", async () => {
  const db = new SqliteFakeD1();
	  await db.prepare(
	    `create table connections (
	      id text primary key,
	      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
  ).run();
  await db.prepare(
    `create table installations (
      id text primary key,
      space_id text not null,
      name text not null,
      slug text not null,
      source_id text not null,
      install_type text not null,
      install_config_id text not null,
      environment text not null,
      current_deployment_id text,
      current_state_generation integer not null default 0,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null,
      unique (space_id, name, environment)
    )`,
  ).run();
  await db.prepare(
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
  ).run();
  await db.prepare(
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
  ).run();
  await db.prepare(
    `create table credit_reservations (
      id text primary key,
      space_id text not null,
      run_id text not null,
      estimated_credits integer not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      expires_at text not null
    )`,
  ).run();
  await db.prepare(
    `insert into credit_reservations (
      id,
      space_id,
      run_id,
      estimated_credits,
      status,
      record_json,
      created_at,
      expires_at
    ) values (
      'cr_old',
      'space_1',
      'run_1',
      10,
      'reserved',
      '{}',
      '2026-06-08T00:00:00.000Z',
      '2026-06-08T01:00:00.000Z'
    )`,
  ).run();
  await db.prepare(
    `create table backups (
      id text primary key,
      space_id text not null,
      record_json text not null,
      created_at text not null
    )`,
  ).run();

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
  expect(await liveD1ColumnsOf(db, "installations")).toContainEqual(
    nullable("current_output_snapshot_id"),
  );
  const runColumns = await liveD1ColumnsOf(db, "runs");
  expect(runColumns).toContainEqual(nullable("source_id"));
  expect(runColumns).toContainEqual(nullable("installation_id"));
  expect(runColumns).toContainEqual(nullable("environment"));
  expect(await liveD1ColumnsOf(db, "credential_mint_events")).toContainEqual(
    nullable("source_id"),
  );
  expect(await liveD1ColumnsOf(db, "credit_reservations")).toContainEqual(
    defaulted("mode"),
  );
  const migratedReservation = await db
    .prepare(`select mode from credit_reservations where id = 'cr_old'`)
    .first<{ mode: string }>();
  expect(migratedReservation?.mode).toBe("disabled");
  const backupColumns = await liveD1ColumnsOf(db, "backups");
  expect(backupColumns).toContainEqual(nullable("installation_id"));
  expect(backupColumns).toContainEqual(nullable("environment"));
  expect(backupColumns).toContainEqual(nullable("created_by_run_id"));
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

  expect(getTableName(postgresSchema.operatorConnectionDefaults)).toBe(
    "takosumi_operator_connection_defaults",
  );
  expect(columnsOf(postgresSchema.operatorConnectionDefaults)).toEqual([
    pk("id"),
    nn("provider"),
    nn("connection_id"),
    nn("default_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);
  expect(
    pgUniqueIndexesOf(postgresSchema.operatorConnectionDefaults),
  ).toContainEqual({
    name: "takosumi_operator_connection_defaults_provider_unique",
    columns: ["provider"],
    unique: true,
  });

  expect(getTableName(postgresSchema.installations)).toBe(
    "takosumi_opentofu_installations",
  );
  expect(columnsOf(postgresSchema.installations)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("name"),
    nn("environment"),
    // Nullable: upload-origin installations (takosumi deploy) have no Source.
    nullable("source_id"),
    nn("install_config_id"),
    nullable("current_deployment_id"),
    nn("status"),
    nn("installation_json"),
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
    nullable("normalized_object_key"),
    nullable("normalized_digest"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.runs)).toBe("takosumi_runs");
  expect(columnsOf(postgresSchema.runs)).toEqual([
    pk("id"),
    nn("kind"),
    nn("space_id"),
    nullable("source_id"),
    nullable("installation_id"),
    nn("created_at"),
    nn("run_json"),
  ]);

  expect(getTableName(postgresSchema.stateSnapshots)).toBe(
    "takosumi_state_snapshots",
  );
  expect(columnsOf(postgresSchema.stateSnapshots)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("installation_id"),
    nn("environment"),
    nn("generation"),
    nn("snapshot_json"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.deployments)).toBe(
    "takosumi_opentofu_deployments",
  );
  expect(columnsOf(postgresSchema.deployments)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("installation_id"),
    nn("environment"),
    nn("apply_run_id"),
    nn("source_snapshot_id"),
    nullable("dependency_snapshot_id"),
    nn("state_generation"),
    nn("output_snapshot_id"),
    nn("status"),
    nn("deployment_json"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.billingAccounts)).toBe(
    "takosumi_billing_accounts",
  );
  expect(columnsOf(postgresSchema.billingAccounts)).toEqual([
    pk("id"),
    nn("owner_type"),
    nn("owner_id"),
    nn("provider"),
    nn("status"),
    nn("account_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(postgresSchema.billingPlans)).toBe("takosumi_plans");
  expect(columnsOf(postgresSchema.billingPlans)).toEqual([
    pk("id"),
    nn("name"),
    nn("monthly_base_price"),
    nn("included_credits"),
    nn("limits_json"),
    nn("plan_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(postgresSchema.spaceSubscriptions)).toBe(
    "takosumi_space_subscriptions",
  );
  expect(columnsOf(postgresSchema.spaceSubscriptions)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("billing_account_id"),
    nn("plan_id"),
    nn("status"),
    nn("subscription_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(postgresSchema.creditBalances)).toBe(
    "takosumi_credit_balances",
  );
  expect(columnsOf(postgresSchema.creditBalances)).toEqual([
    pk("space_id"),
    nn("available_credits"),
    nn("reserved_credits"),
    nn("monthly_included_credits"),
    nn("purchased_credits"),
    nn("updated_at"),
  ]);

  expect(getTableName(postgresSchema.usageEvents)).toBe(
    "takosumi_usage_events",
  );
  expect(columnsOf(postgresSchema.usageEvents)).toEqual([
    pk("id"),
    nn("space_id"),
    nullable("installation_id"),
    nullable("run_id"),
    nn("kind"),
    nn("quantity"),
    nn("credits"),
    nn("source"),
    nn("idempotency_key"),
    nn("created_at"),
  ]);

  expect(getTableName(postgresSchema.creditReservations)).toBe(
    "takosumi_credit_reservations",
  );
  expect(columnsOf(postgresSchema.creditReservations)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("run_id"),
    nn("estimated_credits"),
    nn("status"),
    nn("mode"),
    nn("reservation_json"),
    nn("created_at"),
    nn("expires_at"),
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
