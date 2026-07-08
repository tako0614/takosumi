import { readdirSync, readFileSync } from "node:fs";
import { test } from "bun:test";
import {
  postgresStorageMigrationStatements,
  postgresStorageTableDefinitions,
} from "../../../../core/adapters/storage/migrations.ts";

const migrationFilesUrl = new URL(
  "../../../../core/db/migrations/",
  import.meta.url,
);

const mirroredMigrationFiles: readonly {
  readonly fileName: string;
  readonly migrationId: string;
}[] = [
  {
    fileName: "20260430000011_runtime_agent_work_ledger.sql",
    migrationId: "runtime.agent_work_ledger.create",
  },
  {
    fileName: "20260430000012_audit_hash_chain_and_retention.sql",
    migrationId: "audit.hash_chain_and_retention.add",
  },
  {
    fileName: "20260430000013_runtime_materialization_state.sql",
    migrationId: "runtime.materialization_state.create",
  },
  {
    fileName: "20260430000015_service_endpoints.sql",
    migrationId: "service_endpoints.tables.create",
  },
  {
    fileName: "20260430000016_custom_domain_reservations.sql",
    migrationId: "custom_domain.reservations.create",
  },
  {
    fileName: "20260430000019_replay_protection_log.sql",
    migrationId: "internal_auth.replay_protection_log.create",
  },
  {
    fileName: "20260430000022_takosumi_deployment_record_locks.sql",
    migrationId: "deploy.takosumi_deployment_record_locks.create",
  },
  {
    fileName: "20260430000024_takosumi_revoke_debts.sql",
    migrationId: "deploy.takosumi_revoke_debts.create",
  },
  {
    fileName: "20260430000025_catalog_releases.sql",
    migrationId: "registry.catalog_releases.create",
  },
  {
    fileName: "20260430000043_takosumi_provider_templates.sql",
    migrationId: "deploy.takosumi_provider_templates.create",
  },
  {
    fileName: "20260430000045_takosumi_provider_template_dead_tables.sql",
    migrationId: "deploy.takosumi_provider_template_dead_tables.drop",
  },
  {
    fileName: "20260430000048_takosumi_provider_catalog.sql",
    migrationId: "deploy.provider_catalog_table.rename",
  },
  {
    fileName: "20260430000049_provider_envs_current_shape.sql",
    migrationId: "deploy.provider_envs.current_shape",
  },
  {
    fileName: "20260430000050_provider_materialization_values.sql",
    migrationId: "deploy.provider_materialization_values.canonicalize",
  },
  {
    fileName: "20260430000051_postgres_named_index_parity.sql",
    migrationId: "deploy.postgres_named_index_parity.normalize",
  },
  {
    fileName: "20260430000065_capsules_active_name_unique.sql",
    migrationId: "deploy.capsules_active_name_unique",
  },
];

test("migration catalog creates every declared storage table", () => {
  const migrationSql = postgresStorageMigrationStatements
    .map((migration) => migration.sql)
    .join("\n");
  const materializedTables = new Set([
    ...extractCreatedTables(migrationSql),
    ...extractRenameTargets(migrationSql),
  ]);
  for (const definition of postgresStorageTableDefinitions) {
    assert(
      materializedTables.has(definition.name),
      `missing migration table materialization for ${definition.name}`,
    );
  }
});

test("migration SQL files do not drift from the storage catalog", () => {
  const migrationsById = new Map(
    postgresStorageMigrationStatements.map((migration) => [
      migration.id,
      migration,
    ]),
  );
  const expectedFiles = new Set(
    mirroredMigrationFiles.map((entry) => entry.fileName),
  );
  const actualFiles = new Set(listMigrationSqlFiles());
  assertEquals(actualFiles, expectedFiles);

  for (const entry of mirroredMigrationFiles) {
    const migration = migrationsById.get(entry.migrationId);
    assert(
      migration,
      `${entry.fileName} maps to missing catalog migration ${entry.migrationId}`,
    );
    const fileSql = readFileSync(
      new URL(entry.fileName, migrationFilesUrl),
      "utf8",
    );
    assert(
      fileSql.startsWith(
        `-- Migration: ${entry.fileName.replace(/\.sql$/, "")}`,
      ),
      `${entry.fileName} has a stale migration marker`,
    );
    assertEquals(
      normalizeExecutableSql(fileSql),
      normalizeExecutableSql(migration.sql),
    );
  }
});

test("migration SQL files have unique timestamp prefixes", () => {
  const seen = new Map<string, string>();
  for (const fileName of listMigrationSqlFiles()) {
    const match = /^(\d{14})_/.exec(fileName);
    assert(match, `${fileName} must start with a 14-digit timestamp prefix`);
    const existing = seen.get(match[1]);
    assert(
      !existing,
      `${fileName} duplicates timestamp prefix ${match[1]} from ${existing}`,
    );
    seen.set(match[1], fileName);
  }
});

function extractCreatedTables(sql: string): Set<string> {
  const tables = new Set<string>();
  const pattern =
    /\bcreate\s+table\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)\b/gi;
  for (const match of sql.matchAll(pattern)) tables.add(match[1]);
  return tables;
}

function extractRenameTargets(sql: string): Set<string> {
  const tables = new Set<string>();
  const pattern =
    /\balter\s+table\s+if\s+exists\s+[a-z_][a-z0-9_]*\s+rename\s+to\s+([a-z_][a-z0-9_]*)\b/gi;
  for (const match of sql.matchAll(pattern)) tables.add(match[1]);
  return tables;
}

function listMigrationSqlFiles(): readonly string[] {
  return readdirSync(migrationFilesUrl, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

function normalizeExecutableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/;+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(normalize(actual));
  const expectedJson = JSON.stringify(normalize(expected));
  if (actualJson !== expectedJson) {
    throw new Error(`assertEquals failed: ${actualJson} !== ${expectedJson}`);
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  return value;
}
