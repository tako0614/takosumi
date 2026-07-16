import { Database, type SQLQueryBindings } from "bun:sqlite";

import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../worker/src/bindings.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../worker/src/d1_opentofu_store.ts";
import {
  acquireControlD1MaintenanceFence,
  adoptControlD1LegacyCloneAsCandidate,
  type ControlD1MaintenanceFence,
  type ControlD1MaintenanceDatabaseRole,
  type ControlD1MaintenanceReleasePolicy,
  isControlD1MaintenanceFenceActive,
  releaseControlD1MaintenanceFence,
  readControlD1MaintenanceState,
} from "../../worker/src/d1_schema_maintenance.ts";

export {
  adoptControlD1LegacyCloneAsCandidate,
  readControlD1MaintenanceState,
};

export const CONTROL_D1_SCHEMA_MANIFEST_VERSION = 2 as const;

/**
 * Tables deliberately retired by the current OSS control-ledger migration
 * chain. Host extensions may add their own tables, so verification rejects
 * only these known retired names and otherwise checks the OSS-owned schema as
 * a required subset.
 */
export const CONTROL_D1_RETIRED_TABLES = [
  "spaces",
  "installations",
  "state_snapshots",
  "output_snapshots",
  "workspace_output_sync",
  "provider_envs",
  "provider_catalog",
  "billing_accounts",
  "plans",
  "space_subscriptions",
  "credit_balances",
  "billing_auto_recharge_attempts",
  "credit_reservations",
] as const;

export interface ControlD1MigrationLedgerRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

interface ControlD1ColumnDescriptor {
  readonly columnId: number;
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly primaryKeyPosition: number;
  readonly hidden: number;
}

interface ControlD1IndexColumnDescriptor {
  readonly sequence: number;
  readonly columnId: number;
  readonly name: string | null;
  readonly descending: boolean;
  readonly collation: string | null;
  readonly key: boolean;
}

interface ControlD1IndexDescriptor {
  readonly name: string;
  readonly unique: boolean;
  readonly partial: boolean;
  readonly origin: string;
  readonly columns: readonly ControlD1IndexColumnDescriptor[];
  readonly sql: string | null;
  readonly where: string | null;
}

interface ControlD1ForeignKeyDescriptor {
  readonly id: number;
  readonly sequence: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface ControlD1TableDescriptor {
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly ControlD1ColumnDescriptor[];
  readonly indexes: readonly ControlD1IndexDescriptor[];
  readonly foreignKeys: readonly ControlD1ForeignKeyDescriptor[];
}

export interface ControlD1AttachedSchemaObjectDescriptor {
  readonly type: "trigger" | "view";
  readonly name: string;
  readonly table: string;
  readonly sql: string;
}

export interface ControlD1SchemaPlan {
  readonly kind: "takosumi.control-d1-schema-plan@v1";
  readonly manifestVersion: typeof CONTROL_D1_SCHEMA_MANIFEST_VERSION;
  readonly manifestDigest: string;
  readonly schemaDigest: string;
  readonly ledgerDigest: string;
  readonly tables: readonly ControlD1TableDescriptor[];
  readonly attachedSchemaObjects: readonly ControlD1AttachedSchemaObjectDescriptor[];
  readonly migrations: readonly ControlD1MigrationLedgerRow[];
  readonly retiredTables: typeof CONTROL_D1_RETIRED_TABLES;
}

export interface ControlD1SchemaVerification {
  readonly status: "ready" | "mismatch";
  readonly schemaDigest: string;
  readonly ledgerDigest: string;
  readonly latestMigrationVersion: number;
  readonly migrationCount: number;
  readonly tableCount: number;
  readonly issues: readonly string[];
}

export interface ControlD1SchemaApplyResult {
  readonly beforeMigrationVersions: readonly number[];
  readonly appliedMigrationVersions: readonly number[];
  readonly verification: ControlD1SchemaVerification;
  readonly maintenanceDrainMilliseconds: number;
  readonly maintenanceFence: ControlD1MaintenanceFence;
  readonly maintenanceStatus: "retained" | "released";
}

export interface ControlD1SchemaApplyOptions {
  readonly sourceCommit: string;
  readonly environment: "staging" | "production" | "test";
  readonly activatedAt: string;
  readonly releasedAt: () => string;
  readonly maintenanceDrainMilliseconds: number;
  readonly waitForRequestDrain: (milliseconds: number) => Promise<void>;
  /** Official Cloud blue/green candidates retain this through Worker cutover. */
  readonly retainMaintenanceFence?: boolean;
  readonly databaseRole?: ControlD1MaintenanceDatabaseRole;
  readonly releasePolicy?: ControlD1MaintenanceReleasePolicy;
  readonly databaseId?: string;
  readonly sourceExportSha256?: string;
}

export interface ControlD1SchemaFenceResult {
  readonly maintenanceFence: ControlD1MaintenanceFence;
  readonly maintenanceDrainMilliseconds: number;
}

/**
 * Freeze a legacy database without mutating its application schema. Official
 * Cloud keeps this fence forever and clones from the resulting read-only
 * bookmark; only the offline candidate is migrated.
 */
export async function fenceControlD1Schema(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1SchemaApplyOptions,
): Promise<ControlD1SchemaFenceResult> {
  const maintenanceFence = await acquireControlD1MaintenanceFence(
    database,
    {
      sourceCommit: options.sourceCommit,
      manifestDigest: plan.manifestDigest,
      environment: options.environment,
      databaseRole: options.databaseRole ?? "legacy",
      releasePolicy: options.releasePolicy ?? "never",
      databaseId: options.databaseId,
      sourceExportSha256: options.sourceExportSha256,
    },
    options.activatedAt,
  );
  await options.waitForRequestDrain(options.maintenanceDrainMilliseconds);
  return {
    maintenanceFence,
    maintenanceDrainMilliseconds: options.maintenanceDrainMilliseconds,
  };
}

export async function buildControlD1SchemaPlan(): Promise<ControlD1SchemaPlan> {
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    const tables = await inspectOwnedTables(database);
    const attachedSchemaObjects = await inspectAttachedSchemaObjects(
      database,
      new Set(tables.map((table) => table.name)),
    );
    const migrations = await readControlD1MigrationLedger(database);
    const schemaDigest = await digest({ tables, attachedSchemaObjects });
    const ledgerDigest = await digest(migrations);
    const manifestDigest = await digest({
      manifestVersion: CONTROL_D1_SCHEMA_MANIFEST_VERSION,
      schemaDigest,
      ledgerDigest,
      retiredTables: CONTROL_D1_RETIRED_TABLES,
    });
    return {
      kind: "takosumi.control-d1-schema-plan@v1",
      manifestVersion: CONTROL_D1_SCHEMA_MANIFEST_VERSION,
      manifestDigest,
      schemaDigest,
      ledgerDigest,
      tables,
      attachedSchemaObjects,
      migrations,
      retiredTables: CONTROL_D1_RETIRED_TABLES,
    };
  } finally {
    database.close();
  }
}

/**
 * Apply the canonical OSS control-ledger bootstrap/migration chain to a D1
 * target selected by the operator, then run the same read-only verification as
 * the standalone verify command.
 */
export async function applyControlD1Schema(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1SchemaApplyOptions,
): Promise<ControlD1SchemaApplyResult> {
  const before = await readControlD1MigrationLedger(database);
  const fence = await acquireControlD1MaintenanceFence(
    database,
    {
      sourceCommit: options.sourceCommit,
      manifestDigest: plan.manifestDigest,
      environment: options.environment,
      databaseRole: options.databaseRole ?? "in_place",
      releasePolicy: options.releasePolicy ?? "in_place",
      databaseId: options.databaseId,
      sourceExportSha256: options.sourceExportSha256,
    },
    options.activatedAt,
  );
  await options.waitForRequestDrain(options.maintenanceDrainMilliseconds);

  // Any failure before the explicit release deliberately leaves the durable
  // fence active and all request writes blocked. A retry of the same exact
  // source/manifest resumes the deterministic fence.
  await ensureD1OpenTofuLedgerSchema(database);
  const fencedVerification = await verifyControlD1Schema(database, plan, {
    allowActiveMaintenanceFence: true,
  });
  if (fencedVerification.status !== "ready") {
    throw new ControlD1SchemaError("post_apply_verification_failed");
  }
  if (!options.retainMaintenanceFence) {
    try {
      await releaseControlD1MaintenanceFence(
        database,
        fence,
        options.releasedAt(),
      );
    } catch (error) {
      // A transport can lose the response after D1 committed the release
      // batch. Read durable state before deciding whether this is a real
      // failure or merely a lost acknowledgement.
      if (await isControlD1MaintenanceFenceActive(database)) throw error;
    }
    if (await isControlD1MaintenanceFenceActive(database)) {
      throw new ControlD1SchemaError("maintenance_fence_release_failed");
    }
  } else if (!(await isControlD1MaintenanceFenceActive(database))) {
    throw new ControlD1SchemaError("maintenance_fence_not_retained");
  }
  const verification = fencedVerification;
  const beforeVersions = new Set(before.map((row) => row.version));
  return {
    beforeMigrationVersions: before.map((row) => row.version),
    appliedMigrationVersions: plan.migrations
      .filter((row) => !beforeVersions.has(row.version))
      .map((row) => row.version),
    verification,
    maintenanceDrainMilliseconds: options.maintenanceDrainMilliseconds,
    maintenanceFence: fence,
    maintenanceStatus: options.retainMaintenanceFence
      ? "retained"
      : "released",
  };
}

/** Read-only verification of the complete OSS-owned control D1 subset. */
export async function verifyControlD1Schema(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: {
    readonly allowActiveMaintenanceFence?: boolean;
  } = {},
): Promise<ControlD1SchemaVerification> {
  const issues: string[] = [];
  if (
    !options.allowActiveMaintenanceFence &&
    (await isControlD1MaintenanceFenceActive(database))
  ) {
    issues.push("maintenance_fence_active");
  }
  const existingTables = await listUserTableNames(database);
  const actualTables: ControlD1TableDescriptor[] = [];

  for (const expected of plan.tables) {
    if (!existingTables.has(expected.name)) {
      issues.push(`schema_table_missing:${expected.name}`);
      continue;
    }
    const actual = await inspectTable(database, expected.name);
    actualTables.push(actual);
    if (stableJson(actual) !== stableJson(expected)) {
      issues.push(`schema_table_mismatch:${expected.name}`);
    }
  }

  const actualAttachedSchemaObjects = await inspectAttachedSchemaObjects(
    database,
    new Set(plan.tables.map((table) => table.name)),
    { ignoreMaintenanceTriggers: options.allowActiveMaintenanceFence === true },
  );
  if (
    stableJson(actualAttachedSchemaObjects) !==
    stableJson(plan.attachedSchemaObjects)
  ) {
    issues.push("schema_attached_object_mismatch");
  }

  for (const retired of plan.retiredTables) {
    if (existingTables.has(retired)) {
      issues.push(`retired_table_present:${retired}`);
    }
  }

  const migrations = await readControlD1MigrationLedger(database);
  if (stableJson(migrations) !== stableJson(plan.migrations)) {
    issues.push("migration_ledger_mismatch");
  }

  return {
    status: issues.length === 0 ? "ready" : "mismatch",
    schemaDigest: await digest({
      tables: actualTables,
      attachedSchemaObjects: actualAttachedSchemaObjects,
    }),
    ledgerDigest: await digest(migrations),
    latestMigrationVersion: migrations.at(-1)?.version ?? 0,
    migrationCount: migrations.length,
    tableCount: actualTables.length,
    issues,
  };
}

export async function readControlD1MigrationLedger(
  database: D1Database,
): Promise<readonly ControlD1MigrationLedgerRow[]> {
  const tables = await listUserTableNames(database);
  if (!tables.has("schema_migrations")) return [];
  const result = await database
    .prepare(
      `select version, name, checksum
       from schema_migrations
       order by version`,
    )
    .all<{
      readonly version: number | string;
      readonly name: string;
      readonly checksum: string;
    }>();
  return (result.results ?? []).map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
  }));
}

async function inspectOwnedTables(
  database: D1Database,
): Promise<readonly ControlD1TableDescriptor[]> {
  const names = [...(await listUserTableNames(database))].sort();
  const tables = [];
  for (const name of names) tables.push(await inspectTable(database, name));
  return tables;
}

async function listUserTableNames(
  database: D1Database,
): Promise<ReadonlySet<string>> {
  const result = await database
    .prepare(
      `select name
       from sqlite_master
       where type = 'table' and name not like 'sqlite_%'
       order by name`,
    )
    .all<{ readonly name: string }>();
  return new Set((result.results ?? []).map((row) => String(row.name)));
}

async function inspectTable(
  database: D1Database,
  tableName: string,
): Promise<ControlD1TableDescriptor> {
  const table = quotedIdentifier(tableName);
  const tableSqlRow = await database
    .prepare(
      `select sql from sqlite_master
       where type = 'table' and name = ?
       limit 1`,
    )
    .bind(tableName)
    .first<{ readonly sql: string | null }>();
  if (!tableSqlRow?.sql) {
    throw new ControlD1SchemaError("schema_table_sql_missing");
  }
  const columnResult = await database
    .prepare(`pragma table_xinfo(${table})`)
    .all<{
      readonly cid: number | string;
      readonly name: string;
      readonly type: string;
      readonly notnull: number | string;
      readonly dflt_value: unknown;
      readonly pk: number | string;
      readonly hidden: number | string;
    }>();
  const columns = (columnResult.results ?? [])
    .map((row) => ({
      columnId: Number(row.cid),
      name: String(row.name),
      type: String(row.type ?? "")
        .trim()
        .toLowerCase(),
      notNull: Number(row.notnull) !== 0,
      defaultValue: normalizedDefault(row.dflt_value),
      primaryKeyPosition: Number(row.pk),
      hidden: Number(row.hidden),
    }))
    .sort((left, right) => left.columnId - right.columnId);

  const indexList = await database.prepare(`pragma index_list(${table})`).all<{
    readonly name: string;
    readonly unique: number | string;
    readonly partial: number | string;
    readonly origin: string;
  }>();
  const indexes: ControlD1IndexDescriptor[] = [];
  for (const row of indexList.results ?? []) {
    const name = String(row.name);
    const index = quotedIdentifier(name);
    const indexInfo = await database
      .prepare(`pragma index_xinfo(${index})`)
      .all<{
        readonly seqno: number | string;
        readonly cid: number | string;
        readonly name: string | null;
        readonly desc: number | string;
        readonly coll: string | null;
        readonly key: number | string;
      }>();
    const sqlRow = await database
      .prepare(
        `select sql
         from sqlite_master
         where type = 'index' and name = ?
         limit 1`,
      )
      .bind(name)
      .first<{ readonly sql: string | null }>();
    indexes.push({
      name,
      unique: Number(row.unique) !== 0,
      partial: Number(row.partial) !== 0,
      origin: String(row.origin ?? "").toLowerCase(),
      columns: [...(indexInfo.results ?? [])]
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((entry) => ({
          sequence: Number(entry.seqno),
          columnId: Number(entry.cid),
          name: entry.name === null ? null : String(entry.name),
          descending: Number(entry.desc) !== 0,
          collation: entry.coll === null ? null : String(entry.coll),
          key: Number(entry.key) !== 0,
        })),
      sql: sqlRow?.sql ? canonicalSql(sqlRow.sql) : null,
      where: normalizedWhere(sqlRow?.sql ?? null),
    });
  }
  indexes.sort((left, right) => left.name.localeCompare(right.name));

  const foreignKeyResult = await database
    .prepare(`pragma foreign_key_list(${table})`)
    .all<{
      readonly id: number | string;
      readonly seq: number | string;
      readonly table: string;
      readonly from: string;
      readonly to: string | null;
      readonly on_update: string;
      readonly on_delete: string;
      readonly match: string;
    }>();
  const foreignKeys = (foreignKeyResult.results ?? [])
    .map((row) => ({
      id: Number(row.id),
      sequence: Number(row.seq),
      table: String(row.table),
      from: String(row.from),
      to: row.to === null ? null : String(row.to),
      onUpdate: String(row.on_update).toLowerCase(),
      onDelete: String(row.on_delete).toLowerCase(),
      match: String(row.match).toLowerCase(),
    }))
    .sort(
      (left, right) => left.id - right.id || left.sequence - right.sequence,
    );

  return {
    name: tableName,
    sql: canonicalTableDefinition(tableSqlRow.sql),
    columns,
    indexes,
    foreignKeys,
  };
}

async function inspectAttachedSchemaObjects(
  database: D1Database,
  ownedTables: ReadonlySet<string>,
  options: {
    readonly ignoreMaintenanceTriggers?: boolean;
  } = {},
): Promise<readonly ControlD1AttachedSchemaObjectDescriptor[]> {
  const result = await database
    .prepare(
      `select type, name, tbl_name, sql
       from sqlite_master
       where type in ('trigger', 'view') and sql is not null
       order by type, name`,
    )
    .all<{
      readonly type: "trigger" | "view";
      readonly name: string;
      readonly tbl_name: string;
      readonly sql: string;
    }>();
  return (result.results ?? [])
    .filter((row) => {
      if (
        options.ignoreMaintenanceTriggers &&
        row.name.startsWith("_takosumi_schema_fence_")
      ) {
        return false;
      }
      if (row.type === "trigger") return ownedTables.has(row.tbl_name);
      const sql = canonicalSql(row.sql);
      return [...ownedTables].some((table) =>
        sqlMentionsIdentifier(sql, table),
      );
    })
    .map((row) => ({
      type: row.type,
      name: String(row.name),
      table: String(row.tbl_name),
      sql: canonicalSql(row.sql),
    }))
    .sort((left, right) =>
      `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`),
    );
}

function normalizedDefault(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value).trim().replace(/\s+/gu, " ");
}

function normalizedWhere(sql: string | null): string | null {
  if (!sql) return null;
  const match = /\bwhere\b([\s\S]+)$/iu.exec(sql);
  return match?.[1] ? canonicalSql(match[1]) : null;
}

function canonicalTableDefinition(value: string): string {
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  if (open < 0 || close <= open) return canonicalSql(value);
  const definitions = splitTopLevel(value.slice(open + 1, close))
    .map(canonicalSql)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return stableJson({
    definitions,
    suffix: canonicalSql(value.slice(close + 1)),
  });
}

function splitTopLevel(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (quote === "]") {
        if (character === "]") quote = undefined;
      } else if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

function canonicalSql(value: string): string {
  const quoted: string[] = [];
  const placeholders = value.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/gu,
    (literal) => {
      const placeholder = `__TAKOSUMI_QUOTED_${quoted.length}__`;
      quoted.push(literal);
      return placeholder;
    },
  );
  let canonical = placeholders
    .trim()
    .replace(/;$/u, "")
    .toUpperCase()
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),=<>!+*/-])\s*/gu, "$1");
  quoted.forEach((literal, index) => {
    canonical = canonical.replace(`__TAKOSUMI_QUOTED_${index}__`, literal);
  });
  return canonical;
}

function sqlMentionsIdentifier(sql: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:^|[^A-Z0-9_])(?:"${escaped}"|${escaped})(?:$|[^A-Z0-9_])`,
    "iu",
  ).test(sql);
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new ControlD1SchemaError("schema_identifier_invalid");
  }
  return `"${value}"`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const valueDigest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(valueDigest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export class ControlD1SchemaError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlD1SchemaError";
  }
}

/** Bun SQLite adapter used only for deterministic planning and tests. */
export class SqliteControlD1Database implements D1Database {
  readonly #database: Database;

  constructor(filename = ":memory:") {
    this.#database = new Database(filename);
  }

  close(): void {
    this.#database.close();
  }

  /** Test/planning fixture loader; remote D1 execution never uses this path. */
  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteControlD1Statement(this.#database, query);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.#database.exec("begin immediate");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
      this.#database.exec("commit");
      return results;
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }
}

class SqliteControlD1Statement implements D1PreparedStatement {
  readonly #database: Database;
  readonly #query: string;
  #values: readonly unknown[] = [];

  constructor(database: Database, query: string) {
    this.#database = database;
    this.#query = query;
  }

  bind(...values: readonly unknown[]): D1PreparedStatement {
    this.#values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.#database.query(this.#query).get(...bindings(this.#values)) ??
      null) as T | null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.#database
        .query(this.#query)
        .all(...bindings(this.#values)) as T[],
    };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.#database.run(this.#query, bindings(this.#values));
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

function bindings(values: readonly unknown[]): SQLQueryBindings[] {
  return values.map((value) =>
    value === undefined ? null : (value as SQLQueryBindings),
  );
}
