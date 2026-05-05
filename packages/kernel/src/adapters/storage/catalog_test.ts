import {
  postgresStorageMigrationStatements,
  postgresStorageTableDefinitions,
} from "./migrations.ts";
import { storageStatementCatalog } from "./statements.ts";

const removedDeployTables = new Set([
  "deploy_plans",
  "deploy_activation_records",
  "deploy_group_activation_pointers",
  "deploy_operation_records",
]);

const migrationFilesUrl = new URL("../../../db/migrations/", import.meta.url);

const mirroredMigrationFiles: readonly {
  readonly fileName: string;
  readonly migrationId: string;
}[] = [
  {
    fileName: "20260430000010_unify_to_deployments.sql",
    migrationId: "deploy.unify_to_deployments",
  },
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
    fileName: "20260430000014_usage_aggregates.sql",
    migrationId: "usage.aggregates.create",
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
    fileName: "20260430000017_group_head_history.sql",
    migrationId: "deploy.group_head_history.create",
  },
  {
    fileName: "20260430000018_observation_retention_archived.sql",
    migrationId: "deploy.provider_observations.archived",
  },
  {
    fileName: "20260430000019_replay_protection_log.sql",
    migrationId: "internal_auth.replay_protection_log.create",
  },
  {
    fileName: "20260430000020_takosumi_deployments.sql",
    migrationId: "deploy.takosumi_deployments.create",
  },
  {
    fileName: "20260430000021_takosumi_deploy_idempotency_keys.sql",
    migrationId: "deploy.takosumi_deploy_idempotency_keys.create",
  },
  {
    fileName: "20260430000022_takosumi_deploy_locks.sql",
    migrationId: "deploy.takosumi_deploy_locks.create",
  },
  {
    fileName: "20260430000023_takosumi_operation_journal_entries.sql",
    migrationId: "deploy.takosumi_operation_journal_entries.create",
  },
  {
    fileName: "20260430000024_takosumi_revoke_debts.sql",
    migrationId: "deploy.takosumi_revoke_debts.create",
  },
  {
    fileName: "20260430000025_catalog_releases.sql",
    migrationId: "registry.catalog_releases.create",
  },
];

Deno.test("deploy statement catalog references deployment tables only", () => {
  for (const statement of storageStatementCatalog.deploy) {
    const tables = extractReferencedTables(statement.sql);
    for (const table of tables) {
      assert(
        !removedDeployTables.has(table),
        `${statement.id} references removed table ${table}`,
      );
    }
  }
  assertEquals(
    new Set(
      storageStatementCatalog.deploy.flatMap((
        statement,
      ) => [...extractReferencedTables(statement.sql)]),
    ),
    new Set(["deployments", "group_heads", "provider_observations"]),
  );
});

Deno.test("statement catalog references declared storage tables", () => {
  const declared = new Set(
    postgresStorageTableDefinitions.map((definition) => definition.name),
  );
  for (const statement of storageStatementCatalog.all) {
    for (const table of extractReferencedTables(statement.sql)) {
      assert(
        declared.has(table),
        `${statement.id} references undeclared table ${table}`,
      );
    }
  }
});

Deno.test("statement insert and update columns exist in table definitions", () => {
  const definitions = new Map(
    postgresStorageTableDefinitions.map((definition) => [
      definition.name,
      new Set(definition.columns),
    ]),
  );
  for (const statement of storageStatementCatalog.all) {
    for (const { table, columns } of extractInsertColumns(statement.sql)) {
      assertColumns(statement.id, table, columns, definitions);
    }
    for (const { table, columns } of extractUpdateColumns(statement.sql)) {
      assertColumns(statement.id, table, columns, definitions);
    }
  }
});

Deno.test("migration catalog creates every declared storage table", () => {
  const createdTables = new Set(
    extractCreatedTables(
      postgresStorageMigrationStatements.map((migration) => migration.sql)
        .join("\n"),
    ),
  );
  for (const definition of postgresStorageTableDefinitions) {
    assert(
      createdTables.has(definition.name),
      `missing migration create table for ${definition.name}`,
    );
  }
});

Deno.test("deployment unification migration is forward-only", () => {
  const migration = postgresStorageMigrationStatements.find((entry) =>
    entry.id === "deploy.unify_to_deployments"
  );
  assert(migration, "deploy.unify_to_deployments missing from catalog");
  assertEquals(migration.down, undefined);
});

Deno.test("migration SQL files do not drift from the storage catalog", () => {
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
    const fileSql = Deno.readTextFileSync(
      new URL(
        entry.fileName,
        migrationFilesUrl,
      ),
    );
    assert(
      fileSql.startsWith(
        `-- Migration: ${entry.fileName.replace(/\.sql$/, "")}`,
      ),
      `${entry.fileName} has a stale migration marker`,
    );
    if (entry.migrationId === "deploy.unify_to_deployments") {
      assertEquals(
        extractCreatedTables(fileSql),
        extractCreatedTables(migration.sql),
      );
      assertDeployUnificationFileShape(fileSql);
    } else {
      assertEquals(
        normalizeExecutableSql(fileSql),
        normalizeExecutableSql(migration.sql),
      );
    }
  }
});

Deno.test("migration SQL files have unique timestamp prefixes", () => {
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

function extractReferencedTables(sql: string): Set<string> {
  const tables = new Set<string>();
  const pattern =
    /\b(?:insert\s+into|(?<!do\s)update|from|join)\s+([a-z_][a-z0-9_]*)\b/gi;
  for (const match of sql.matchAll(pattern)) tables.add(match[1]);
  return tables;
}

function extractCreatedTables(sql: string): Set<string> {
  const tables = new Set<string>();
  const pattern =
    /\bcreate\s+table\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)\b/gi;
  for (const match of sql.matchAll(pattern)) tables.add(match[1]);
  return tables;
}

function extractInsertColumns(
  sql: string,
): readonly { readonly table: string; readonly columns: readonly string[] }[] {
  const matches: { table: string; columns: string[] }[] = [];
  const pattern = /\binsert\s+into\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;
  for (const match of sql.matchAll(pattern)) {
    matches.push({
      table: match[1],
      columns: splitColumns(match[2]),
    });
  }
  return matches;
}

function extractUpdateColumns(
  sql: string,
): readonly { readonly table: string; readonly columns: readonly string[] }[] {
  const matches: { table: string; columns: string[] }[] = [];
  const pattern =
    /\bupdate\s+([a-z_][a-z0-9_]*)\s+set\s+(.+?)(?:\s+where\b|$)/gi;
  for (const match of sql.matchAll(pattern)) {
    matches.push({
      table: match[1],
      columns: [...match[2].matchAll(/\b([a-z_][a-z0-9_]*)\s*=/gi)].map((
        columnMatch,
      ) => columnMatch[1]),
    });
  }
  return matches;
}

function splitColumns(columns: string): string[] {
  return columns.split(",").map((column) => column.trim()).filter(Boolean);
}

function assertColumns(
  statementId: string,
  table: string,
  columns: readonly string[],
  definitions: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const definition = definitions.get(table);
  assert(definition, `${statementId} references undeclared table ${table}`);
  for (const column of columns) {
    assert(
      definition.has(column),
      `${statementId} references undeclared column ${table}.${column}`,
    );
  }
}

function listMigrationSqlFiles(): readonly string[] {
  return [...Deno.readDirSync(migrationFilesUrl)]
    .filter((entry) => entry.isFile && entry.name.endsWith(".sql"))
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

function assertDeployUnificationFileShape(sql: string): void {
  const normalized = normalizeExecutableSql(sql);
  assert(
    normalized.includes(
      "create table if not exists group_heads ( space_id text not null, group_id text not null, current_deployment_id text not null references deployments(id), previous_deployment_id text references deployments(id), generation bigint not null default 1, advanced_at timestamptz not null default now(), primary key (space_id, group_id) )",
    ),
    "deploy unification file must create group_heads with primary key (space_id, group_id)",
  );
  assert(
    normalized.includes(
      "insert into group_heads ( space_id, group_id, current_deployment_id, previous_deployment_id, generation, advanced_at )",
    ),
    "deploy unification file must insert group_heads.space_id",
  );
  assert(
    normalized.includes("where prev.space_id = p.space_id"),
    "deploy unification file must scope previous head lookup by space_id",
  );
  assert(
    normalized.includes("on conflict (space_id, group_id) do nothing"),
    "deploy unification file must use the composite group_heads conflict target",
  );
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
