/**
 * Operator-only Source ownership repair against the existing D1 schema.
 * Every observed physical row and each group membership count is fenced inside
 * the same D1 batch as the writes. A failed fence aborts that transaction.
 */
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule, CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { Run } from "takosumi-contract/runs";
import { isPlanRunRecord, type StoredRunRecord, type StoredSource } from
  "../../core/domains/deploy-control/store.ts";
import type { StoredGitInstallPlan } from "../../core/domains/install-plans/store.ts";
import { getCapsuleAdoptedSourceSnapshot } from "../../core/domains/deploy-control/capsule_source_revision.ts";
import { normalizeSourceSnapshotRecord } from "../../core/domains/deploy-control/store_row_mappers.ts";
import { sha256HexOfStringAsync } from "../../core/shared/runtime/hash.ts";
import type {
  SourceOwnershipMigrationGroup,
  SourceOwnershipMigrationMutation,
} from "../../core/domains/sources/ownership-migration.ts";
import type { D1Database, D1PreparedStatement } from "./bindings.ts";

type PhysicalRow = Record<string, string | number | null>;
type Table = "sources" | "capsules" | "source_snapshots" | "runs" |
  "capsule_compatibility_reports" | "git_install_plans";
interface ObservedTable {
  readonly table: Table;
  readonly where: string;
  readonly args: readonly string[];
  readonly rows: readonly PhysicalRow[];
}
const observations = new WeakMap<SourceOwnershipMigrationGroup, readonly ObservedTable[]>();
const encoder = new TextEncoder();
const D1_ROW_MAX_BYTES = 2_000_000;
const D1_GUARD_BIND_MAX_BYTES = 2_000_000;
const scopes = (sourceId: string): readonly Omit<ObservedTable, "rows">[] => [
  { table: "sources", where: "id = ?", args: [sourceId] },
  { table: "capsules", where: "source_id = ?", args: [sourceId] },
  { table: "source_snapshots", where: "source_id = ?", args: [sourceId] },
  { table: "runs", where: "(type in ('source_sync', 'compatibility_check') and source_id = ?) or (type in ('plan', 'destroy_plan', 'drift_check') and installation_id in (select id from capsules where source_id = ?))", args: [sourceId, sourceId] },
  { table: "capsule_compatibility_reports", where: "source_id = ? or installation_id in (select id from capsules where source_id = ?)", args: [sourceId, sourceId] },
  { table: "git_install_plans", where: "json_extract(record_json, '$.sourceId') = ? or json_extract(record_json, '$.preflight.sourceId') = ? or json_extract(record_json, '$.capsuleId') in (select id from capsules where source_id = ?)", args: [sourceId, sourceId, sourceId] },
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
      `select * from ${table} where (${where}) and id > ? order by id limit 100`,
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
    if (page.length < 100) return collected;
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

function parseRun<T>(row: PhysicalRow): T {
  const value = parseJson<unknown>(row, "run_json");
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

async function splitId(prefix: string, originalId: string, capsuleId: string): Promise<string> {
  const parts = [originalId, capsuleId, "split"];
  const material = parts.map((part) => `${part.length}:${part}`).join("|");
  return `${prefix}_${(await sha256HexOfStringAsync(material)).slice(0, 32)}`;
}

export async function listD1SourceOwnershipIds(db: D1Database): Promise<readonly string[]> {
  return (await pagedRows(db, "sources", "1 = 1", [])).map((row) => String(row.id));
}

export interface SourceOwnershipLineageReader {
  getSource(id: string): Promise<StoredSource | undefined>;
  getStateVersion(id: string): ReturnType<import("../../core/domains/deploy-control/store.ts").OpenTofuControlStore["getStateVersion"]>;
  getApplyRun(id: string): ReturnType<import("../../core/domains/deploy-control/store.ts").OpenTofuControlStore["getApplyRun"]>;
  getBackupRun(id: string): ReturnType<import("../../core/domains/deploy-control/store.ts").OpenTofuControlStore["getBackupRun"]>;
  getStateRecoveryRun(id: string): ReturnType<import("../../core/domains/deploy-control/store.ts").OpenTofuControlStore["getStateRecoveryRun"]>;
  getPlanRun(id: string): Promise<PlanRun | undefined>;
  getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined>;
  getCapsuleCompatibilityReport(id: string): Promise<CapsuleCompatibilityReport | undefined>;
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
  const capsules = await Promise.all(capsuleRows.map(async (row) => {
    const capsule = parseJson<Capsule>(row, "record_json");
    if (capsule.id !== row.id || capsule.sourceId !== sourceId || capsule.workspaceId !== source.workspaceId ||
      capsule.status !== row.status || capsule.updatedAt !== row.updated_at) {
      throw new Error(`D1 Source ownership Capsule scope mismatch: ${row.id}`);
    }
    const adopted = capsule.status === "destroyed" ? undefined :
      await getCapsuleAdoptedSourceSnapshot(reader, capsule);
    return { capsule, ...(adopted ? { adoptedSnapshotId: adopted.id } : {}) };
  }));
  const reports = await Promise.all(table("capsule_compatibility_reports").map(async (row) => {
    const report = await reader.getCapsuleCompatibilityReport(String(row.id));
    if (!report || report.id !== row.id || report.sourceSnapshotId !== row.source_snapshot_id ||
      report.sourceId !== row.source_id || (report.capsuleId ?? null) !== row.installation_id) {
      throw new Error(`D1 Source ownership report changed: ${row.id}`);
    }
    return report;
  }));
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
    ...gitPlans.filter((plan) => !["failed", "reviewable", "discarded"].includes(plan.phase))
      .map((plan) => `git_install_plan:${plan.id}`),
    ...table("git_install_plans").filter((row) => row.reconcile_lease_token !== null)
      .map((row) => `git_install_plan:${row.id}`),
  ];
  // Report getters use a separate read. Keep the group tied to exactly the
  // physical rows captured for its commit fence, even under concurrent edits.
  const reportScope = observed.find((entry) => entry.table === "capsule_compatibility_reports")!;
  const reportRowsAgain = await pagedRows(db, "capsule_compatibility_reports",
    reportScope.where, reportScope.args);
  if (JSON.stringify(reportRowsAgain) !== JSON.stringify(table("capsule_compatibility_reports"))) {
    throw new Error("D1 Source ownership report inventory changed");
  }
  const group: SourceOwnershipMigrationGroup = {
    source, capsules, snapshots, syncRuns, compatibilityRuns, planRuns, reports, gitPlans, inFlightRunIds,
  };
  observations.set(group, observed);
  return group;
}

function fence(db: D1Database, observed: ObservedTable): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [db.prepare(`select case when
    (select count(*) from ${observed.table} where ${observed.where}) = ?
    then 1 else json_extract('source_ownership_conflict', '$') end as guard`)
    .bind(...observed.args, observed.rows.length)];
  for (let i = 0; i < observed.rows.length;) {
    const chunk: PhysicalRow[] = [];
    while (i < observed.rows.length && chunk.length < 10) {
      const candidate = observed.rows[i]!;
      const next = [...chunk, candidate];
      const nextBytes = encoder.encode(JSON.stringify(next)).byteLength;
      if (nextBytes > D1_GUARD_BIND_MAX_BYTES) {
        if (chunk.length === 0) throw new Error(
          `D1 Source ownership ${observed.table}:${candidate.id} guard needs ${nextBytes} bytes; cannot fit one 2 MB D1 bound value`,
        );
        break;
      }
      chunk.push(candidate);
      i++;
    }
    const columns = Object.keys(chunk[0]!);
    if (!columns.every((name) => /^[a-z_]+$/u.test(name))) throw new Error("D1 Source ownership unexpected column");
    const mismatch = columns.map((name) =>
      `t.${name} is not json_extract(e.value, '$.${name}')`).join(" or ");
    statements.push(db.prepare(`select case when not exists (
      select 1 from json_each(?) e left join ${observed.table} t on t.id = json_extract(e.value, '$.id')
      where t.id is null or ${mismatch}
    ) then 1 else json_extract('source_ownership_conflict', '$') end as guard`)
      .bind(checkedJson(chunk, `${observed.table} guard chunk`)));
  }
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
    mutation.retainedSource.id !== mutation.sourceId || mutation.expected.inFlightRunIds.length > 0) return "conflict";
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
  statements.push(db.prepare(`update sources set status = ?, record_json = ?, updated_at = ? where id = ?`)
    .bind(mutation.retainedSource.status, checkedJson(mutation.retainedSource, "retained Source"),
      mutation.retainedSource.updatedAt, mutation.sourceId));
  for (const snapshot of mutation.retainedSnapshots) {
    statements.push(db.prepare(`update source_snapshots set record_json = ? where id = ?`)
      .bind(checkedJson(snapshot, `retained Snapshot:${snapshot.id}`), snapshot.id));
  }
  for (const run of mutation.retainedSyncRuns) {
    const before = parseRun<SourceSyncRun>(oldRow(physicalByTable, "runs", run.id));
    statements.push(db.prepare(`update runs set run_json = ? where id = ?`)
      .bind(checkedJson({ ...before, archiveRef: run.archiveRef }, `retained SyncRun:${run.id}`), run.id));
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
    statements.push(db.prepare(`update capsules set source_id = ?, record_json = ?, updated_at = ? where id = ?`)
      .bind(split.source.id, checkedJson(split.capsule, `Capsule:${split.capsule.id}`), split.capsule.updatedAt, split.capsule.id));
    for (const snapshot of split.snapshots) {
      const original = originalSnapshotsBySplitId.get(snapshot.id);
      const base = original ? oldRow(physicalByTable, "source_snapshots", original.id) : undefined;
      if (!base) throw new Error(`D1 Source ownership missing snapshot template: ${snapshot.id}`);
      statements.push(insertRow(db, "source_snapshots", { ...base,
        id: snapshot.id, source_id: split.source.id,
        record_json: checkedJson(snapshot, `split Snapshot:${snapshot.id}`),
        fetched_at: snapshot.fetchedAt }));
    }
    for (const run of split.syncRuns) {
      const original = originalSyncRunsBySplitId.get(run.id);
      if (!original) throw new Error(`D1 Source ownership missing Run template: ${run.id}`);
      const base = oldRow(physicalByTable, "runs", original.id);
      statements.push(insertRow(db, "runs", { ...base, id: run.id, source_id: split.source.id,
        run_json: checkedJson(run, `split SyncRun:${run.id}`) }));
    }
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
    for (const plan of split.planRuns) {
      const before = parseRun<PlanRun>(oldRow(physicalByTable, "runs", plan.id));
      statements.push(db.prepare(`update runs set run_json = ? where id = ?`)
        .bind(checkedJson({ ...before, sourceSnapshotId: plan.sourceSnapshotId,
          compatibilityReportId: plan.compatibilityReportId }, `PlanRun:${plan.id}`), plan.id));
    }
    const originalGitPlans = mutation.expected.gitPlans.filter((plan) => plan.capsuleId === split.capsuleId);
    const originalReports = mutation.expected.reports.filter((report) => report.capsuleId === split.capsuleId ||
      report.id === mutation.expected.capsules.find(({ capsule }) => capsule.id === split.capsuleId)?.capsule.compatibilityReportId ||
      mutation.expected.planRuns.some((plan) => plan.capsuleId === split.capsuleId && plan.compatibilityReportId === report.id) ||
      originalGitPlans.some((plan) => plan.compatibilityReportId === report.id ||
        plan.preflight?.compatibilityReportId === report.id));
    if (originalReports.length !== split.reports.length) throw new Error("D1 Source ownership report copy count mismatch");
    split.reports.forEach((report, index) => {
      const base = oldRow(physicalByTable, "capsule_compatibility_reports", originalReports[index]!.id);
      statements.push(insertRow(db, "capsule_compatibility_reports", { ...base,
        id: report.id, source_id: split.source.id, installation_id: report.capsuleId ?? null,
        source_snapshot_id: report.sourceSnapshotId }));
    });
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
