import { expect, test } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import * as d1Schema from "./d1.ts";
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
    nn("space_id"),
    nn("status"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);

  expect(getTableName(d1Schema.secretBlobs)).toBe("secret_blobs");
  expect(columnsOf(d1Schema.secretBlobs)).toEqual([
    pk("connection_id"),
    nn("blob_json"),
  ]);

  expect(getTableName(d1Schema.operatorConnectionDefaults)).toBe(
    "operator_connection_defaults",
  );
  expect(columnsOf(d1Schema.operatorConnectionDefaults)).toEqual([
    pk("id"),
    nn("capability"),
    nn("provider"),
    nn("connection_id"),
    nn("record_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);
  expect(
    sqliteUniqueIndexesOf(d1Schema.operatorConnectionDefaults),
  ).toContainEqual({
    name: "operator_connection_defaults_capability_idx",
    columns: ["capability"],
    unique: true,
  });

  expect(getTableName(d1Schema.installations)).toBe("installations");
  expect(columnsOf(d1Schema.installations)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("name"),
    nn("slug"),
    nn("source_id"),
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
    nullable("source_snapshot_id"),
    nullable("dependency_snapshot_id"),
    nn("state_generation"),
    nullable("output_snapshot_id"),
    nn("outputs_public_json"),
    nn("status"),
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

  expect(getTableName(d1Schema.spaceSubscriptions)).toBe(
    "space_subscriptions",
  );
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

  expect(getTableName(d1Schema.creditReservations)).toBe(
    "credit_reservations",
  );
  expect(columnsOf(d1Schema.creditReservations)).toEqual([
    pk("id"),
    nn("space_id"),
    nn("run_id"),
    nn("estimated_credits"),
    nn("status"),
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
    nn("installation_id"),
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
    nn("record_json"),
    nn("created_at"),
  ]);
});

test("Postgres Drizzle schema mirrors critical migration catalog tables", () => {
  expect(getTableName(postgresSchema.connections)).toBe("takosumi_connections");
  expect(columnsOf(postgresSchema.connections)).toEqual([
    pk("id"),
    nn("space_id"),
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
    pk("connection_id"),
    nn("blob_json"),
  ]);

  expect(getTableName(postgresSchema.operatorConnectionDefaults)).toBe(
    "takosumi_operator_connection_defaults",
  );
  expect(columnsOf(postgresSchema.operatorConnectionDefaults)).toEqual([
    pk("id"),
    nn("capability"),
    nn("provider"),
    nn("connection_id"),
    nn("default_json"),
    nn("created_at"),
    nn("updated_at"),
  ]);
  expect(
    pgUniqueIndexesOf(postgresSchema.operatorConnectionDefaults),
  ).toContainEqual({
    name: "takosumi_operator_connection_defaults_capability_unique",
    columns: ["capability"],
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
    nn("source_id"),
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
    nn("installation_id"),
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
    nn("backup_json"),
    nn("created_at"),
  ]);
});
