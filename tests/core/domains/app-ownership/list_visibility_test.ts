import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { BackupRecord } from "takosumi-contract/backups";
import type { UsageEvent } from "takosumi-contract/billing";
import type { Capsule } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import type { SqlClient, SqlParameters } from "../../../../core/adapters/storage/sql.ts";
import { APP_LIST_SCHEMA_ABSENT_TTL_MS, type AppListViewer } from "../../../../core/domains/app-ownership/list-visibility.ts";
import {
  D1AppOwnershipStore, InMemoryAppOwnershipStore, SqlAppOwnershipStore, isMissingOwnershipSchemaError, type AppOwnershipStore,
} from "../../../../core/domains/app-ownership/store.ts";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../../worker/src/d1_schema_maintenance.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const WS = "ws_list";
const NOW = "2026-10-29T00:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const HIDDEN_RUNS = 120;

const clients: PGliteSqlClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

interface Backend { readonly name: string; readonly control: OpenTofuControlStore; readonly ownership?: AppOwnershipStore }

async function backends(): Promise<readonly Backend[]> {
  const memory = new InMemoryOpenTofuControlStore();
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const postgres = new SqlOpenTofuControlStore({ client: pg });
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const d1 = new CloudflareD1OpenTofuControlStore(db);
  return [
    { name: "memory", control: memory, ownership: new InMemoryAppOwnershipStore(memory) },
    { name: "postgres", control: postgres, ownership: new SqlAppOwnershipStore(pg, postgres) },
    { name: "d1", control: d1, ownership: new D1AppOwnershipStore(db, d1) },
  ];
}

function capsule(id: string, sourceId: string, status: Capsule["status"], index: number): Capsule {
  return { id, workspaceId: WS, projectId: "prj_list", name: id.replaceAll("_", "-"), slug: id.replaceAll("_", "-"),
    sourceId, installConfigId: `cfg_${id}`, environment: "production", currentStateGeneration: 0, status,
    createdAt: at(index), updatedAt: at(index) };
}

function backupRun(id: string, seconds: number, fields: Partial<Run> & Record<string, unknown> = {}): Run {
  return { id, workspaceId: WS, type: "backup", status: "succeeded", createdBy: "fixture",
    createdAt: at(seconds), updatedAt: at(seconds), ...fields } as unknown as Run;
}

function backupRecord(id: string, seconds: number, capsuleId?: string): BackupRecord {
  return { id, workspaceId: WS, ...(capsuleId ? { capsuleId } : {}), ref: `opaque-${id}`,
    digest: `sha256:${"b".repeat(64)}`, sizeBytes: 1, createdAt: at(seconds) };
}

function usage(id: string, seconds: number, fields: { capsuleId?: string; runId?: string } = {}): UsageEvent {
  return { id, workspaceId: WS, ...fields, kind: "operation", quantity: 1, usdMicros: 0, ratingStatus: "unrated",
    source: "runner", idempotencyKey: `${id}:operation`, createdAt: at(seconds) };
}

/**
 * Hidden rows come first in every list order. `viewer` is a member of
 * cap_visible and the retained owner of the uninstalled cap_gone; owner_a owns
 * cap_hidden and cap_legacy (built from the ownerless src_legacy).
 */
async function seed(control: OpenTofuControlStore, ownership: AppOwnershipStore | undefined): Promise<void> {
  await control.putWorkspace({ id: WS, handle: "list", displayName: "List", type: "organization",
    ownerUserId: "ws_owner", createdAt: NOW, updatedAt: NOW });
  const capsules: readonly [string, string, Capsule["status"]][] = [
    ["cap_hidden", "src_hidden", "active"], ["cap_legacy", "src_legacy", "active"],
    ["cap_visible", "src_visible", "active"], ["cap_unowned", "src_unowned", "active"],
    ["cap_gone", "src_gone", "destroyed"],
  ];
  for (const [index, [id, sourceId, status]] of capsules.entries()) await control.putCapsule(capsule(id, sourceId, status, index));
  const sources: readonly [string, string | undefined][] = [
    ["src_hidden", "cap_hidden"], ["src_legacy", undefined], ["src_visible", "cap_visible"],
    ["src_unowned", undefined], ["src_orphan", undefined], ["src_gone", "cap_gone"],
  ];
  for (const [index, [id, ownerCapsuleId]] of sources.entries()) {
    await control.putSource({ id, workspaceId: WS, ...(ownerCapsuleId ? { ownerCapsuleId } : {}), name: id,
      url: `https://example.com/${id}.git`, defaultRef: "main", defaultPath: ".", status: "active", autoSync: false,
      hookSecretHash: "fixture-hash", createdAt: at(index), updatedAt: at(index) });
  }
  if (ownership) {
    for (const [capsuleId, ownerAccountId] of [
      ["cap_hidden", "owner_a"], ["cap_legacy", "owner_a"], ["cap_visible", "owner_b"], ["cap_gone", "viewer"],
    ] as const) {
      expect(await ownership.initializeOwnershipIfMissing({ capsuleId, ownerAccountId, ownershipEpoch: 0,
        managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsuleId}` })).toBe(true);
    }
    expect(await ownership.putMember({ capsuleId: "cap_visible", accountId: "viewer", status: "active",
      addedBy: "owner_b", createdAt: NOW, updatedAt: NOW })).toBe(true);
    // An invitation is not membership.
    expect(await ownership.putMember({ capsuleId: "cap_hidden", accountId: "viewer", status: "invited",
      addedBy: "owner_a", createdAt: NOW, updatedAt: NOW })).toBe(true);
  }
  for (let index = 0; index < HIDDEN_RUNS; index++) {
    await control.putBackupRun(backupRun(`run_h_${String(index).padStart(3, "0")}`, 1000 + index, { capsuleId: "cap_hidden" }));
  }
  for (const run of [
    backupRun("run_subject", 900, { subject: { kind: "capsule", id: "cap_hidden" } }),
    // An older apply row without its own Capsule belongs to its plan's.
    backupRun("run_apply", 899, { planRunId: "run_h_000" }),
    backupRun("run_src_hidden", 898, { sourceId: "src_hidden" }),
    backupRun("run_src_legacy", 897, { sourceId: "src_legacy" }),
    backupRun("run_visible", 10, { capsuleId: "cap_visible" }),
    backupRun("run_unowned", 9, { capsuleId: "cap_unowned" }),
    backupRun("run_src_orphan", 8, { sourceId: "src_orphan" }),
    backupRun("run_src_missing", 7, { sourceId: "src_missing" }),
    backupRun("run_none", 6),
    backupRun("run_gone", 5, { capsuleId: "cap_gone" }),
    backupRun("run_src_gone", 4, { sourceId: "src_gone" }),
    backupRun("run_src_visible", 3, { sourceId: "src_visible" }),
  ]) await control.putBackupRun(run);
  for (const record of [
    backupRecord("bk_hidden", 500, "cap_hidden"), backupRecord("bk_wide", 400),
    backupRecord("bk_visible", 30, "cap_visible"), backupRecord("bk_unowned", 20, "cap_unowned"),
  ]) await control.putBackupRecord(record);
  for (const event of [
    usage("u_cap_hidden", 700, { capsuleId: "cap_hidden" }), usage("u_run_hidden", 600, { runId: "run_h_001" }),
    usage("u_run_missing", 550, { runId: "run_missing" }), usage("u_cap_visible", 60, { capsuleId: "cap_visible" }),
    usage("u_run_visible", 50, { runId: "run_visible" }), usage("u_none", 40),
  ]) await control.putUsageEvent(event);
}

const VISIBLE_RUNS = ["run_visible", "run_unowned", "run_src_orphan", "run_src_missing", "run_none", "run_gone", "run_src_gone", "run_src_visible"];

async function allRuns(control: OpenTofuControlStore, viewer?: AppListViewer, limit = 2): Promise<readonly string[]> {
  const ids: string[] = [];
  let after: { createdAtMillis: number; id: string } | undefined;
  for (let page = 0; page < 200; page++) {
    const result = await control.listRunsByWorkspacePage(WS, { limit, ...(after ? { after } : {}) }, viewer);
    ids.push(...result.rows.map((row) => row.id));
    if (!result.hasMore) break;
    // A full page before the end: the next one continues after a visible row.
    expect(result.rows).toHaveLength(limit);
    const last = result.rows.at(-1)! as unknown as Run;
    after = { createdAtMillis: Date.parse(last.createdAt), id: last.id };
  }
  return ids;
}

async function allPages<T extends { readonly id: string }>(
  read: (cursor: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
  hidden: readonly string[],
): Promise<readonly string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await read(cursor);
    ids.push(...result.items.map((item) => item.id));
    cursor = result.nextCursor;
    if (!cursor) break;
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    for (const id of hidden) expect(decoded).not.toContain(id);
  }
  return ids;
}

async function lists(control: OpenTofuControlStore, viewer?: AppListViewer) {
  const hidden = ["cap_hidden", "cap_legacy", "src_hidden", "src_legacy", "bk_hidden", "bk_wide", "u_cap_hidden", "u_run_hidden", "u_run_missing"];
  return {
    capsules: await allPages((cursor) => control.listCapsulesPage(WS, { limit: 1, ...(cursor ? { cursor } : {}) }, viewer), hidden),
    liveCapsules: await allPages((cursor) => control.listCapsulesPage(WS, { limit: 1, includeDestroyed: false, ...(cursor ? { cursor } : {}) }, viewer), hidden),
    sources: await allPages((cursor) => control.listSourcesPage(WS, { limit: 1, ...(cursor ? { cursor } : {}) }, viewer), hidden),
    backups: await allPages((cursor) => control.listBackupRecordsPage(WS, { limit: 1, ...(cursor ? { cursor } : {}) }, viewer), hidden),
    usage: await allPages((cursor) => control.listUsageEventsPage(WS, { limit: 1, ...(cursor ? { cursor } : {}) }, viewer), hidden),
  };
}

test("Workspace lists filter app visibility in the store query on memory, Postgres and D1", async () => {
  for (const { name, control, ownership } of await backends()) {
    await seed(control, ownership);
    const viewer: AppListViewer = { accountId: "viewer" };
    // 120+ hidden Runs come first; every page still fills with visible Runs.
    expect(await allRuns(control, viewer), name).toEqual(VISIBLE_RUNS);
    expect(await lists(control, viewer), name).toEqual({
      capsules: ["cap_visible", "cap_unowned", "cap_gone"],
      liveCapsules: ["cap_visible", "cap_unowned"],
      sources: ["src_visible", "src_unowned", "src_orphan", "src_gone"],
      backups: ["bk_visible", "bk_unowned"],
      usage: ["u_cap_visible", "u_run_visible", "u_none"],
    });
    // A credential limited to appIds hides every other owned app, including
    // the uninstalled app the viewer still owns.
    const limited: AppListViewer = { accountId: "viewer", appIds: ["cap_visible"] };
    expect(await allRuns(control, limited), name).toEqual(VISIBLE_RUNS.filter((id) => id !== "run_gone" && id !== "run_src_gone"));
    expect((await lists(control, limited)).capsules, name).toEqual(["cap_visible", "cap_unowned"]);
    expect((await lists(control, limited)).sources, name).toEqual(["src_visible", "src_unowned", "src_orphan"]);
    // Without any app role only rows of no owned app remain.
    const stranger: AppListViewer = { accountId: "stranger" };
    expect(await allRuns(control, stranger), name).toEqual(["run_unowned", "run_src_orphan", "run_src_missing", "run_none"]);
    expect(await lists(control, stranger), name).toEqual({
      capsules: ["cap_unowned"], liveCapsules: ["cap_unowned"], sources: ["src_unowned", "src_orphan"],
      backups: ["bk_unowned"], usage: ["u_none"],
    });
    // The owner of the hidden apps sees them, and not the app it has no role in.
    const ownerRuns = await allRuns(control, { accountId: "owner_a" }, 50);
    expect(ownerRuns, name).toHaveLength(HIDDEN_RUNS + 4 + 4);
    expect(ownerRuns, name).not.toContain("run_visible");
    expect(ownerRuns, name).not.toContain("run_gone");
    // The batch read behind Activity and the other unpaged lists applies the same rule.
    const ids = ["cap_hidden", "cap_legacy", "cap_visible", "cap_unowned", "cap_gone", "cap_missing"];
    expect([...await ownership!.listHiddenCapsuleIds!(viewer, ids)].sort(), name).toEqual(["cap_hidden", "cap_legacy"]);
    expect([...await ownership!.listHiddenCapsuleIds!(limited, ids)].sort(), name).toEqual(["cap_gone", "cap_hidden", "cap_legacy"]);
    expect([...await ownership!.listHiddenCapsuleIds!(stranger, ids)].sort(), name)
      .toEqual(["cap_gone", "cap_hidden", "cap_legacy", "cap_visible"]);
    // No viewer: the unfiltered list (the route's Workspace decision applies).
    expect(await allRuns(control, undefined, 100), name).toHaveLength(HIDDEN_RUNS + 4 + VISIBLE_RUNS.length);
    expect((await control.listBackupRecordsPage(WS, { limit: 100 })).items.map((row) => row.id), name)
      .toEqual(["bk_hidden", "bk_wide", "bk_visible", "bk_unowned"]);
  }
}, 180_000);

test("a Workspace without ownership rows is unfiltered for every viewer", async () => {
  for (const { name, control } of await backends()) {
    await seed(control, undefined);
    const viewer: AppListViewer = { accountId: "stranger", appIds: [] };
    expect(await allRuns(control, viewer, 100), name).toHaveLength(HIDDEN_RUNS + 4 + VISIBLE_RUNS.length);
    expect((await control.listCapsulesPage(WS, { limit: 100 }, viewer)).items, name).toHaveLength(5);
    expect((await control.listSourcesPage(WS, { limit: 100 }, viewer)).items, name).toHaveLength(6);
    expect((await control.listUsageEventsPage(WS, { limit: 100 }, viewer)).items, name).toHaveLength(6);
    expect((await control.listBackupRecordsPage(WS, { limit: 100 }, viewer)).items, name).toHaveLength(4);
  }
}, 180_000);

/** A predeployed D1 at v75 (before the v77 ownership columns). */
async function v75D1(): Promise<SqliteFakeD1> {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
  const fence = await acquireControlD1MaintenanceFence(db, {
    sourceCommit: "a".repeat(40), manifestDigest: `sha256:${"b".repeat(64)}`,
    environment: "test", databaseRole: "in_place", releasePolicy: "in_place",
  }, NOW);
  await releaseControlD1MaintenanceFence(db, fence, "2026-10-29T00:00:01.000Z");
  return db;
}

/** Counts `pragma table_info(capsules)` statements, the v77 probe. */
function countCapsuleProbes(db: SqliteFakeD1): { readonly count: () => number } {
  let probes = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (query: string) => {
    if (/pragma table_info\(capsules\)/iu.test(query)) probes++;
    return prepare(query);
  };
  return { count: () => probes };
}

test("pre-ownership schemas (D1 v75, Postgres v122) list without the predicate", async () => {
  const db = await v75D1();
  const d1 = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  const viewer: AppListViewer = { accountId: "stranger", appIds: [] };
  await d1.putWorkspace({ id: WS, handle: "list", displayName: "List", type: "organization",
    ownerUserId: "ws_owner", createdAt: NOW, updatedAt: NOW });
  await d1.putCapsule(capsule("cap_a", "src_a", "active", 0));
  await d1.putBackupRun(backupRun("run_a", 1, { capsuleId: "cap_a" }));
  await d1.putBackupRecord(backupRecord("bk_a", 1, "cap_a"));
  expect((await d1.listCapsulesPage(WS, { limit: 10 }, viewer)).items.map((row) => row.id)).toEqual(["cap_a"]);
  expect((await d1.listRunsByWorkspacePage(WS, { limit: 10 }, viewer)).rows.map((row) => row.id)).toEqual(["run_a"]);
  expect((await d1.listBackupRecordsPage(WS, { limit: 10 }, viewer)).items.map((row) => row.id)).toEqual(["bk_a"]);
  expect((await d1.listSourcesPage(WS, { limit: 10 }, viewer)).items).toEqual([]);

  const pg = await PGliteSqlClient.createThroughMigrationVersion(122);
  clients.push(pg);
  // The pre-v123 table has no ownership columns: the predicate's query fails
  // with a missing-column error and the list is read again without it.
  await pg.query(`insert into takosumi_backups (id, space_id, installation_id, backup_json, created_at)
    values ('bk_a', '${WS}', 'cap_a', $1::json, '${NOW}')`, [JSON.stringify(backupRecord("bk_a", 0, "cap_a"))]);
  const postgres = new SqlOpenTofuControlStore({ client: pg });
  expect((await postgres.listBackupRecordsPage(WS, { limit: 10 }, viewer)).items.map((row) => row.id)).toEqual(["bk_a"]);
  expect((await postgres.listCapsulesPage(WS, { limit: 10 }, viewer)).items).toEqual([]);
  expect((await postgres.listRunsByWorkspacePage(WS, { limit: 10 }, viewer)).rows).toEqual([]);
}, 180_000);

test("D1 v75 list requests probe the ownership schema once per TTL; writes keep probing", async () => {
  const db = await v75D1();
  const probes = countCapsuleProbes(db);
  const d1 = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  const viewer: AppListViewer = { accountId: "stranger" };
  await d1.putWorkspace({ id: WS, handle: "list", displayName: "List", type: "organization",
    ownerUserId: "ws_owner", createdAt: NOW, updatedAt: NOW });
  await d1.putCapsule(capsule("cap_a", "src_a", "active", 0));
  try {
    const before = probes.count();
    // Consecutive list requests (one store per isolate) share one probe.
    expect((await d1.listCapsulesPage(WS, { limit: 10 }, viewer)).items.map((row) => row.id)).toEqual(["cap_a"]);
    expect((await d1.listCapsulesPage(WS, { limit: 10 }, viewer)).items.map((row) => row.id)).toEqual(["cap_a"]);
    await d1.listRunsByWorkspacePage(WS, { limit: 10 }, viewer);
    await d1.listSourcesPage(WS, { limit: 10 }, viewer);
    await d1.listBackupRecordsPage(WS, { limit: 10 }, viewer);
    await d1.listUsageEventsPage(WS, { limit: 10 }, viewer);
    expect(probes.count() - before).toBe(1);
    // A write still probes: it must see the v77 columns as soon as they exist.
    await d1.putCapsule(capsule("cap_b", "src_a", "active", 1));
    expect(probes.count() - before).toBeGreaterThan(1);
    // After the TTL a list request probes again (the additive migration is seen).
    const afterWrite = probes.count();
    setSystemTime(new Date(Date.now() + APP_LIST_SCHEMA_ABSENT_TTL_MS + 1));
    await d1.listCapsulesPage(WS, { limit: 10 }, viewer);
    await d1.listCapsulesPage(WS, { limit: 10 }, viewer);
    expect(probes.count() - afterWrite).toBe(1);
  } finally {
    setSystemTime();
  }

  // A current schema caches the present column: no probe after the first.
  const current = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(current);
  const currentProbes = countCapsuleProbes(current);
  const store = new CloudflareD1OpenTofuControlStore(current);
  await store.listCapsulesPage(WS, { limit: 10 }, viewer);
  await store.listCapsulesPage(WS, { limit: 10 }, viewer);
  await store.listRunsByWorkspacePage(WS, { limit: 10 }, viewer);
  expect(currentProbes.count()).toBe(1);
}, 180_000);

test("Postgres v122 list requests attempt the filtered read once per TTL", async () => {
  const pg = await PGliteSqlClient.createThroughMigrationVersion(122);
  clients.push(pg);
  let missingSchemaReads = 0;
  const counted: SqlClient = {
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: SqlParameters) {
      try {
        return await pg.query<Row>(sql, parameters);
      } catch (error) {
        if (isMissingOwnershipSchemaError(error)) missingSchemaReads++;
        throw error;
      }
    },
    transaction: (fn) => pg.transaction(fn),
  };
  await pg.query(`insert into takosumi_backups (id, space_id, installation_id, backup_json, created_at)
    values ('bk_a', '${WS}', 'cap_a', $1::json, '${NOW}')`, [JSON.stringify(backupRecord("bk_a", 0, "cap_a"))]);
  const postgres = new SqlOpenTofuControlStore({ client: counted });
  const viewer: AppListViewer = { accountId: "stranger" };
  try {
    expect((await postgres.listBackupRecordsPage(WS, { limit: 10 }, viewer)).items.map((row) => row.id)).toEqual(["bk_a"]);
    expect((await postgres.listBackupRecordsPage(WS, { limit: 10 }, viewer)).items.map((row) => row.id)).toEqual(["bk_a"]);
    await postgres.listCapsulesPage(WS, { limit: 10 }, viewer);
    await postgres.listRunsByWorkspacePage(WS, { limit: 10 }, viewer);
    await postgres.listSourcesPage(WS, { limit: 10 }, viewer);
    expect(missingSchemaReads).toBe(1);
    setSystemTime(new Date(Date.now() + APP_LIST_SCHEMA_ABSENT_TTL_MS + 1));
    expect((await postgres.listBackupRecordsPage(WS, { limit: 10 }, viewer)).items.map((row) => row.id)).toEqual(["bk_a"]);
    await postgres.listCapsulesPage(WS, { limit: 10 }, viewer);
    expect(missingSchemaReads).toBe(2);
  } finally {
    setSystemTime();
  }
}, 180_000);
