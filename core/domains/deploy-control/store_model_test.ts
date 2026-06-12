import { expect, test } from "bun:test";

import {
  InMemoryOpenTofuDeploymentStore,
  InstallationPatchGuardConflict,
} from "./store.ts";
import { SqlOpenTofuDeploymentStore } from "./store_sql.ts";
import { PGliteSqlClient } from "./pglite_sql_client.ts";
import { SqliteFakeD1 } from "./sqlite_fake_d1.ts";
import { CloudflareD1OpenTofuDeploymentStore } from "../../../worker/src/d1_opentofu_store.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../adapters/storage/sql.ts";
import type {
  Deployment,
  InstallConfig,
  Installation,
  StateSnapshot,
} from "@takosumi/internal/deploy-control-api";
import type { Space } from "takosumi-contract/spaces";
import type { OperatorConnectionDefault } from "takosumi-contract/provider-bindings";
import type { DeploymentProfile } from "takosumi-contract/installations";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type {
  Dependency,
  DependencySnapshot,
} from "takosumi-contract/dependencies";
import type {
  OutputShare,
  OutputSnapshot,
} from "takosumi-contract/output-snapshots";
import type { ArtifactRecord, RunGroup } from "takosumi-contract/runs";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { BackupRecord } from "takosumi-contract/backups";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "takosumi-contract/security";
import type { ProviderTemplate } from "takosumi-contract/providers";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";

/**
 * Minimal in-memory SQL client that interprets exactly the Space-direct model
 * statements the {@link SqlOpenTofuDeploymentStore} emits: `insert ... on
 * conflict`, `select` by id / single column / composite columns / kind-scoped
 * filter, `delete` by id and by `<col> = $ and id <> $`, and the guarded
 * `update ... returning`. Rows are keyed per logical table by primary id; column
 * values are read out of the stored JSON blob so no positional bookkeeping per
 * table is needed. Lets the SQL store run its real SQL paths without a Postgres.
 */
class ModelSqlClient implements SqlClient {
  // table -> id -> { id, json }
  readonly #tables = new Map<string, Map<string, StoredRow>>();

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const lower = sql.trim().toLowerCase();
    const params = (parameters ?? []) as readonly unknown[];
    const cast = (value: {
      rows: readonly unknown[];
      rowCount: number;
    }): SqlQueryResult<Row> => value as unknown as SqlQueryResult<Row>;

    if (lower.startsWith("insert into")) {
      const table = this.#table(tableName(lower));
      const id = String(params[0]);
      // The JSON blob is the last text param that parses as an object.
      const json = lastJsonParam(params);
      // Capture the explicit insert columns -> values so synthetic columns that
      // are NOT in the JSON blob (e.g. the `runs` table `kind` discriminator) are
      // still filterable. Falls back to the JSON blob for everything else.
      table.set(id, {
        id,
        json: json ?? "{}",
        columns: insertColumns(lower, params),
      });
      return Promise.resolve(cast({ rows: [], rowCount: 1 }));
    }
    if (lower.startsWith("update")) {
      const result = this.#update(lower, params);
      return Promise.resolve(cast(result));
    }
    if (lower.startsWith("delete from")) {
      const result = this.#delete(lower, params);
      return Promise.resolve(cast(result));
    }
    if (lower.startsWith("select")) {
      const result = this.#select(lower, params);
      return Promise.resolve(cast({ rows: result, rowCount: result.length }));
    }
    throw new Error(`unhandled SQL: ${sql}`);
  }

  #update(
    lower: string,
    params: readonly unknown[],
  ): { rows: Record<string, unknown>[]; rowCount: number } {
    const table = this.#table(tableName(lower));
    if (tableName(lower) === "takosumi_credit_balances") {
      const where = whereColumns(lower);
      const spaceWhere = where.find((c) => c.column === "space_id");
      const availableWhere = where.find(
        (c) => c.column === "available_credits",
      );
      const spaceId = String(params[spaceWhere?.indexes[0] ?? 3]);
      const minAvailable = Number(params[availableWhere?.indexes[0] ?? 4]);
      const credits = Number(params[0]);
      const updatedAt = String(params[2]);
      const row = table.get(spaceId);
      if (!row) return { rows: [], rowCount: 0 };
      const available = Number(rowCol(row, "available_credits") ?? 0);
      if (available < minAvailable) return { rows: [], rowCount: 0 };
      const reserved = Number(rowCol(row, "reserved_credits") ?? 0);
      const columns = {
        ...row.columns,
        available_credits: String(available - credits),
        reserved_credits: String(reserved + credits),
        updated_at: updatedAt,
      };
      const next = { id: row.id, json: row.json, columns };
      table.set(spaceId, next);
      return { rows: [selectedResultRow(next, lower)], rowCount: 1 };
    }
    // Only the guarded installation patch emits an UPDATE otherwise. Support
    // both the former handwritten-SQL parameter order and Drizzle's generated
    // order by reading predicate parameter indexes from the WHERE clause.
    const where = whereColumns(lower);
    const idWhere = where.find((c) => c.column === "id");
    const id = String(params[idWhere?.indexes[0] ?? 0]);
    const row = table.get(id);
    if (!row) return { rows: [], rowCount: 0 };
    const current = parseJsonObject(row.json);
    const currentDeployment = current?.currentDeploymentId ?? null;
    const currentStatus = current?.status;
    const deploymentWhere = where.find(
      (c) => c.column === "current_deployment_id",
    );
    const guardDeploymentValue =
      lower.includes('"current_deployment_id" is null') ||
      lower.includes("current_deployment_id is null")
        ? null
        : deploymentWhere
          ? (params[deploymentWhere.indexes[0]] ?? null)
          : (params[10] ?? null);
    if (currentDeployment !== guardDeploymentValue) {
      return { rows: [], rowCount: 0 };
    }
    const statusWhere = where.find((c) => c.column === "status");
    const guardStatus = statusWhere
      ? params[statusWhere.indexes[0]]
      : params[11];
    if (
      guardStatus !== null &&
      guardStatus !== undefined &&
      currentStatus !== guardStatus
    ) {
      return { rows: [], rowCount: 0 };
    }
    const json = lastJsonParam(params) ?? row.json;
    table.set(id, { id, json, columns: row.columns });
    return { rows: [jsonResultRow(json, lower)], rowCount: 1 };
  }

  #delete(
    lower: string,
    params: readonly unknown[],
  ): { rows: never[]; rowCount: number } {
    const table = this.#table(tableName(lower));
    // `delete ... where <col> = $1 and id <> $2` (single-default / one-per-pair
    // upsert) or `delete ... where <col> = $1 and <col2> = $2 and id <> $3`.
    if (/\.?"?id"?\s*<>/.test(lower)) {
      const cols = whereColumns(lower).filter((c) => c.column !== "id");
      const keepIndex =
        Number(/\.?"?id"?\s*<>\s*\$(\d+)/.exec(lower)?.[1] ?? cols.length + 1) -
        1;
      const keepId = String(params[keepIndex]);
      let removed = 0;
      for (const [key, row] of [...table]) {
        const matches = cols.every(
          (c, i) => rowCol(row, c.column) === String(params[i]),
        );
        if (matches && key !== keepId) {
          table.delete(key);
          removed += 1;
        }
      }
      return {
        rows: lower.includes(" returning ")
          ? Array.from({ length: removed }, () => ({}) as never)
          : [],
        rowCount: removed,
      };
    }
    // `delete ... where <pk> = $1`
    const idWhere = whereColumns(lower).find((c) => c.column === "id");
    const id = String(params[idWhere?.indexes[0] ?? 0]);
    const existed = table.delete(id);
    return {
      rows: existed && lower.includes(" returning ") ? [{} as never] : [],
      rowCount: existed ? 1 : 0,
    };
  }

  #select(
    lower: string,
    params: readonly unknown[],
  ): Record<string, unknown>[] {
    const table = this.#table(tableName(lower));
    const all = [...table.values()];
    const cols = whereColumns(lower);
    const matched =
      cols.length === 0
        ? all
        : all.filter((row) =>
            cols.every((c) =>
              c.indexes.some(
                (index) => rowCol(row, c.column) === String(params[index]),
              ),
            ),
          );
    const ordered = applyOrder(lower, matched);
    const limited = applyLimit(lower, params, ordered);
    return limited.map((row) => selectedResultRow(row, lower));
  }

  #table(name: string): Map<string, StoredRow> {
    let table = this.#tables.get(name);
    if (!table) {
      table = new Map();
      this.#tables.set(name, table);
    }
    return table;
  }

  /**
   * Single in-memory connection: BEGIN / COMMIT / ROLLBACK are simulated by
   * snapshotting the rows before `fn` and restoring them if `fn` throws. The
   * fake is serial so there is no concurrent isolation to model.
   */
  async transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    const snapshot = this.snapshot();
    try {
      return await fn(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  /** Deep-copies all rows so a transaction wrapper can roll back to this point. */
  snapshot(): Map<string, Map<string, StoredRow>> {
    const copy = new Map<string, Map<string, StoredRow>>();
    for (const [name, table] of this.#tables) {
      copy.set(name, new Map(table));
    }
    return copy;
  }

  /** Restores rows captured by {@link snapshot} (transaction rollback). */
  restore(snapshot: Map<string, Map<string, StoredRow>>): void {
    this.#tables.clear();
    for (const [name, table] of snapshot) {
      this.#tables.set(name, new Map(table));
    }
  }
}

/**
 * Wraps a {@link ModelSqlClient} with the {@link SqlClient.transaction} seam so
 * the SqlOpenTofuDeploymentStore's atomic `commitAppliedDeployment` exercises its
 * transactional path. `transaction(fn)` snapshots the inner rows, runs `fn`
 * against the inner client, and restores the snapshot if `fn` throws — a faithful
 * stand-in for a Postgres BEGIN / COMMIT / ROLLBACK. `entered` records that the
 * seam was used.
 */
class TransactionalModelSqlClient implements SqlClient {
  readonly inner = new ModelSqlClient();
  entered = 0;
  rolledBack = 0;

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.inner.query<Row>(sql, parameters);
  }

  async transaction<T>(fn: (tx: SqlTransaction) => T | Promise<T>): Promise<T> {
    this.entered += 1;
    const snapshot = this.inner.snapshot();
    try {
      return await fn(this);
    } catch (error) {
      this.rolledBack += 1;
      this.inner.restore(snapshot);
      throw error;
    }
  }
}

interface StoredRow {
  readonly id: string;
  readonly json: string;
  /** Explicit insert column -> value, for synthetic (non-JSON) columns. */
  readonly columns: Readonly<Record<string, string | undefined>>;
}

/** Parses `insert into t (a, b, c) values (...)` into column -> param value. */
function insertColumns(
  lower: string,
  params: readonly unknown[],
): Record<string, string | undefined> {
  const match = lower.match(
    /insert\s+into\s+"?takosumi_[a-z_]+"?\s*\(([^)]*)\)/,
  );
  if (!match) return {};
  const cols = match[1].split(",").map((c) => c.trim().replaceAll('"', ""));
  const out: Record<string, string | undefined> = {};
  cols.forEach((column, i) => {
    const value = params[i];
    out[column] =
      value === undefined || value === null ? undefined : String(value);
  });
  return out;
}

interface WhereColumn {
  readonly column: string;
  /** Zero-based positional param indexes ($1 -> 0). `=` has one; `in` has N. */
  readonly indexes: readonly number[];
}

/**
 * Parses `where a = $1 and b in ($2, $3) ...` into column/param-index pairs
 * (an `in` list carries every member index; a match against ANY succeeds).
 */
function whereColumns(lower: string): readonly WhereColumn[] {
  const whereStart = lower.indexOf(" where ");
  if (whereStart === -1) return [];
  const after = lower.slice(whereStart + 7);
  const clause = after
    .replace(/\border\s+by\b[\s\S]*$/, "")
    .replace(/\blimit\b[\s\S]*$/, "")
    .replace(/\breturning\b[\s\S]*$/, "");
  const cols: WhereColumn[] = [];
  const eqPattern = /"?([a-z_][a-z0-9_]*)"?\s*=\s*\$(\d+)/g;
  for (const match of clause.matchAll(eqPattern)) {
    cols.push({ column: match[1], indexes: [Number(match[2]) - 1] });
  }
  const inPattern = /"?([a-z_][a-z0-9_]*)"?\s+in\s*\(([^)]*)\)/g;
  for (const match of clause.matchAll(inPattern)) {
    const indexes = [...match[2].matchAll(/\$(\d+)/g)].map(
      (m) => Number(m[1]) - 1,
    );
    if (indexes.length > 0) cols.push({ column: match[1], indexes });
  }
  return cols;
}

/** Stable order by every `order by` column (generation numeric, else text). */
function applyOrder(
  lower: string,
  rows: readonly StoredRow[],
): readonly StoredRow[] {
  const order = /\border\s+by\s+([\s\S]+?)(?:\blimit\b|\breturning\b|$)/.exec(
    lower,
  )?.[1];
  if (!order) return rows;
  const terms = order
    .split(",")
    .map((term) => {
      const direction = /\bdesc\b/.test(term) ? -1 : 1;
      const identifiers = [...term.matchAll(/"?([a-z_][a-z0-9_]*)"?/g)]
        .map((match) => match[1])
        .filter((identifier) => identifier !== "asc" && identifier !== "desc");
      return { column: identifiers.at(-1), direction };
    })
    .filter(
      (term): term is { column: string; direction: number } =>
        term.column !== undefined,
    );
  if (terms.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const term of terms) {
      const av = rowCol(a, term.column) ?? "";
      const bv = rowCol(b, term.column) ?? "";
      const an = Number(av);
      const bn = Number(bv);
      const cmp =
        !Number.isNaN(an) && !Number.isNaN(bn) && av !== "" && bv !== ""
          ? an - bn
          : av.localeCompare(bv);
      if (cmp !== 0) return cmp * term.direction;
    }
    return 0;
  });
}

function applyLimit(
  lower: string,
  params: readonly unknown[],
  rows: readonly StoredRow[],
): readonly StoredRow[] {
  const match = /\blimit\s+(?:\$(\d+)|(\d+))/.exec(lower);
  if (!match) return rows;
  const raw = match[1] !== undefined ? params[Number(match[1]) - 1] : match[2];
  const limit = Number(raw);
  return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
}

/**
 * Resolves a snake_case column value for a stored row: explicit insert columns
 * first (so synthetic columns not present in the JSON blob, like the `runs`
 * table `kind`, are filterable / orderable), then the parsed JSON (camelCase).
 */
function rowCol(row: StoredRow, column: string): string | undefined {
  if (column in row.columns) return row.columns[column];
  return col(parseJsonObject(row.json), column);
}

/** Reads a snake_case column value from the row's parsed JSON (camelCase keys). */
function col(
  obj: Record<string, unknown> | undefined,
  column: string,
): string | undefined {
  if (!obj) return undefined;
  const camel = column.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const value = obj[camel];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function lastJsonParam(params: readonly unknown[]): string | undefined {
  for (let i = params.length - 1; i >= 0; i -= 1) {
    const p = params[i];
    if (typeof p === "string" && p.startsWith("{")) return p;
  }
  return undefined;
}

function tableName(lower: string): string {
  const match = lower.match(/(?:into|from|update)\s+"?(takosumi_[a-z_]+)"?/);
  if (!match) throw new Error(`no table in SQL: ${lower}`);
  return match[1];
}

function jsonResultRow(json: unknown, lower: string): Record<string, unknown> {
  const row: Record<string, unknown> = { json };
  for (const column of selectedColumns(lower)) {
    row[column] = json;
  }
  return row;
}

function selectedResultRow(
  row: StoredRow,
  lower: string,
): Record<string, unknown> {
  const selected = selectedColumns(lower);
  if (tableName(lower) === "takosumi_capsule_compatibility_reports") {
    const out: Record<string, unknown> = {};
    for (const column of selected) {
      out[column] = rowCol(row, column);
    }
    return out;
  }
  if (
    selected.some((column) => column.endsWith("_json") || column === "json")
  ) {
    return jsonResultRow(row.json, lower);
  }
  const out: Record<string, unknown> = {};
  for (const column of selected) {
    out[column] = rowCol(row, column);
  }
  return out;
}

function selectedColumns(lower: string): readonly string[] {
  const select = lower.match(/^select\s+([\s\S]+?)\s+from\s/);
  const returning = lower.match(/\sreturning\s+([\s\S]+)$/);
  const list = select?.[1] ?? returning?.[1];
  if (!list) return [];
  return [...list.matchAll(/"?([a-z_][a-z0-9_]*)"?/g)]
    .map((match) => match[1])
    .filter((column) => column !== "as");
}

// --- fixtures --------------------------------------------------------------

const TS = "2026-06-06T00:00:00.000Z";

function space(over: Partial<Space> = {}): Space {
  return {
    id: "space_1",
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function installConfig(over: Partial<InstallConfig> = {}): InstallConfig {
  return {
    id: "cfg_1",
    name: "Cloudflare R2",
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function operatorDefault(
  over: Partial<OperatorConnectionDefault> = {},
): OperatorConnectionDefault {
  return {
    id: "ocd_1",
    provider: "cloudflare",
    connectionId: "conn_1",
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function installation(over: Partial<Installation> = {}): Installation {
  return {
    id: "inst_1",
    spaceId: "space_1",
    name: "shop",
    slug: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
    installConfigId: "cfg_1",
    environment: "production",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep_1",
    spaceId: "space_1",
    installationId: "inst_1",
    environment: "production",
    applyRunId: "run_apply_1",
    sourceSnapshotId: "snap_1",
    stateGeneration: 1,
    outputSnapshotId: "out_1",
    outputsPublic: {},
    status: "active",
    createdAt: TS,
    ...over,
  };
}

function deploymentProfile(
  over: Partial<DeploymentProfile> = {},
): DeploymentProfile {
  return {
    id: "dpf_1",
    spaceId: "space_1",
    installationId: "inst_1",
    environment: "production",
    bindings: [{ provider: "cloudflare", alias: "main", mode: "default" }],
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function stateSnapshot(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    id: "snap_1",
    spaceId: "space_1",
    installationId: "inst_1",
    environment: "production",
    generation: 1,
    objectKey:
      "spaces/space_1/installations/inst_1/envs/production/states/00000001.tfstate.enc",
    digest: "sha256:abc",
    createdByRunId: "run_apply_1",
    createdAt: TS,
    ...over,
  };
}

function sourceSyncRun(over: Partial<SourceSyncRun> = {}): SourceSyncRun {
  return {
    id: "ssr_1",
    kind: "source_sync",
    spaceId: "space_1",
    sourceId: "src_1",
    url: "https://example.com/repo.git",
    ref: "main",
    path: ".",
    archiveObjectKey:
      "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
    status: "queued",
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function dependency(over: Partial<Dependency> = {}): Dependency {
  return {
    id: "dep_edge_1",
    spaceId: "space_1",
    producerInstallationId: "inst_producer",
    consumerInstallationId: "inst_consumer",
    mode: "variable_injection",
    outputs: {
      bucket_name: { from: "bucket_name", to: "bucket", required: true },
    },
    visibility: "space",
    createdAt: TS,
    ...over,
  };
}

function dependencySnapshot(
  over: Partial<DependencySnapshot> = {},
): DependencySnapshot {
  return {
    id: "depsnap_1",
    runId: "run_plan_1",
    mode: "strict",
    dependencies: [
      {
        dependencyId: "dep_edge_1",
        producerInstallationId: "inst_producer",
        producerStateGeneration: 3,
        producerOutputSnapshotId: "out_3",
        producerOutputDigest: "sha256:prod",
        valuesDigest: "sha256:vals",
        values: { bucket: "my-bucket" },
      },
    ],
    createdAt: TS,
    ...over,
  };
}

function outputSnapshot(over: Partial<OutputSnapshot> = {}): OutputSnapshot {
  return {
    id: "out_1",
    spaceId: "space_1",
    installationId: "inst_1",
    stateGeneration: 1,
    rawOutputArtifactKey:
      "spaces/space_1/installations/inst_1/runs/run_apply_1/outputs.raw.json.enc",
    publicOutputs: { launch_url: "https://x.example" },
    spaceOutputs: { launch_url: "https://x.example", bucket_name: "my-bucket" },
    outputDigest: "sha256:out1",
    createdAt: TS,
    ...over,
  };
}

function outputShare(over: Partial<OutputShare> = {}): OutputShare {
  return {
    id: "oshare_1",
    fromSpaceId: "space_1",
    toSpaceId: "space_2",
    producerInstallationId: "inst_producer",
    outputs: [{ name: "bucket_name", alias: "bucket", sensitive: false }],
    status: "active",
    createdAt: TS,
    ...over,
  };
}

function activityEvent(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "act_1",
    spaceId: "space_1",
    actorId: "user_1",
    action: "installation.created",
    targetType: "installation",
    targetId: "inst_1",
    metadata: { name: "shop", environment: "production" },
    createdAt: TS,
    ...over,
  };
}

function credentialMintEvent(
  over: Partial<CredentialMintEvent> = {},
): CredentialMintEvent {
  return {
    id: "credmint_1",
    runId: "run_1",
    spaceId: "space_1",
    installationId: "inst_1",
    connectionId: "conn_1",
    phase: "plan",
    capabilities: ["cloudflare"],
    createdAt: TS,
    ...over,
  };
}

function securityFinding(over: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: "sec_1",
    spaceId: "space_1",
    installationId: "inst_1",
    runId: "run_1",
    severity: "warning",
    type: "capsule_gate",
    message: "backend block was overridden",
    metadata: { code: "backend_overridden" },
    createdAt: TS,
    ...over,
  };
}

function runGroup(over: Partial<RunGroup> = {}): RunGroup {
  return {
    id: "rg_1",
    spaceId: "space_1",
    type: "space_update",
    status: "queued",
    graphJson: JSON.stringify({
      order: [["inst_1"]],
      runs: { inst_1: "run_1" },
    }),
    createdAt: TS,
    ...over,
  };
}

function backupRecord(over: Partial<BackupRecord> = {}): BackupRecord {
  return {
    id: "bkp_1",
    spaceId: "space_1",
    objectKey: "spaces/space_1/backups/bkp_1/control.json.zst.enc",
    digest: "sha256:" + "a".repeat(64),
    sizeBytes: 2048,
    createdAt: TS,
    ...over,
  };
}

function artifactRecord(over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: "artifact_1",
    runId: "run_1",
    kind: "plan_json",
    objectKey:
      "spaces/space_1/installations/inst_1/runs/run_1/plan.json.zst.enc",
    digest: "sha256:" + "b".repeat(64),
    sizeBytes: 1024,
    createdAt: TS,
    ...over,
  };
}

// Run the same assertions against EVERY real store engine so the in-memory
// dev/test store, the Postgres SQL store, and the D1 store stay symmetric. The
// Postgres leg runs on PGlite (in-process WASM Postgres) and the D1 leg on a
// bun:sqlite-backed D1 fake, so the matrix exercises the stores' actual SQL and
// the canonical migration DDL — not a hand-rolled approximation.
async function forEachStore(): Promise<
  readonly [string, OpenTofuDeploymentStore][]
> {
  const pgClient = await PGliteSqlClient.create();
  return [
    ["memory", new InMemoryOpenTofuDeploymentStore()],
    ["pg", new SqlOpenTofuDeploymentStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1())],
  ];
}

test("Space store: put/get/get-by-handle/list are symmetric", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putSpace(space({ id: "space_a", handle: "alice" }));
    await store.putSpace(
      space({
        id: "space_b",
        handle: "bob",
        createdAt: "2026-06-07T00:00:00.000Z",
      }),
    );

    expect((await store.getSpace("space_a"))?.handle, label).toBe("alice");
    expect(await store.getSpace("missing"), label).toBeUndefined();
    expect((await store.getSpaceByHandle("bob"))?.id, label).toBe("space_b");
    expect(await store.getSpaceByHandle("nobody"), label).toBeUndefined();
    expect(
      (await store.listSpaces()).map((s) => s.id),
      label,
    ).toEqual(["space_a", "space_b"]);
  }
});

test("InstallConfig store: put/get/list-by-space + built-in shared configs", async () => {
  for (const [label, store] of await forEachStore()) {
    // Space-authored config + a built-in shared config (no spaceId).
    await store.putInstallConfig(
      installConfig({ id: "cfg_a", spaceId: "space_1" }),
    );
    await store.putInstallConfig(installConfig({ id: "cfg_official" }));

    expect((await store.getInstallConfig("cfg_a"))?.name, label).toBe(
      "Cloudflare R2",
    );
    expect(await store.getInstallConfig("missing"), label).toBeUndefined();

    const forSpace = await store.listInstallConfigs("space_1");
    expect(
      forSpace.map((c) => c.id),
      label,
    ).toEqual(["cfg_a"]);
    expect((await store.listInstallConfigs()).length, label).toBe(2);
  }
});

test("OperatorConnectionDefault store: one default per provider", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putOperatorConnectionDefault(
      operatorDefault({
        id: "ocd_a",
        provider: "cloudflare",
      }),
    );
    // A second default for the same provider replaces the first.
    await store.putOperatorConnectionDefault(
      operatorDefault({ id: "ocd_b", provider: "cloudflare" }),
    );
    await store.putOperatorConnectionDefault(
      operatorDefault({
        id: "ocd_aws",
        provider: "hashicorp/aws",
      }),
    );

    const cloudflare = await store.getOperatorConnectionDefault("cloudflare");
    expect(cloudflare?.id, label).toBe("ocd_b");
    expect(cloudflare?.provider, label).toBe("cloudflare");
    expect(
      await store.getOperatorConnectionDefault("hashicorp/google"),
      label,
    ).toBeUndefined();
    expect(
      (await store.listOperatorConnectionDefaults()).map((d) => d.provider),
      label,
    ).toEqual(["cloudflare", "hashicorp/aws"]);
  }
});

test("Provider Template store: entries are symmetric", async () => {
  for (const [label, store] of await forEachStore()) {
    const entry: ProviderTemplate = {
      id: "cloudflare",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare",
      displayName: "Cloudflare",
      recommendedEnvNames: ["CLOUDFLARE_API_TOKEN"],
      helpers: ["cloudflare_api_token"],
      credentialSources: ["takosumi_managed", "user_env_set"],
      takosumiManagedAvailable: true,
      allowedResources: ["cloudflare_workers_script"],
      allowedDataSources: [],
      policyPackId: "cloudflare-default",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    };
    await store.putProviderTemplate(entry);
    expect(await store.getProviderTemplate(entry.id), label).toEqual(entry);
    expect(await store.listProviderTemplates(), label).toContainEqual(entry);
  }
});

test("CapsuleCompatibilityReport store preserves owner fields", async () => {
  for (const [label, store] of await forEachStore()) {
    const report: CapsuleCompatibilityReport = {
      id: "caprep_owner",
      sourceId: "src_1",
      installationId: "inst_1",
      sourceSnapshotId: "snap_1",
      level: "ready",
      findings: [],
      providers: [],
      resources: [],
      dataSources: [],
      provisioners: [],
      normalizedObjectKey:
        "spaces/space_1/installations/inst_1/runs/run_1/normalized-module.tar.zst",
      normalizedDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: "2026-06-08T00:00:00.000Z",
    };
    await store.putCapsuleCompatibilityReport(report);
    expect(await store.getCapsuleCompatibilityReport(report.id), label)
      .toMatchObject({
        id: report.id,
        sourceId: report.sourceId,
        installationId: report.installationId,
        sourceSnapshotId: report.sourceSnapshotId,
      });
  }
});

test("Installation store: put/get/get-by-name/list/unique are symmetric", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putInstallation(
      installation({ id: "inst_a", spaceId: "space_1" }),
    );
    await store.putInstallation(
      installation({ id: "inst_b", spaceId: "space_2", name: "blog" }),
    );

    expect((await store.getInstallation("inst_a"))?.name, label).toBe("shop");
    expect(await store.getInstallation("missing"), label).toBeUndefined();

    const byName = await store.getInstallationByName(
      "space_1",
      "shop",
      "production",
    );
    expect(byName?.id, label).toBe("inst_a");
    expect(
      await store.getInstallationByName("space_1", "shop", "staging"),
      label,
    ).toBeUndefined();

    const forSpace = await store.listInstallations("space_1");
    expect(
      forSpace.map((i) => i.id),
      label,
    ).toEqual(["inst_a"]);
    expect((await store.listInstallations()).length, label).toBe(2);
  }
});

test("Installation unique(space_id, name, environment) is enforced (in-memory)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putInstallation(installation({ id: "inst_a" }));
  await expect(
    store.putInstallation(installation({ id: "inst_dup" })),
  ).rejects.toThrow(/unique/);
  // A different environment under the same name/space is allowed.
  await store.putInstallation(
    installation({ id: "inst_staging", environment: "staging" }),
  );
  expect((await store.listInstallations("space_1")).length).toBe(2);
});

test("Installation patch: unguarded mutate is symmetric", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putInstallation(installation({ id: "inst_p" }));
    const patched = await store.patchInstallation("inst_p", {
      status: "active",
      currentStateGeneration: 1,
      currentDeploymentId: "dep_1",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(patched?.status, label).toBe("active");
    expect(patched?.currentStateGeneration, label).toBe(1);
    expect(patched?.currentDeploymentId, label).toBe("dep_1");
    expect((await store.getInstallation("inst_p"))?.status, label).toBe(
      "active",
    );
    expect(
      await store.patchInstallation("missing", { status: "error" }),
      label,
    ).toBeUndefined();
  }
});

test("Installation patch: guard fences on currentDeploymentId", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putInstallation(installation({ id: "inst_g" }));
    // Guard matches (undefined cursor) -> succeeds and advances the cursor.
    const ok = await store.patchInstallation(
      "inst_g",
      { currentDeploymentId: "dep_1", status: "active" },
      { currentDeploymentId: undefined },
    );
    expect(ok?.currentDeploymentId, label).toBe("dep_1");

    // Guard with the stale cursor (undefined) now loses the race.
    await expect(
      store.patchInstallation(
        "inst_g",
        { currentDeploymentId: "dep_2" },
        { currentDeploymentId: undefined },
      ),
    ).rejects.toBeInstanceOf(InstallationPatchGuardConflict);

    // Guard with the correct cursor succeeds.
    const ok2 = await store.patchInstallation(
      "inst_g",
      { currentDeploymentId: "dep_2" },
      { currentDeploymentId: "dep_1" },
    );
    expect(ok2?.currentDeploymentId, label).toBe("dep_2");
  }
});

test("Deployment store: put/get/list-by-installation are symmetric", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putDeployment(
      deployment({ id: "dep_a", installationId: "inst_1" }),
    );
    await store.putDeployment(
      deployment({
        id: "dep_b",
        installationId: "inst_1",
        stateGeneration: 2,
        createdAt: "2026-06-07T00:00:00.000Z",
      }),
    );
    await store.putDeployment(
      deployment({ id: "dep_c", installationId: "inst_2" }),
    );

    expect((await store.getDeployment("dep_a"))?.stateGeneration, label).toBe(
      1,
    );
    expect(await store.getDeployment("missing"), label).toBeUndefined();
    const forInst = await store.listDeployments("inst_1");
    expect(
      forInst.map((d) => d.id),
      label,
    ).toEqual(["dep_a", "dep_b"]);
  }
});

test("commitAppliedDeployment: writes the atomic unit + supersedes the prior deployment", async () => {
  for (const [label, store] of await forEachStore()) {
    // Seed an installation that already has a current (active) deployment +
    // outputSnapshot at generation 1, so the commit must supersede it.
    await store.putInstallation(
      installation({
        id: "inst_1",
        status: "active",
        currentStateGeneration: 1,
        currentDeploymentId: "dep_old",
        currentOutputSnapshotId: "out_old",
      }),
    );
    await store.putDeployment(
      deployment({ id: "dep_old", outputSnapshotId: "out_old", status: "active" }),
    );

    const committed = await store.commitAppliedDeployment({
      newDeployment: deployment({
        id: "dep_new",
        stateGeneration: 2,
        outputSnapshotId: "out_new",
        status: "active",
        createdAt: "2026-06-07T00:00:00.000Z",
      }),
      supersededDeployment: {
        ...deployment({ id: "dep_old", outputSnapshotId: "out_old" }),
        status: "superseded",
      },
      stateSnapshot: stateSnapshot({ id: "state_2", generation: 2 }),
      outputSnapshot: outputSnapshot({ id: "out_new", stateGeneration: 2 }),
      installationPatch: {
        id: "inst_1",
        patch: {
          currentDeploymentId: "dep_new",
          status: "active",
          currentStateGeneration: 2,
          currentOutputSnapshotId: "out_new",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
        guard: { currentDeploymentId: "dep_old", status: "active" },
      },
    });

    // The guarded patch landed and is returned.
    expect(committed.installation?.currentDeploymentId, label).toBe("dep_new");
    expect(committed.installation?.currentStateGeneration, label).toBe(2);
    expect(committed.installation?.currentOutputSnapshotId, label).toBe(
      "out_new",
    );

    // Every record in the unit is persisted.
    expect((await store.getDeployment("dep_new"))?.status, label).toBe("active");
    expect((await store.getDeployment("dep_old"))?.status, label).toBe(
      "superseded",
    );
    expect(
      (await store.getLatestStateSnapshot("inst_1", "production"))?.generation,
      label,
    ).toBe(2);
    expect((await store.getOutputSnapshot("out_new"))?.stateGeneration, label).toBe(
      2,
    );
    const reread = await store.getInstallation("inst_1");
    expect(reread?.currentDeploymentId, label).toBe("dep_new");
    expect(reread?.currentStateGeneration, label).toBe(2);
  }
});

test("commitAppliedDeployment: guard miss on a missing installation returns undefined", async () => {
  for (const [label, store] of await forEachStore()) {
    const committed = await store.commitAppliedDeployment({
      newDeployment: deployment({ id: "dep_x" }),
      stateSnapshot: stateSnapshot({ id: "state_x" }),
      outputSnapshot: outputSnapshot({ id: "out_x" }),
      installationPatch: {
        id: "inst_missing",
        patch: { status: "active", updatedAt: TS },
        guard: { currentDeploymentId: undefined },
      },
    });
    expect(committed.installation, label).toBeUndefined();
  }
});

test("commitAppliedDeployment: guard conflict throws InstallationPatchGuardConflict", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putInstallation(
      installation({ id: "inst_1", currentDeploymentId: "dep_current" }),
    );
    await expect(
      store.commitAppliedDeployment({
        newDeployment: deployment({ id: "dep_new" }),
        stateSnapshot: stateSnapshot({ id: "state_new" }),
        outputSnapshot: outputSnapshot({ id: "out_new" }),
        installationPatch: {
          id: "inst_1",
          patch: { currentDeploymentId: "dep_new", updatedAt: TS },
          // Stale cursor: the row's current deployment is `dep_current`.
          guard: { currentDeploymentId: undefined },
        },
      }),
      label,
    ).rejects.toBeInstanceOf(InstallationPatchGuardConflict);
  }
});

test("commitAppliedDeployment (SQL): runs inside the SqlClient transaction seam and rolls back on a mid-commit throw", async () => {
  const client = new TransactionalModelSqlClient();
  const store = new SqlOpenTofuDeploymentStore({ client });
  await store.putInstallation(
    installation({ id: "inst_1", status: "pending", currentStateGeneration: 0 }),
  );

  // A successful commit goes THROUGH the transaction seam.
  await store.commitAppliedDeployment({
    newDeployment: deployment({ id: "dep_ok", outputSnapshotId: "out_ok" }),
    stateSnapshot: stateSnapshot({ id: "state_ok" }),
    outputSnapshot: outputSnapshot({ id: "out_ok" }),
    installationPatch: {
      id: "inst_1",
      patch: {
        currentDeploymentId: "dep_ok",
        status: "active",
        currentStateGeneration: 1,
        currentOutputSnapshotId: "out_ok",
        updatedAt: TS,
      },
      guard: { currentDeploymentId: undefined, status: "pending" },
    },
  });
  expect(client.entered).toBe(1);
  expect(client.rolledBack).toBe(0);
  expect((await store.getDeployment("dep_ok"))?.status).toBe("active");
  expect((await store.getInstallation("inst_1"))?.currentDeploymentId).toBe(
    "dep_ok",
  );

  // A guard CONFLICT mid-commit throws and rolls the whole unit back: the
  // deployment/state/output writes that ran before the guarded UPDATE must NOT
  // survive (the cursor is now `dep_ok`, so the stale `undefined` guard loses).
  await expect(
    store.commitAppliedDeployment({
      newDeployment: deployment({ id: "dep_torn", outputSnapshotId: "out_torn" }),
      stateSnapshot: stateSnapshot({ id: "state_torn", generation: 2 }),
      outputSnapshot: outputSnapshot({ id: "out_torn", stateGeneration: 2 }),
      installationPatch: {
        id: "inst_1",
        patch: { currentDeploymentId: "dep_torn", updatedAt: TS },
        guard: { currentDeploymentId: undefined },
      },
    }),
  ).rejects.toBeInstanceOf(InstallationPatchGuardConflict);
  expect(client.entered).toBe(2);
  expect(client.rolledBack).toBe(1);
  // Rolled back: the torn records never landed and the installation is unmoved.
  expect(await store.getDeployment("dep_torn")).toBeUndefined();
  expect(await store.getOutputSnapshot("out_torn")).toBeUndefined();
  expect(
    (await store.getLatestStateSnapshot("inst_1", "production"))?.generation,
  ).toBe(1);
  expect((await store.getInstallation("inst_1"))?.currentDeploymentId).toBe(
    "dep_ok",
  );
});

test("DeploymentProfile store: upsert keyed (installation, environment)", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putDeploymentProfile(deploymentProfile({ id: "dpf_a" }));
    // A second profile for the SAME (installation, environment) replaces it.
    await store.putDeploymentProfile(
      deploymentProfile({
        id: "dpf_b",
        bindings: [
          {
            provider: "cloudflare",
            alias: "zone",
            mode: "connection",
            connectionId: "conn_zone",
          },
        ],
      }),
    );
    // A different environment for the same installation coexists.
    await store.putDeploymentProfile(
      deploymentProfile({ id: "dpf_staging", environment: "staging" }),
    );

    const prod = await store.getDeploymentProfileByInstallation(
      "inst_1",
      "production",
    );
    expect(prod?.id, label).toBe("dpf_b");
    expect(prod?.bindings[0]?.connectionId, label).toBe("conn_zone");
    expect(prod?.bindings[0]?.alias, label).toBe("zone");

    const staging = await store.getDeploymentProfileByInstallation(
      "inst_1",
      "staging",
    );
    expect(staging?.id, label).toBe("dpf_staging");
    expect(
      await store.getDeploymentProfileByInstallation("inst_1", "missing"),
      label,
    ).toBeUndefined();
  }
});

test("StateSnapshot store: put/latest/list keyed (installation, environment, generation)", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putStateSnapshot(
      stateSnapshot({ id: "snap_g1", generation: 1 }),
    );
    await store.putStateSnapshot(
      stateSnapshot({ id: "snap_g3", generation: 3 }),
    );
    await store.putStateSnapshot(
      stateSnapshot({ id: "snap_g2", generation: 2 }),
    );
    // A different environment is isolated.
    await store.putStateSnapshot(
      stateSnapshot({
        id: "snap_staging",
        environment: "staging",
        generation: 5,
      }),
    );

    const latest = await store.getLatestStateSnapshot("inst_1", "production");
    expect(latest?.generation, label).toBe(3);
    const list = await store.listStateSnapshots("inst_1", "production");
    expect(
      list.map((s) => s.generation),
      label,
    ).toEqual([1, 2, 3]);
    expect(
      (await store.getLatestStateSnapshot("inst_1", "staging"))?.generation,
      label,
    ).toBe(5);
    expect(
      await store.getLatestStateSnapshot("inst_1", "missing"),
      label,
    ).toBeUndefined();
  }
});

test("runs table: plan/apply/source_sync/compatibility_check/backup rows verify kind", async () => {
  for (const [label, store] of await forEachStore()) {
    const plan = makePlanRun("run_plan_1");
    const drift = makePlanRun("run_drift_1", { driftCheck: true });
    const apply = makeApplyRun("run_apply_1", "run_plan_1");
    await store.putPlanRun(plan);
    await store.putPlanRun(drift);
    await store.putApplyRun(apply);
    await store.putBackupRun({
      id: "backup_1",
      spaceId: "space_1",
      installationId: "inst_1",
      environment: "production",
      type: "backup",
      status: "succeeded",
      createdBy: "system",
      createdAt: "2026-06-07T00:00:00.000Z",
      startedAt: "2026-06-07T00:00:00.000Z",
      finishedAt: "2026-06-07T00:00:00.000Z",
    });
    await store.putSourceSyncRun(
      sourceSyncRun({ id: "ssr_a", sourceId: "src_1" }),
    );
    await store.putSourceSyncRun(
      sourceSyncRun({
        id: "ssr_b",
        sourceId: "src_1",
        createdAt: "2026-06-07T00:00:00.000Z",
      }),
    );
    await store.putSourceSyncRun(
      sourceSyncRun({ id: "ssr_c", sourceId: "src_2" }),
    );
    await store.putCompatibilityCheckRun({
      id: "ccr_1",
      spaceId: "space_1",
      sourceId: "src_1",
      type: "compatibility_check",
      status: "succeeded",
      sourceSnapshotId: "snap_1",
      compatibilityReportId: "caprep_1",
      createdBy: "system",
      createdAt: "2026-06-07T00:00:00.000Z",
      startedAt: "2026-06-07T00:00:00.000Z",
      finishedAt: "2026-06-07T00:00:00.000Z",
    });
    expect((await store.getPlanRun("run_plan_1"))?.id, label).toBe(
      "run_plan_1",
    );
    expect((await store.getPlanRun("run_drift_1"))?.driftCheck, label).toBe(
      true,
    );
    expect((await store.getApplyRun("run_apply_1"))?.planRunId, label).toBe(
      "run_plan_1",
    );
    expect((await store.getSourceSyncRun("ssr_a"))?.sourceId, label).toBe(
      "src_1",
    );
    expect((await store.getBackupRun("backup_1"))?.type, label).toBe("backup");
    expect((await store.getBackupRun("backup_1"))?.installationId, label).toBe(
      "inst_1",
    );
    expect(
      (await store.getCompatibilityCheckRun("ccr_1"))?.compatibilityReportId,
      label,
    ).toBe("caprep_1");

    // Kind is verified: a plan id is not an apply, and vice versa.
    expect(await store.getApplyRun("run_plan_1"), label).toBeUndefined();
    expect(await store.getPlanRun("run_apply_1"), label).toBeUndefined();
    expect(await store.getSourceSyncRun("run_plan_1"), label).toBeUndefined();
    expect(
      await store.getCompatibilityCheckRun("run_plan_1"),
      label,
    ).toBeUndefined();
    expect(await store.getBackupRun("run_plan_1"), label).toBeUndefined();

    const forSource = await store.listSourceSyncRuns("src_1");
    expect(
      forSource.map((r) => r.id),
      label,
    ).toEqual(["ssr_a", "ssr_b"]);

    // A PlanRun created as a RunGroup member round-trips its runGroupId (§19).
    await store.putPlanRun(makePlanRun("run_plan_grp", { runGroupId: "rg_x" }));
    expect((await store.getPlanRun("run_plan_grp"))?.runGroupId, label).toBe(
      "rg_x",
    );
  }
});

test("transitionRun: a matching expectFrom wins and returns the new run", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putPlanRun({ ...makePlanRun("run_t_a"), status: "queued" });

    const result = await store.transitionRun({
      id: "run_t_a",
      kind: "plan",
      expectFrom: ["queued"],
      run: { ...makePlanRun("run_t_a"), status: "running", startedAt: 9_000 },
      setLeaseToken: "lease_1",
      heartbeatAt: 9_000,
    });

    expect(result.won, label).toBe(true);
    expect(result.run?.status, label).toBe("running");
    expect(result.run?.heartbeatAt, label).toBe(9_000);
    // The persisted row reflects the transition on re-read.
    const persisted = await store.getPlanRun("run_t_a");
    expect(persisted?.status, label).toBe("running");
    expect(persisted?.startedAt, label).toBe(9_000);
  }
});

test("transitionRun: a non-matching expectFrom loses and leaves the row unchanged", async () => {
  for (const [label, store] of await forEachStore()) {
    // The row is already `running`; a claim that expects `queued` must lose.
    await store.putPlanRun({ ...makePlanRun("run_t_b"), status: "running" });

    const result = await store.transitionRun({
      id: "run_t_b",
      kind: "plan",
      expectFrom: ["queued"],
      run: { ...makePlanRun("run_t_b"), status: "succeeded" },
    });

    expect(result.won, label).toBe(false);
    // The re-read returns the unchanged current row.
    expect(result.run?.status, label).toBe("running");
    const persisted = await store.getPlanRun("run_t_b");
    expect(persisted?.status, label).toBe("running");
  }
});

test("transitionRun: a stale lease fence token loses, the correct token wins", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putApplyRun({ ...makeApplyRun("run_t_c", "run_plan_c"), status: "queued" });

    // Claim it and stamp a fence token.
    const claim = await store.transitionRun({
      id: "run_t_c",
      kind: "apply",
      expectFrom: ["queued"],
      run: { ...makeApplyRun("run_t_c", "run_plan_c"), status: "running" },
      setLeaseToken: "lease_real",
      heartbeatAt: 1,
    });
    expect(claim.won, label).toBe(true);

    // A heartbeat/transition with a STALE fence token must lose.
    const stale = await store.transitionRun({
      id: "run_t_c",
      kind: "apply",
      expectFrom: ["running"],
      expectLeaseToken: "lease_stale",
      run: { ...makeApplyRun("run_t_c", "run_plan_c"), status: "failed" },
    });
    expect(stale.won, label).toBe(false);
    expect(stale.run?.status, label).toBe("running");

    // The CORRECT fence token wins.
    const fresh = await store.transitionRun({
      id: "run_t_c",
      kind: "apply",
      expectFrom: ["running"],
      expectLeaseToken: "lease_real",
      run: { ...makeApplyRun("run_t_c", "run_plan_c"), status: "succeeded" },
      clearLeaseToken: true,
    });
    expect(fresh.won, label).toBe(true);
    expect(fresh.run?.status, label).toBe("succeeded");
    expect((await store.getApplyRun("run_t_c"))?.status, label).toBe("succeeded");
  }
});

test("transitionRun: two concurrent queued→running claims, exactly one wins", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putPlanRun({ ...makePlanRun("run_t_d"), status: "queued" });

    const [a, b] = await Promise.all([
      store.transitionRun({
        id: "run_t_d",
        kind: "plan",
        expectFrom: ["queued"],
        run: { ...makePlanRun("run_t_d"), status: "running" },
        setLeaseToken: "lease_a",
      }),
      store.transitionRun({
        id: "run_t_d",
        kind: "plan",
        expectFrom: ["queued"],
        run: { ...makePlanRun("run_t_d"), status: "running" },
        setLeaseToken: "lease_b",
      }),
    ]);

    const winners = [a, b].filter((r) => r.won).length;
    expect(winners, label).toBe(1);
    // The loser re-read the now-`running` row (won:false, run.status running).
    const loser = a.won ? b : a;
    expect(loser.run?.status, label).toBe("running");
    expect((await store.getPlanRun("run_t_d"))?.status, label).toBe("running");
  }
});

test("transitionRun: a missing row loses with no run", async () => {
  for (const [label, store] of await forEachStore()) {
    const result = await store.transitionRun({
      id: "run_t_missing",
      kind: "plan",
      expectFrom: ["queued"],
      run: { ...makePlanRun("run_t_missing"), status: "running" },
    });
    expect(result.won, label).toBe(false);
    expect(result.run, label).toBeUndefined();
  }
});

test("Artifact ledger store: put/list by run keeps R2 pointer metadata ordered", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putArtifactRecord(
      artifactRecord({
        id: "artifact_b",
        runId: "run_1",
        kind: "plan_json",
        createdAt: "2026-06-06T00:00:02.000Z",
      }),
    );
    await store.putArtifactRecord(
      artifactRecord({
        id: "artifact_a",
        runId: "run_1",
        kind: "plan_bin",
        objectKey:
          "spaces/space_1/installations/inst_1/runs/run_1/plan.bin.enc",
        createdAt: "2026-06-06T00:00:01.000Z",
      }),
    );
    await store.putArtifactRecord(
      artifactRecord({ id: "artifact_other", runId: "run_2" }),
    );

    const listed = await store.listArtifactRecordsForRun("run_1");
    expect(
      listed.map((artifact) => artifact.id),
      label,
    ).toEqual(["artifact_a", "artifact_b"]);
    expect(listed[0]!.objectKey, label).toBe(
      "spaces/space_1/installations/inst_1/runs/run_1/plan.bin.enc",
    );
    expect(listed[0]!.digest, label).toBe("sha256:" + "b".repeat(64));
    expect(listed[0]!.sizeBytes, label).toBe(1024);
    expect(
      (await store.listArtifactRecordsForRun("run_2")).map(
        (artifact) => artifact.id,
      ),
      label,
    ).toEqual(["artifact_other"]);
    expect(await store.listArtifactRecordsForRun("run_missing"), label).toEqual(
      [],
    );
  }
});

test("Dependency store: CRUD + list by space / consumer / producer are symmetric", async () => {
  for (const [label, store] of await forEachStore()) {
    // Two edges in space_1 sharing a producer; one unrelated edge in space_2.
    await store.putDependency(
      dependency({
        id: "edge_a",
        producerInstallationId: "inst_p",
        consumerInstallationId: "inst_c1",
      }),
    );
    await store.putDependency(
      dependency({
        id: "edge_b",
        producerInstallationId: "inst_p",
        consumerInstallationId: "inst_c2",
        createdAt: "2026-06-07T00:00:00.000Z",
      }),
    );
    await store.putDependency(
      dependency({
        id: "edge_other",
        spaceId: "space_2",
        producerInstallationId: "inst_x",
        consumerInstallationId: "inst_y",
      }),
    );

    expect(
      (await store.getDependency("edge_a"))?.consumerInstallationId,
      label,
    ).toBe("inst_c1");
    expect(await store.getDependency("missing"), label).toBeUndefined();

    const bySpace = await store.listDependenciesBySpace("space_1");
    expect(
      bySpace.map((d) => d.id),
      label,
    ).toEqual(["edge_a", "edge_b"]);

    const byProducer = await store.listDependenciesForProducer("inst_p");
    expect(
      byProducer.map((d) => d.id),
      label,
    ).toEqual(["edge_a", "edge_b"]);

    const byConsumer = await store.listDependenciesForConsumer("inst_c2");
    expect(
      byConsumer.map((d) => d.id),
      label,
    ).toEqual(["edge_b"]);

    expect(await store.deleteDependency("edge_a"), label).toBe(true);
    expect(await store.deleteDependency("edge_a"), label).toBe(false);
    expect(
      (await store.listDependenciesBySpace("space_1")).map((d) => d.id),
      label,
    ).toEqual(["edge_b"]);
  }
});

test("DependencySnapshot store: put/get round-trips the pinned values", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putDependencySnapshot(
      dependencySnapshot({ id: "ds_a", runId: "run_p" }),
    );
    const got = await store.getDependencySnapshot("ds_a");
    expect(got?.runId, label).toBe("run_p");
    expect(got?.mode, label).toBe("strict");
    expect(got?.dependencies[0]?.values, label).toEqual({
      bucket: "my-bucket",
    });
    expect(await store.getDependencySnapshot("missing"), label).toBeUndefined();
  }
});

test("OutputSnapshot store: put/get + latest by state generation are symmetric", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putOutputSnapshot(
      outputSnapshot({ id: "out_g1", stateGeneration: 1 }),
    );
    await store.putOutputSnapshot(
      outputSnapshot({ id: "out_g3", stateGeneration: 3 }),
    );
    await store.putOutputSnapshot(
      outputSnapshot({ id: "out_g2", stateGeneration: 2 }),
    );
    // A different installation is isolated from the latest lookup.
    await store.putOutputSnapshot(
      outputSnapshot({
        id: "out_other",
        installationId: "inst_2",
        stateGeneration: 9,
      }),
    );

    expect(
      (await store.getOutputSnapshot("out_g2"))?.stateGeneration,
      label,
    ).toBe(2);
    expect(await store.getOutputSnapshot("missing"), label).toBeUndefined();

    // Latest by generation -> the gen-3 snapshot for inst_1.
    const latest = await store.getLatestOutputSnapshot("inst_1");
    expect(latest?.id, label).toBe("out_g3");
    expect(latest?.stateGeneration, label).toBe(3);
    expect((await store.getLatestOutputSnapshot("inst_2"))?.id, label).toBe(
      "out_other",
    );
    expect(
      await store.getLatestOutputSnapshot("missing"),
      label,
    ).toBeUndefined();
  }
});

test("OutputShare store: put/get + list from/to space are symmetric", async () => {
  for (const [label, store] of await forEachStore()) {
    // space_1 grants two shares to space_2; space_3 grants one to space_1.
    await store.putOutputShare(
      outputShare({
        id: "osh_a",
        fromSpaceId: "space_1",
        toSpaceId: "space_2",
      }),
    );
    await store.putOutputShare(
      outputShare({
        id: "osh_b",
        fromSpaceId: "space_1",
        toSpaceId: "space_2",
        createdAt: "2026-06-07T00:00:00.000Z",
      }),
    );
    await store.putOutputShare(
      outputShare({
        id: "osh_c",
        fromSpaceId: "space_3",
        toSpaceId: "space_1",
      }),
    );

    expect((await store.getOutputShare("osh_a"))?.toSpaceId, label).toBe(
      "space_2",
    );
    expect(await store.getOutputShare("missing"), label).toBeUndefined();
    // The OutputShareEntry round-trips alias + sensitive:false.
    expect((await store.getOutputShare("osh_a"))?.outputs, label).toEqual([
      { name: "bucket_name", alias: "bucket", sensitive: false },
    ]);

    // From space_1: the two grants it GRANTED, oldest-first.
    const fromSpace1 = await store.listOutputSharesFromSpace("space_1");
    expect(
      fromSpace1.map((s) => s.id),
      label,
    ).toEqual(["osh_a", "osh_b"]);

    // To space_1: the one grant it RECEIVED.
    const toSpace1 = await store.listOutputSharesToSpace("space_1");
    expect(
      toSpace1.map((s) => s.id),
      label,
    ).toEqual(["osh_c"]);

    // To space_2: the two grants it received.
    const toSpace2 = await store.listOutputSharesToSpace("space_2");
    expect(
      toSpace2.map((s) => s.id),
      label,
    ).toEqual(["osh_a", "osh_b"]);

    // Revoke updates the row in place (status + revokedAt).
    await store.putOutputShare(
      outputShare({
        id: "osh_a",
        fromSpaceId: "space_1",
        toSpaceId: "space_2",
        status: "revoked",
        revokedAt: "2026-06-08T00:00:00.000Z",
      }),
    );
    expect((await store.getOutputShare("osh_a"))?.status, label).toBe(
      "revoked",
    );
    expect((await store.getOutputShare("osh_a"))?.revokedAt, label).toBe(
      "2026-06-08T00:00:00.000Z",
    );
  }
});

test("RunGroup store: put/get/list-by-space round-trip", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putRunGroup(runGroup({ id: "rg_a" }));
    await store.putRunGroup(
      runGroup({ id: "rg_b", createdAt: "2026-06-07T00:00:00.000Z" }),
    );
    await store.putRunGroup(runGroup({ id: "rg_other", spaceId: "space_2" }));

    const got = await store.getRunGroup("rg_a");
    expect(got?.type, label).toBe("space_update");
    expect(JSON.parse(got!.graphJson).order, label).toEqual([["inst_1"]]);
    expect(await store.getRunGroup("missing"), label).toBeUndefined();

    const forSpace = await store.listRunGroups("space_1");
    expect(
      forSpace.map((g) => g.id),
      label,
    ).toEqual(["rg_a", "rg_b"]);
    expect(
      (await store.listRunGroups("space_2")).map((g) => g.id),
      label,
    ).toEqual(["rg_other"]);
  }
});

test("Activity store: put/list newest-first, space-scoped, limit-clamped", async () => {
  for (const [label, store] of await forEachStore()) {
    // Three events in space_1 at distinct timestamps + one in space_2.
    await store.putActivityEvent(
      activityEvent({ id: "act_a", createdAt: "2026-06-06T00:00:01.000Z" }),
    );
    await store.putActivityEvent(
      activityEvent({
        id: "act_b",
        action: "run.plan_created",
        targetType: "run",
        targetId: "plan_1",
        runId: "plan_1",
        createdAt: "2026-06-06T00:00:03.000Z",
      }),
    );
    await store.putActivityEvent(
      activityEvent({
        id: "act_c",
        action: "run.applied",
        targetType: "run",
        targetId: "apply_1",
        runId: "apply_1",
        metadata: { deploymentId: "dep_1" },
        createdAt: "2026-06-06T00:00:02.000Z",
      }),
    );
    await store.putActivityEvent(
      activityEvent({ id: "act_other", spaceId: "space_2" }),
    );

    // Newest-first within the space (act_b @ :03, act_c @ :02, act_a @ :01).
    const listed = await store.listActivityEvents("space_1");
    expect(
      listed.map((e) => e.id),
      label,
    ).toEqual(["act_b", "act_c", "act_a"]);
    // Full record (incl. metadata + optional runId) round-trips.
    expect(listed[0]!.runId, label).toBe("plan_1");
    expect(listed[1]!.metadata.deploymentId, label).toBe("dep_1");

    // Space isolation: space_2 sees only its own event.
    expect(
      (await store.listActivityEvents("space_2")).map((e) => e.id),
      label,
    ).toEqual(["act_other"]);
    // An empty Space sees nothing.
    expect(
      (await store.listActivityEvents("space_missing")).length,
      label,
    ).toBe(0);

    // Limit caps the page (newest two).
    const limited = await store.listActivityEvents("space_1", { limit: 2 });
    expect(
      limited.map((e) => e.id),
      label,
    ).toEqual(["act_b", "act_c"]);
  }
});

test("Credential mint audit store: put/list by run without values", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putCredentialMintEvent(
      credentialMintEvent({
        id: "credmint_plan",
        runId: "plan_1",
        phase: "plan",
        createdAt: "2026-06-06T00:00:01.000Z",
      }),
    );
    await store.putCredentialMintEvent(
      credentialMintEvent({
        id: "credmint_apply",
        runId: "apply_1",
        phase: "apply",
        capabilities: ["cloudflare", "aws"],
        createdAt: "2026-06-06T00:00:02.000Z",
      }),
    );

    const planEvents = await store.listCredentialMintEventsForRun("plan_1");
    expect(planEvents, label).toHaveLength(1);
    expect(planEvents[0], label).toEqual(
      credentialMintEvent({
        id: "credmint_plan",
        runId: "plan_1",
        phase: "plan",
        createdAt: "2026-06-06T00:00:01.000Z",
      }),
    );
    expect(JSON.stringify(planEvents), label).not.toContain("secret");
    expect(
      (await store.listCredentialMintEventsForRun("apply_1"))[0]!.capabilities,
      label,
    ).toEqual(["cloudflare", "aws"]);
    expect(
      await store.listCredentialMintEventsForRun("missing"),
      label,
    ).toEqual([]);
  }
});

test("SecurityFinding store: put/list newest-first, space-scoped, run-filtered", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putSecurityFinding(
      securityFinding({ id: "sec_a", createdAt: "2026-06-06T00:00:01.000Z" }),
    );
    await store.putSecurityFinding(
      securityFinding({
        id: "sec_b",
        runId: "run_2",
        severity: "error",
        metadata: { code: "resource_denied" },
        createdAt: "2026-06-06T00:00:03.000Z",
      }),
    );
    await store.putSecurityFinding(
      securityFinding({
        id: "sec_c",
        runId: "run_1",
        createdAt: "2026-06-06T00:00:02.000Z",
      }),
    );
    await store.putSecurityFinding(
      securityFinding({ id: "sec_other", spaceId: "space_2" }),
    );

    expect(
      (await store.listSecurityFindings("space_1")).map(
        (finding) => finding.id,
      ),
      label,
    ).toEqual(["sec_b", "sec_c", "sec_a"]);
    expect(
      (await store.listSecurityFindings("space_1", { runId: "run_1" })).map(
        (finding) => finding.id,
      ),
      label,
    ).toEqual(["sec_c", "sec_a"]);
    expect(
      (await store.listSecurityFindings("space_1", { limit: 2 })).map(
        (finding) => finding.id,
      ),
      label,
    ).toEqual(["sec_b", "sec_c"]);
    expect(
      (await store.listSecurityFindings("space_2")).map(
        (finding) => finding.id,
      ),
      label,
    ).toEqual(["sec_other"]);
  }
});

test("Billing ledger store: balance, reservation, and usage round-trip", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putBillingPlan({
      id: "pro",
      name: "Pro",
      monthlyBasePrice: 2000,
      includedCredits: 100,
      limits: {
        maxEstimatedCreditsPerRun: 10,
        quota: { resources: 20 },
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(await store.getBillingPlan("pro"), label).toEqual({
      id: "pro",
      name: "Pro",
      monthlyBasePrice: 2000,
      includedCredits: 100,
      limits: {
        maxEstimatedCreditsPerRun: 10,
        quota: { resources: 20 },
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });

    await store.putBillingAccount({
      id: "bill_space_1",
      ownerType: "space",
      ownerId: "space_1",
      provider: "stripe",
      stripeCustomerId: "cus_1",
      status: "active",
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(await store.getBillingAccount("bill_space_1"), label).toMatchObject({
      id: "bill_space_1",
      ownerType: "space",
      ownerId: "space_1",
      stripeCustomerId: "cus_1",
      status: "active",
    });
    expect(
      await store.getBillingAccountForOwner("space", "space_1"),
      label,
    ).toMatchObject({
      id: "bill_space_1",
      provider: "stripe",
    });
    await store.putSpaceSubscription({
      id: "sub_1",
      spaceId: "space_1",
      billingAccountId: "bill_space_1",
      planId: "pro",
      status: "active",
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(await store.getSpaceSubscription("space_1"), label).toMatchObject({
      id: "sub_1",
      spaceId: "space_1",
      billingAccountId: "bill_space_1",
      planId: "pro",
      status: "active",
    });

    await store.putCreditBalance({
      spaceId: "space_1",
      availableCredits: 42,
      reservedCredits: 3,
      monthlyIncludedCredits: 10,
      purchasedCredits: 35,
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(await store.getCreditBalance("space_1"), label).toEqual({
      spaceId: "space_1",
      availableCredits: 42,
      reservedCredits: 3,
      monthlyIncludedCredits: 10,
      purchasedCredits: 35,
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(
      await store.reserveCredits("space_1", {
        credits: 5,
        updatedAt: "2026-06-07T00:00:00.500Z",
      }),
      label,
    ).toMatchObject({
      spaceId: "space_1",
      availableCredits: 37,
      reservedCredits: 8,
      updatedAt: "2026-06-07T00:00:00.500Z",
    });
    expect(
      await store.reserveCredits("space_1", {
        credits: 99,
        updatedAt: "2026-06-07T00:00:00.750Z",
      }),
      label,
    ).toBeUndefined();

    await store.putCreditReservation({
      id: "creditres_1",
      spaceId: "space_1",
      runId: "plan_1",
      estimatedCredits: 5,
      status: "reserved",
      mode: "enforce",
      createdAt: "2026-06-07T00:00:01.000Z",
      expiresAt: "2026-06-08T00:00:01.000Z",
    });
    await store.putCreditReservation({
      id: "creditres_2",
      spaceId: "space_1",
      runId: "plan_2",
      estimatedCredits: 8,
      status: "captured",
      mode: "showback",
      createdAt: "2026-06-07T00:00:02.000Z",
      expiresAt: "2026-06-08T00:00:02.000Z",
    });
    await store.putCreditReservation({
      id: "creditres_other",
      spaceId: "space_2",
      runId: "plan_other",
      estimatedCredits: 100,
      status: "reserved",
      mode: "enforce",
      createdAt: "2026-06-07T00:00:03.000Z",
      expiresAt: "2026-06-08T00:00:03.000Z",
    });
    expect(await store.getCreditReservationForRun("plan_1"), label).toEqual({
      id: "creditres_1",
      spaceId: "space_1",
      runId: "plan_1",
      estimatedCredits: 5,
      status: "reserved",
      mode: "enforce",
      createdAt: "2026-06-07T00:00:01.000Z",
      expiresAt: "2026-06-08T00:00:01.000Z",
    });
    expect(
      (await store.listCreditReservations("space_1")).map((r) => r.id),
      label,
    ).toEqual(["creditres_2", "creditres_1"]);
    expect(
      (await store.listCreditReservations("space_1", { limit: 1 })).map(
        (r) => r.id,
      ),
      label,
    ).toEqual(["creditres_2"]);

    await store.putUsageEvent({
      id: "usage_1",
      spaceId: "space_1",
      installationId: "inst_1",
      runId: "apply_1",
      kind: "operation",
      quantity: 1,
      credits: 5,
      source: "runner",
      idempotencyKey: "apply_1:operation",
      createdAt: "2026-06-07T00:00:02.000Z",
    });
    await store.putUsageEvent({
      id: "usage_duplicate",
      spaceId: "space_1",
      runId: "apply_1",
      kind: "operation",
      quantity: 1,
      credits: 999,
      source: "runner",
      idempotencyKey: "apply_1:operation",
      createdAt: "2026-06-07T00:00:03.000Z",
    });
    expect(await store.listUsageEvents("space_1"), label).toEqual([
      {
        id: "usage_1",
        spaceId: "space_1",
        installationId: "inst_1",
        runId: "apply_1",
        kind: "operation",
        quantity: 1,
        credits: 5,
        source: "runner",
        idempotencyKey: "apply_1:operation",
        createdAt: "2026-06-07T00:00:02.000Z",
      },
    ]);
  }
});

test("Backup store: put/list newest-first, space-scoped, round-trips", async () => {
  for (const [label, store] of await forEachStore()) {
    await store.putBackupRecord(
      backupRecord({ id: "bkp_a", createdAt: "2026-06-06T00:00:01.000Z" }),
    );
    await store.putBackupRecord(
      backupRecord({
        id: "bkp_b",
        sizeBytes: 4096,
        createdByRunId: "apply_1",
        createdAt: "2026-06-06T00:00:03.000Z",
      }),
    );
    await store.putBackupRecord(
      backupRecord({ id: "bkp_other", spaceId: "space_2" }),
    );

    // Newest-first within the space (bkp_b @ :03, bkp_a @ :01).
    const listed = await store.listBackupRecords("space_1");
    expect(
      listed.map((b) => b.id),
      label,
    ).toEqual(["bkp_b", "bkp_a"]);
    // Full pointer (incl. optional createdByRunId + sizeBytes) round-trips.
    expect(listed[0]!.createdByRunId, label).toBe("apply_1");
    expect(listed[0]!.sizeBytes, label).toBe(4096);
    expect(listed[0]!.objectKey, label).toBe(
      "spaces/space_1/backups/bkp_1/control.json.zst.enc",
    );
    expect(listed[1]!.createdByRunId, label).toBeUndefined();

    // Space isolation: space_2 sees only its own pointer.
    expect(
      (await store.listBackupRecords("space_2")).map((b) => b.id),
      label,
    ).toEqual(["bkp_other"]);
    // An empty Space sees nothing.
    expect((await store.listBackupRecords("space_missing")).length, label).toBe(
      0,
    );
  }
});

// --- internal run-record fixtures (epoch-number timestamps) -----------------

function makePlanRun(
  id: string,
  over: { readonly runGroupId?: string; readonly driftCheck?: boolean } = {},
) {
  return {
    id,
    spaceId: "space_1",
    installationId: "inst_1",
    ...(over.runGroupId ? { runGroupId: over.runGroupId } : {}),
    ...(over.driftCheck ? { driftCheck: true } : {}),
    source: { kind: "git" as const, url: "https://example.com/repo.git" },
    sourceDigest: "sha256:src",
    operation: "apply" as const,
    runnerProfileId: "rp_1",
    variablesDigest: "sha256:vars",
    requiredProviders: ["cloudflare"],
    status: "queued" as const,
    policy: { status: "passed" as const, reasons: [], checkedAt: 0 },
    policyDecisionDigest: "sha256:pol",
    auditEvents: [],
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function makeApplyRun(id: string, planRunId: string) {
  return {
    id,
    planRunId,
    spaceId: "space_1",
    installationId: "inst_1",
    operation: "apply" as const,
    runnerProfileId: "rp_1",
    status: "queued" as const,
    expected: {
      planRunId,
      runnerProfileId: "rp_1",
      sourceDigest: "sha256:src",
      variablesDigest: "sha256:vars",
      policyDecisionDigest: "sha256:pol",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:art",
    },
    stateBackend: { kind: "encrypted-r2" as const },
    stateLock: { status: "not_required" as const, backendRef: "ref" },
    auditEvents: [],
    createdAt: 2_000,
    updatedAt: 2_000,
  };
}
