import { sourceCreatorPlanAllowsRetirement } from "../../core/domains/sources/retirement_policy.ts";
import { inventorySourceOwnershipGroup, sourceOwnershipMigrationReportFromRow } from
  "../../core/domains/sources/ownership-migration.ts";
/**
 * Operator-only Source ownership repair against the existing D1 schema.
 * Every observed physical row and each group membership count is fenced inside
 * the same D1 batch as the writes. A failed fence aborts that transaction.
 */
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { Run } from "takosumi-contract/runs";
import { isPlanRunRecord, type StoredInstallConfig, type StoredRunRecord, type StoredSource } from
  "../../core/domains/deploy-control/store.ts";
import type { StoredGitInstallPlan } from "../../core/domains/install-plans/store.ts";
import { getCapsuleAdoptedSourceSnapshot } from "../../core/domains/deploy-control/capsule_source_revision.ts";
import { normalizeSourceSnapshotRecord } from "../../core/domains/deploy-control/store_row_mappers.ts";
import { sha256HexOfStringAsync } from "../../core/shared/runtime/hash.ts";
import { stableStringify } from "../../core/adapters/source/digest.ts";
import type {
  SourceOwnershipMigrationGroup,
  SourceOwnershipMigrationMutation,
  SourceOwnershipMigrationReportReference,
} from "../../core/domains/sources/ownership-migration.ts";
import type { D1Database, D1PreparedStatement } from "./bindings.ts";

type PhysicalRow = Record<string, string | number | null>;
type Table = "sources" | "capsules" | "source_snapshots" | "runs" |
  "capsule_compatibility_reports" | "git_install_plans" | "install_configs";
interface ObservedTable {
  readonly table: Table;
  readonly where: string;
  readonly args: readonly string[];
  readonly rows: readonly PhysicalRow[];
}
const observations = new WeakMap<SourceOwnershipMigrationGroup, readonly ObservedTable[]>();
const encoder = new TextEncoder();
const D1_READ_PAGE_SIZE = 100;
const D1_ROW_MAX_BYTES = 2_000_000;
const D1_GUARD_BIND_MAX_BYTES = 2_000_000;
const scopes = (sourceId: string): readonly Omit<ObservedTable, "rows">[] => [
  { table: "sources", where: "id = ?", args: [sourceId] },
  { table: "capsules", where: "source_id = ?", args: [sourceId] },
  { table: "source_snapshots", where: "source_id = ?", args: [sourceId] },
  { table: "runs", where: "(type in ('source_sync', 'compatibility_check') and source_id = ?) or (type in ('plan', 'destroy_plan', 'drift_check') and installation_id in (select id from capsules where source_id = ?))", args: [sourceId, sourceId] },
  // A report without a Source (before 2026-07-14) belongs to the group through
  // an app reference: its binding, or a Capsule, Run or install plan of an app.
  { table: "capsule_compatibility_reports", where: `source_id = ?
    or installation_id in (select id from capsules where source_id = ?)
    or (source_id is null and id in (
      select json_extract(record_json, '$.compatibilityReportId') from capsules where source_id = ?
      union select case when json_valid(run_json) then json_extract(run_json, '$.compatibilityReportId') end
        from runs where installation_id in (select id from capsules where source_id = ?)
      union select json_extract(record_json, '$.compatibilityReportId') from git_install_plans
        where json_extract(record_json, '$.capsuleId') in (select id from capsules where source_id = ?)
      union select json_extract(record_json, '$.preflight.compatibilityReportId') from git_install_plans
        where json_extract(record_json, '$.capsuleId') in (select id from capsules where source_id = ?)))`,
    args: Array(6).fill(sourceId) },
  { table: "git_install_plans", where: "json_extract(record_json, '$.sourceId') = ? or json_extract(record_json, '$.preflight.sourceId') = ? or json_extract(record_json, '$.capsuleId') in (select id from capsules where source_id = ?) or id in (select json_extract(record_json, '$.createdByInstallPlanId') from sources where id = ?)", args: [sourceId, sourceId, sourceId, sourceId] },
  { table: "install_configs", where: `
    id in (select install_config_id from capsules where source_id = ?)
    or id in (select json_extract(g.record_json, '$.installConfigId') from git_install_plans g
      where json_extract(g.record_json, '$.sourceId') = ?
        or json_extract(g.record_json, '$.preflight.sourceId') = ?
        or json_extract(g.record_json, '$.capsuleId') in (select id from capsules where source_id = ?)
        or g.id in (select json_extract(record_json, '$.createdByInstallPlanId') from sources where id = ?))
    or id in (select json_extract(g.record_json, '$.preflight.installConfigId') from git_install_plans g
      where json_extract(g.record_json, '$.sourceId') = ?
        or json_extract(g.record_json, '$.preflight.sourceId') = ?
        or json_extract(g.record_json, '$.capsuleId') in (select id from capsules where source_id = ?)
        or g.id in (select json_extract(record_json, '$.createdByInstallPlanId') from sources where id = ?))
    or id in (select json_extract(g.record_json, '$.installConfigBaseId') from git_install_plans g
      where json_extract(g.record_json, '$.sourceId') = ?
        or json_extract(g.record_json, '$.preflight.sourceId') = ?
        or json_extract(g.record_json, '$.capsuleId') in (select id from capsules where source_id = ?)
        or g.id in (select json_extract(record_json, '$.createdByInstallPlanId') from sources where id = ?))
    or id in (select json_extract(g.record_json, '$.revision.base.installConfigId') from git_install_plans g
      where json_extract(g.record_json, '$.sourceId') = ?
        or json_extract(g.record_json, '$.preflight.sourceId') = ?
        or json_extract(g.record_json, '$.capsuleId') in (select id from capsules where source_id = ?)
        or g.id in (select json_extract(record_json, '$.createdByInstallPlanId') from sources where id = ?))
    or json_extract(record_json, '$.internal.sourceSnapshotId') in
      (select id from source_snapshots where source_id = ?)
    or json_extract(record_json, '$.internal.genericOpenTofuSourceSnapshotId') in
      (select id from source_snapshots where source_id = ?)
    or json_extract(record_json, '$.internal.migrationRestore.sourceSnapshotId') in
      (select id from source_snapshots where source_id = ?)
    or json_extract(record_json, '$.internal.reAdoption.sourceSnapshotId') in
      (select id from source_snapshots where source_id = ?)`,
    args: Array(21).fill(sourceId) },
];

async function rows(db: D1Database, sql: string, args: readonly unknown[] = []): Promise<PhysicalRow[]> {
  const result = await db.prepare(sql).bind(...args).all<PhysicalRow>();
  if (result.success === false || !Array.isArray(result.results)) {
    throw new Error("D1 Source ownership inventory unavailable");
  }
  return [...result.results];
}

/** D1 result pages are bounded; never make one `.all()` hold the whole Source. */
async function pagedRows(
  db: D1Database,
  table: Table | "runs",
  where: string,
  args: readonly unknown[],
): Promise<PhysicalRow[]> {
  const collected: PhysicalRow[] = [];
  let after = "";
  for (;;) {
    const page = await rows(db,
      `select * from ${table} where (${where}) and id > ? order by id limit ${D1_READ_PAGE_SIZE}`,
      [...args, after]);
    if (page.length === 0) return collected;
    for (const row of page) {
      const size = Object.values(row).reduce<number>((total, value) =>
        total + (value === null ? 0 : encoder.encode(String(value)).byteLength), 0);
      if (size > D1_ROW_MAX_BYTES) {
        throw new Error(`D1 Source ownership ${table}:${row.id} row ${size} bytes exceeds 2 MB read limit`);
      }
    }
    const last = page[page.length - 1]?.id;
    if (typeof last !== "string" || last <= after) throw new Error(`D1 Source ownership ${table} page did not advance`);
    collected.push(...page);
    after = last;
    if (page.length < D1_READ_PAGE_SIZE) return collected;
  }
}

function parseJson<T>(row: PhysicalRow, column: string): T {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`D1 Source ownership invalid ${column}`);
  return JSON.parse(value) as T;
}

function checkedJson(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  const size = encoder.encode(serialized).byteLength;
  if (size > D1_ROW_MAX_BYTES) {
    throw new Error(`D1 Source ownership ${label} needs ${size} bytes; exceeds 2 MB bound value limit`);
  }
  return serialized;
}

/** D1 stores JSON columns as text; any other physical value is a damaged row. */
function decodeD1JsonColumn(value: unknown): unknown {
  if (typeof value !== "string") throw new TypeError("D1 Source ownership JSON column is not text");
  return JSON.parse(value);
}

function parseRun<T>(row: PhysicalRow): T {
  const value = parseJson<unknown>(row, "run_json");
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

async function splitId(prefix: string, originalId: string, capsuleId: string): Promise<string> {
  const parts = [originalId, capsuleId, "split"];
  const material = parts.map((part) => `${part.length}:${part}`).join("|");
  return `${prefix}_${(await sha256HexOfStringAsync(material)).slice(0, 32)}`;
}

/**
 * Every app, in any Source, that references a report without a Source. The
 * commit never writes such a report, so this evidence only decides whether the
 * group may proceed; it is not part of the write fence.
 */
async function d1UnscopedReportReferences(
  db: D1Database,
  reportId: string,
): Promise<readonly SourceOwnershipMigrationReportReference[]> {
  const found = await rows(db, `select c.id as capsule_id, c.source_id as source_id from capsules c
    where c.id in (select installation_id from capsule_compatibility_reports where id = ?)
      or json_extract(c.record_json, '$.compatibilityReportId') = ?
      or c.id in (select installation_id from runs
        where case when json_valid(run_json) then json_extract(run_json, '$.compatibilityReportId') end = ?)
      or c.id in (select json_extract(record_json, '$.capsuleId') from git_install_plans
        where json_extract(record_json, '$.compatibilityReportId') = ?
          or json_extract(record_json, '$.preflight.compatibilityReportId') = ?)
    order by c.id`, Array(5).fill(reportId));
  return found.map((row) => ({ capsuleId: String(row.capsule_id),
    sourceId: row.source_id === null ? null : String(row.source_id) }));
}

export async function listD1SourceOwnershipIds(db: D1Database): Promise<readonly string[]> {
  return (await pagedRows(db, "sources", "1 = 1", [])).map((row) => String(row.id));
}

/** Return one Source ID and one lookahead without reading any group data. */
export async function readD1SourceOwnershipInventoryPage(
  db: D1Database,
  afterSourceId: string,
): Promise<readonly string[]> {
  return (await rows(db, "select id from sources where id > ? order by id limit 2", [afterSourceId]))
    .map((row) => String(row.id));
}

export interface SourceOwnershipLineageReader {
  getSource(id: string): Promise<StoredSource | undefined>;
  getStateVersion(id: string): ReturnType<import("../../core/domains/deploy-control/store.ts").OpenTofuControlStore["getStateVersion"]>;
  getApplyRun(id: string): ReturnType<import("../../core/domains/deploy-control/store.ts").OpenTofuControlStore["getApplyRun"]>;
  getBackupRun(id: string): ReturnType<import("../../core/domains/deploy-control/store.ts").OpenTofuControlStore["getBackupRun"]>;
  getStateRecoveryRun(id: string): ReturnType<import("../../core/domains/deploy-control/store.ts").OpenTofuControlStore["getStateRecoveryRun"]>;
  getPlanRun(id: string): Promise<PlanRun | undefined>;
  getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined>;
}

export async function readD1SourceOwnershipGroup(
  db: D1Database,
  reader: SourceOwnershipLineageReader,
  sourceId: string,
): Promise<SourceOwnershipMigrationGroup | undefined> {
  const observed = await Promise.all(scopes(sourceId).map(async (scope) => ({
    ...scope, rows: await pagedRows(db, scope.table, scope.where, scope.args),
  })));
  const table = (name: Table) => observed.find((entry) => entry.table === name)!.rows;
  const sourceRow = table("sources")[0];
  if (!sourceRow) return undefined;
  const source = parseJson<StoredSource>(sourceRow, "record_json");
  if (source.id !== sourceId || source.workspaceId !== sourceRow.space_id ||
    source.status !== sourceRow.status || source.updatedAt !== sourceRow.updated_at) {
    throw new Error("D1 Source identity mismatch");
  }
  const capsuleRows = table("capsules");
  const snapshots = table("source_snapshots").map((row) => {
    const snapshot = normalizeSourceSnapshotRecord(parseJson<SourceSnapshot>(row, "record_json"));
    if (snapshot.id !== row.id || snapshot.sourceId !== row.source_id || snapshot.workspaceId !== source.workspaceId) {
      throw new Error(`D1 Source ownership Snapshot scope mismatch: ${row.id}`);
    }
    return snapshot;
  });
  const runs = table("runs");
  const syncRuns = runs.filter((row) => row.type === "source_sync").map((row) => {
    const persisted = parseRun<SourceSyncRun & { readonly archiveObjectKey?: string }>(row);
    const archiveRef = persisted.archiveRef || persisted.archiveObjectKey;
    if (persisted.id !== row.id || persisted.sourceId !== row.source_id ||
      persisted.workspaceId !== source.workspaceId || persisted.status !== row.status || !archiveRef) {
      throw new Error(`D1 Source ownership SyncRun scope mismatch: ${row.id}`);
    }
    const { archiveObjectKey: _legacy, ...canonical } = persisted;
    void _legacy;
    return { ...canonical, archiveRef };
  });
  const compatibilityRuns = runs.filter((row) => row.type === "compatibility_check").map((row) => {
    const run = parseRun<Run>(row);
    if (run.id !== row.id || run.type !== row.type || run.sourceId !== row.source_id ||
      run.workspaceId !== source.workspaceId || run.status !== row.status) {
      throw new Error(`D1 Source ownership CompatibilityRun scope mismatch: ${row.id}`);
    }
    return run;
  });
  const planRuns = runs.filter((row) => row.type === "plan" || row.type === "destroy_plan" ||
    row.type === "drift_check").flatMap((row) => {
    const parsed = parseRun<StoredRunRecord>(row);
    // A projected historical drift Run can share the physical discriminator
    // without being a canonical PlanRun. It still participates in the direct
    // in-flight fence, but only real PlanRuns have snapshot authority to move.
    if (!isPlanRunRecord(parsed)) {
      if (row.type === "drift_check") return [];
      throw new Error(`D1 Source ownership PlanRun shape mismatch: ${row.id}`);
    }
    const plan: PlanRun = parsed;
    if (plan.id !== row.id || plan.capsuleId !== row.installation_id ||
      plan.workspaceId !== source.workspaceId || plan.status !== row.status) {
      throw new Error(`D1 Source ownership PlanRun scope mismatch: ${row.id}`);
    }
    return [plan];
  });
  const gitPlans = table("git_install_plans").map((row) => {
    const plan = parseJson<StoredGitInstallPlan>(row, "record_json");
    if (plan.id !== row.id || plan.workspaceId !== row.workspace_id || plan.phase !== row.phase ||
      plan.generation !== row.generation) {
      throw new Error(`D1 Source ownership Git plan scope mismatch: ${row.id}`);
    }
    return plan;
  });
  const installConfigs = table("install_configs").map((row) => {
    const config = parseJson<StoredInstallConfig>(row, "record_json");
    if (config.id !== row.id || (config.workspaceId ?? null) !== row.space_id ||
      config.createdAt !== row.created_at || config.updatedAt !== row.updated_at) {
      throw new Error(`D1 Source ownership InstallConfig scope mismatch: ${row.id}`);
    }
    return config;
  });
  const capsules = await Promise.all(capsuleRows.map(async (row) => {
    const capsule = parseJson<Capsule>(row, "record_json");
    if (capsule.id !== row.id || capsule.sourceId !== sourceId || capsule.workspaceId !== source.workspaceId ||
      capsule.status !== row.status || capsule.installConfigId !== row.install_config_id ||
      capsule.updatedAt !== row.updated_at) {
      throw new Error(`D1 Source ownership Capsule scope mismatch: ${row.id}`);
    }
    const adopted = capsule.status === "destroyed" ? undefined :
      await getCapsuleAdoptedSourceSnapshot(reader, capsule);
    return { capsule, ...(adopted ? { adoptedSnapshotId: adopted.id } : {}) };
  }));
  // Reports come from the same physical rows the commit fences. The migration
  // never interprets analysis output, so rows from older releases (for
  // example a retired flat providers_json array) are carried verbatim instead
  // of being read through the current report contract.
  const reports = table("capsule_compatibility_reports").map((row) => sourceOwnershipMigrationReportFromRow({
    id: row.id, sourceId: row.source_id, capsuleId: row.installation_id,
    sourceSnapshotId: row.source_snapshot_id, modulePath: row.module_path ?? null, level: row.level,
    findingsJson: row.findings_json, providersJson: row.providers_json, resourcesJson: row.resources_json,
    dataSourcesJson: row.data_sources_json, provisionersJson: row.provisioners_json,
    rootModuleVariablesJson: row.root_module_variables_json,
    rootModuleVariableDeclarationsJson: row.root_module_variable_declarations_json ?? null,
    rootModuleOutputsJson: row.root_module_outputs_json, createdAt: row.created_at,
  }, decodeD1JsonColumn));
  const reportsWithEvidence = await Promise.all(reports.map(async (report) => report.sourceId !== null ? report
    : { ...report, unscopedReferences: await d1UnscopedReportReferences(db, report.id) }));
  const directRunRows = await pagedRows(db, "runs", `(source_id = ? or installation_id in
    (select id from capsules where source_id = ?)) and
    status in ('queued', 'running', 'waiting_approval')`, [sourceId, sourceId]);
  const inFlightRunIds = [
    ...directRunRows.map((row) => String(row.id)),
    // These source-scoped Runs are cloned for a split. Their historical
    // RunGroup is a separate durable identity that this migration does not
    // copy, so refuse the group before any archive or ledger mutation.
    ...runs.filter((row) => (row.type === "source_sync" || row.type === "compatibility_check") &&
      row.run_group_id !== null).map((row) => `run_group:${row.id}`),
    ...gitPlans.filter((plan) => !["failed", "reviewable", "discarded"].includes(plan.phase) &&
      !sourceCreatorPlanAllowsRetirement(plan, Date.now()))
      .map((plan) => `git_install_plan:${plan.id}`),
    ...table("git_install_plans").filter((row) => row.reconcile_lease_token !== null)
      .map((row) => `git_install_plan:${row.id}`),
  ];
  const group: SourceOwnershipMigrationGroup = {
    source, capsules, snapshots, syncRuns, compatibilityRuns, planRuns, reports: reportsWithEvidence, gitPlans,
    installConfigs, inFlightRunIds,
  };
  observations.set(group, observed);
  return group;
}

/** Compare a valid physical row without JSON-encoding its already encoded columns. */
function physicalRowFence(db: D1Database, table: Table, row: PhysicalRow): D1PreparedStatement {
  const columns = Object.keys(row);
  // D1 permits at most 100 columns and 100 bound parameters per statement.
  // Bind id once, along with every other physical column (including NULL).
  if (columns.length === 0 || columns.length > 100 || !columns.includes("id") ||
    typeof row.id !== "string" || !columns.every((name) => /^[a-z_]+$/u.test(name))) {
    throw new Error("D1 Source ownership invalid physical row fence");
  }
  for (const name of columns) {
    const value = row[name];
    if (typeof value === "string" && encoder.encode(value).byteLength > D1_ROW_MAX_BYTES) {
      throw new Error(`D1 Source ownership ${table}:${row.id} ${name} exceeds 2 MB bound value limit`);
    }
    if (value !== null && typeof value !== "string" &&
      !(typeof value === "number" && Number.isFinite(value))) {
      throw new Error("D1 Source ownership invalid physical row value");
    }
  }
  return db.prepare(`select case when exists (select 1 from ${table} t where
    ${columns.map((name) => `t.${name} is ?`).join(" and ")}) then 1
    else json_extract('source_ownership_conflict', '$') end as guard`)
    .bind(...columns.map((name) => row[name]));
}

function fence(db: D1Database, observed: ObservedTable): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [db.prepare(`select case when
    (select count(*) from ${observed.table} where ${observed.where}) = ?
    then 1 else json_extract('source_ownership_conflict', '$') end as guard`)
    .bind(...observed.args, observed.rows.length)];
  if (observed.rows.length === 0) return statements;
  const columns = Object.keys(observed.rows[0]!);
  if (!columns.every((name) => /^[a-z_]+$/u.test(name))) throw new Error("D1 Source ownership unexpected column");
  const mismatch = columns.map((name) =>
    `t.${name} is not json_extract(e.value, '$.${name}')`).join(" or ");
  const chunk: string[] = [];
  let chunkBytes = 2; // JSON array brackets
  const flush = () => {
    if (chunk.length === 0) return;
    statements.push(db.prepare(`select case when not exists (
      select 1 from json_each(?) e left join ${observed.table} t on t.id = json_extract(e.value, '$.id')
      where t.id is null or ${mismatch}
    ) then 1 else json_extract('source_ownership_conflict', '$') end as guard`)
      .bind(`[${chunk.join(",")}]`));
    chunk.length = 0;
    chunkBytes = 2;
  };
  for (const row of observed.rows) {
    if (Object.keys(row).length !== columns.length ||
      columns.some((name) => !Object.hasOwn(row, name))) {
      throw new Error("D1 Source ownership inconsistent physical columns");
    }
    const encoded = JSON.stringify(row);
    const rowBytes = encoder.encode(encoded).byteLength;
    if (rowBytes + 2 > D1_GUARD_BIND_MAX_BYTES) {
      flush();
      statements.push(physicalRowFence(db, observed.table, row));
      continue;
    }
    const separatorBytes = chunk.length > 0 ? 1 : 0;
    if (chunk.length >= D1_READ_PAGE_SIZE ||
      chunkBytes + separatorBytes + rowBytes > D1_GUARD_BIND_MAX_BYTES) {
      flush();
    }
    chunkBytes += (chunk.length > 0 ? 1 : 0) + rowBytes;
    chunk.push(encoded);
  }
  flush();
  return statements;
}

function insertRow(db: D1Database, table: Table, row: PhysicalRow): D1PreparedStatement {
  const columns = Object.keys(row);
  if (!columns.every((name) => /^[a-z_]+$/u.test(name))) throw new Error("D1 Source ownership unexpected column");
  for (const name of columns) {
    const value = row[name];
    if (typeof value === "string" && encoder.encode(value).byteLength > D1_ROW_MAX_BYTES) {
      throw new Error(`D1 Source ownership ${table}:${row.id} ${name} exceeds 2 MB bound value limit`);
    }
  }
  return db.prepare(`insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((name) => row[name]));
}

function appendHistoryWrites(
  db: D1Database,
  statements: D1PreparedStatement[],
  table: Table,
  operation: "insert" | "update",
  rows: readonly PhysicalRow[],
): void {
  const first = rows[0];
  if (!first) return;
  const columns = Object.keys(first);
  if (!Object.hasOwn(first, "id") || columns.length < 2 || columns.length > 100 ||
    !columns.every((name) => /^[a-z_]+$/u.test(name))) {
    throw new Error("D1 Source ownership unexpected history columns");
  }
  const columnList = columns.join(", ");
  const assignments = columns.filter((column) => column !== "id")
    .map((column) => `${column} = history.${column}`).join(", ");
  const placeholders = `(${columns.map(() => "?").join(", ")})`;
  const seen = new Set<string>();
  let bindings: PhysicalRow[string][] = [];
  let bytes = 0;
  function flush(): void {
    if (bindings.length === 0) return;
    const values = Array<string>(bindings.length / columns.length).fill(placeholders).join(", ");
    const sql = operation === "insert"
      ? `insert into ${table} (${columnList}) values ${values}`
      : `with history(${columnList}) as (values ${values})
        update ${table} set ${assignments} from history where ${table}.id = history.id`;
    statements.push(db.prepare(sql).bind(...bindings));
    bindings = [];
    bytes = 0;
  }
  for (const row of rows) {
    if (typeof row.id !== "string" || Object.keys(row).length !== columns.length ||
      !columns.every((name) => Object.hasOwn(row, name))) {
      throw new Error(`D1 Source ownership unexpected ${table} history row`);
    }
    // SQLite UPDATE FROM needs at most one matching input row per target.
    if (seen.has(row.id)) throw new Error(`D1 Source ownership duplicate ${table} history row: ${row.id}`);
    seen.add(row.id);
    const values = columns.map((name) => row[name]);
    let rowBytes = 0;
    for (const [index, value] of values.entries()) {
      if (typeof value !== "string") continue;
      const size = encoder.encode(value).byteLength;
      if (size > D1_ROW_MAX_BYTES) {
        throw new Error(`D1 Source ownership ${table}:${row.id} ${columns[index]} exceeds 2 MB bound value limit`);
      }
      rowBytes += size;
    }
    // Limit the text packed together. A single wide row still gets its own
    // statement with the same per-value limit as the original single-row write.
    if (bindings.length + columns.length > 100 || bytes + rowBytes > D1_ROW_MAX_BYTES) flush();
    bindings.push(...values);
    bytes += rowBytes;
  }
  flush();
}

function oldRow(physicalByTable: ReadonlyMap<Table, ReadonlyMap<string, PhysicalRow>>, table: Table, id: string): PhysicalRow {
  const row = physicalByTable.get(table)?.get(id);
  if (!row) throw new Error(`D1 Source ownership missing original ${table}:${id}`);
  return row;
}

export async function commitD1SourceOwnershipGroup(
  db: D1Database,
  mutation: SourceOwnershipMigrationMutation,
): Promise<"committed" | "conflict"> {
  const observed = observations.get(mutation.expected);
  if (!observed || mutation.expected.source.id !== mutation.sourceId ||
    mutation.retainedSource.id !== mutation.sourceId || mutation.expected.inFlightRunIds.length > 0 ||
    inventorySourceOwnershipGroup(mutation.expected).action !== mutation.action) return "conflict";
  const physicalByTable = new Map(observed.map((entry) =>
    [entry.table, new Map(entry.rows.map((row) => [String(row.id), row]))] as const));
  const statements = observed.flatMap((entry) => fence(db, entry));
  // A new queued Run could appear after inventory. Re-check the full direct and
  // Capsule-linked execution set within the commit transaction.
  statements.push(db.prepare(`select case when not exists (select 1 from runs where
    (source_id = ? or installation_id in (select id from capsules where source_id = ?))
    and status in ('queued', 'running', 'waiting_approval')) then 1
    else json_extract('source_ownership_conflict', '$') end as guard`).bind(mutation.sourceId, mutation.sourceId));
  const sourceRow = oldRow(physicalByTable, "sources", mutation.sourceId);
  const movedCapsuleIds = new Set(mutation.splits.map((split) => split.capsuleId));
  statements.push(db.prepare(`update sources set status = ?, record_json = ?, updated_at = ? where id = ?`)
    .bind(mutation.retainedSource.status, checkedJson(mutation.retainedSource, "retained Source"),
      mutation.retainedSource.updatedAt, mutation.sourceId));
  appendHistoryWrites(db, statements, "source_snapshots", "update", mutation.retainedSnapshots.map((snapshot) => ({
    id: snapshot.id, record_json: checkedJson(snapshot, `retained Snapshot:${snapshot.id}`),
  })));
  appendHistoryWrites(db, statements, "runs", "update", mutation.retainedSyncRuns.map((run) => {
    const before = parseRun<SourceSyncRun>(oldRow(physicalByTable, "runs", run.id));
    return { id: run.id, run_json: checkedJson({ ...before, archiveRef: run.archiveRef }, `retained SyncRun:${run.id}`) };
  }));
  for (const run of mutation.retainedCompatibilityRuns) {
    const base = oldRow(physicalByTable, "runs", run.id);
    const before = parseRun<Run>(base);
    if (base.type !== "compatibility_check" ||
      !mutation.expected.compatibilityRuns.some((entry) => entry.id === run.id) ||
      !before.capsuleId || !movedCapsuleIds.has(before.capsuleId) ||
      run.capsuleId !== undefined || run.sourceId !== mutation.sourceId ||
      stableStringify(run) !== stableStringify({ ...before, capsuleId: undefined })) {
      throw new Error(`D1 Source ownership retained CompatibilityRun mismatch: ${run.id}`);
    }
    statements.push(db.prepare(`update runs set installation_id = ?, run_json = ? where id = ?`)
      .bind(run.capsuleId ?? null,
        checkedJson({ ...before, capsuleId: run.capsuleId }, `retained CompatibilityRun:${run.id}`), run.id));
  }
  for (const report of mutation.retainedReports) {
    const before = mutation.expected.reports.find((entry) => entry.id === report.id);
    const physical = oldRow(physicalByTable, "capsule_compatibility_reports", report.id);
    if (!before || !before.capsuleId || !movedCapsuleIds.has(before.capsuleId) ||
      physical.installation_id !== before.capsuleId || report.capsuleId !== undefined ||
      stableStringify(report) !== stableStringify({ ...before, capsuleId: undefined })) {
      throw new Error(`D1 Source ownership retained report mismatch: ${report.id}`);
    }
    statements.push(db.prepare(`update capsule_compatibility_reports set installation_id = ? where id = ?`)
      .bind(report.capsuleId ?? null, report.id));
  }
  for (const split of mutation.splits) {
    const originalSnapshotsBySplitId = new Map(await Promise.all(
      mutation.expected.snapshots.map(async (snapshot) =>
        [await splitId("snap", snapshot.id, split.capsuleId), snapshot] as const),
    ));
    const originalSyncRunsBySplitId = new Map(await Promise.all(
      mutation.expected.syncRuns.map(async (run) =>
        [await splitId("ssr", run.id, split.capsuleId), run] as const),
    ));
    const originalCompatibilityRunsBySplitId = new Map(await Promise.all(
      mutation.expected.compatibilityRuns.map(async (run) =>
        [await splitId("run", run.id, split.capsuleId), run] as const),
    ));
    statements.push(insertRow(db, "sources", { ...sourceRow,
      id: split.source.id, status: split.source.status,
      record_json: checkedJson(split.source, `split Source:${split.source.id}`), created_at: split.source.createdAt,
      updated_at: split.source.updatedAt }));
    for (const entry of split.installConfigs) {
      const base = oldRow(physicalByTable, "install_configs", entry.originalId);
      const config = entry.config;
      statements.push(insertRow(db, "install_configs", { ...base,
        id: config.id, space_id: config.workspaceId ?? null,
        record_json: checkedJson(config, `split InstallConfig:${config.id}`),
        created_at: config.createdAt, updated_at: config.updatedAt }));
    }
    statements.push(db.prepare(`update capsules set source_id = ?, install_config_id = ?, record_json = ?, updated_at = ? where id = ?`)
      .bind(split.source.id, split.capsule.installConfigId,
        checkedJson(split.capsule, `Capsule:${split.capsule.id}`), split.capsule.updatedAt, split.capsule.id));
    appendHistoryWrites(db, statements, "source_snapshots", "insert", split.snapshots.map((snapshot) => {
      const original = originalSnapshotsBySplitId.get(snapshot.id);
      const base = original ? oldRow(physicalByTable, "source_snapshots", original.id) : undefined;
      if (!base) throw new Error(`D1 Source ownership missing snapshot template: ${snapshot.id}`);
      return { ...base,
        id: snapshot.id, source_id: split.source.id,
        record_json: checkedJson(snapshot, `split Snapshot:${snapshot.id}`),
        fetched_at: snapshot.fetchedAt };
    }));
    appendHistoryWrites(db, statements, "runs", "insert", split.syncRuns.map((run) => {
      const original = originalSyncRunsBySplitId.get(run.id);
      if (!original) throw new Error(`D1 Source ownership missing Run template: ${run.id}`);
      const base = oldRow(physicalByTable, "runs", original.id);
      return { ...base, id: run.id, source_id: split.source.id,
        run_json: checkedJson(run, `split SyncRun:${run.id}`) };
    }));
    for (const run of split.compatibilityRuns) {
      const original = originalCompatibilityRunsBySplitId.get(run.id);
      if (!original) throw new Error(`D1 Source ownership missing CompatibilityRun template: ${run.id}`);
      const base = oldRow(physicalByTable, "runs", original.id);
      const previous = parseRun<Run>(base);
      statements.push(insertRow(db, "runs", { ...base, id: run.id,
        source_id: split.source.id,
        run_json: checkedJson({ ...previous, id: run.id, sourceId: run.sourceId,
          sourceSnapshotId: run.sourceSnapshotId, compatibilityReportId: run.compatibilityReportId },
          `split CompatibilityRun:${run.id}`) }));
    }
    appendHistoryWrites(db, statements, "runs", "update", split.planRuns.map((plan) => {
      const before = parseRun<PlanRun>(oldRow(physicalByTable, "runs", plan.id));
      return { id: plan.id, run_json: checkedJson({ ...before, sourceSnapshotId: plan.sourceSnapshotId,
        compatibilityReportId: plan.compatibilityReportId }, `PlanRun:${plan.id}`) };
    }));
    const originalGitPlans = mutation.expected.gitPlans.filter((plan) => plan.capsuleId === split.capsuleId);
    // Find each copy's original by its deterministic copy id, not by position,
    // so the selection stays exactly the core plan's.
    const originalReportsByCopyId = new Map(await Promise.all(mutation.expected.reports.map(async (report) =>
      [await splitId("cgr", report.id, split.capsuleId), report] as const)));
    for (const report of split.reports) {
      const original = originalReportsByCopyId.get(report.id);
      if (!original || original.sourceId !== mutation.sourceId || report.sourceId !== split.source.id ||
        (report.capsuleId !== undefined && report.capsuleId !== split.capsuleId) ||
        !split.snapshots.some((snapshot) => snapshot.id === report.sourceSnapshotId) ||
        report.sourceSnapshotId !== await splitId("snap", original.sourceSnapshotId, split.capsuleId) ||
        stableStringify(report) !== stableStringify({ ...original, id: report.id,
          sourceId: report.sourceId, sourceSnapshotId: report.sourceSnapshotId })) {
        throw new Error(`D1 Source ownership split report mismatch: ${report.id}`);
      }
      // Only identity changes; the stored analysis columns are the fenced original row.
      const base = oldRow(physicalByTable, "capsule_compatibility_reports", original.id);
      statements.push(insertRow(db, "capsule_compatibility_reports", { ...base,
        id: report.id, source_id: split.source.id, installation_id: report.capsuleId ?? null,
        source_snapshot_id: report.sourceSnapshotId }));
    }
    const originalPlans = originalGitPlans;
    if (originalPlans.length !== split.gitPlans.length) throw new Error("D1 Source ownership Git plan count mismatch");
    split.gitPlans.forEach((plan, index) => {
      const original = originalPlans[index]!;
      statements.push(db.prepare(`update git_install_plans set record_json = ?, updated_at = ? where id = ?`)
        .bind(checkedJson(plan, `GitInstallPlan:${plan.id}`), plan.updatedAt, original.id));
    });
  }
  for (const activity of mutation.activity) {
    statements.push(db.prepare(`insert into audit_events
      (id, space_id, actor_id, action, target_type, target_id, run_id, record_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(activity.id, activity.workspaceId, activity.actorId ?? null, activity.action,
        activity.targetType, activity.targetId, activity.runId ?? null,
        checkedJson(activity, `Activity:${activity.id}`), activity.createdAt));
  }
  try {
    const result = await db.batch(statements);
    if (result.some((entry) => entry.success === false)) throw new Error("D1 Source ownership batch failed");
    return "committed";
  } catch (error) {
    if (error instanceof Error && (error.message.includes("source_ownership_conflict") ||
      error.message.includes("malformed JSON"))) return "conflict";
    throw error;
  }
}
