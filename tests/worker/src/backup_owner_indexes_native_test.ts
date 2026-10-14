import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { chmod } from "node:fs/promises";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema, verifyD1BackupOwnerIndexesPredeployed, verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence, wrapControlD1MaintenanceMigrationBatch } from "../../../worker/src/d1_schema_maintenance.ts";
import type { D1Database, D1PreparedStatement, R2Bucket } from "../../../worker/src/bindings.ts";
import { createBackupStoredOwnerContext } from "../../../worker/src/stored-service-owner-context.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import type { Run } from "takosumi-contract/runs";
import { stableStringify } from "../../../core/adapters/source/digest.ts";
import { storedDigest, type StoredServiceComposition } from "../../../worker/src/stored-service-usage.ts";

const NOW = "2026-10-14T00:00:00.000Z";
const PHYSICAL = "backups_created_by_run_id_idx", LEGACY = "backups_legacy_created_by_run_text_idx";
const EXPR = "cast((case when json_valid(record_json) = 1 then json_extract(record_json, '$.createdByRunId') else null end) as text)";
const ORIGINAL = `select r.id, r.space_id, r.source_id, r.installation_id, r.environment,
 r.type, r.status, r.lease_token, r.created_at, r.run_json,
 exists(select 1 from backups b where b.id = ? or b.created_by_run_id = r.id
 or case when json_valid(b.record_json) then json_extract(b.record_json, '$.createdByRunId') = r.id else 0 end) as has_record
 from runs r where r.id = ? limit 2`;
type Native = Awaited<ReturnType<Miniflare["getD1Database"]>>;
interface Captured { readonly sql: string; readonly params: readonly unknown[]; readonly rows: readonly Record<string, unknown>[]; readonly rowsRead: number | undefined }
function bridge(native: Native, captures: Captured[], afterShape?: () => Promise<void>): D1Database {
  const actual = new WeakMap<D1PreparedStatement, ReturnType<Native["prepare"]>>();
  const statement = (sql: string, params: readonly unknown[] = []): D1PreparedStatement => {
    const underlying = native.prepare(sql).bind(...params);
    const wrapped: D1PreparedStatement & Pick<typeof underlying, "raw"> = {
      bind: (...values) => statement(sql, values),
      async first<T>() { const result = await underlying.first<T>(); if (sql.includes("as indexes_json")) await afterShape?.(); return result; },
      async all<T>() {
        const result = await underlying.all<T>();
        if (sql.includes("indexed by backups_created_by_run_id_idx")) captures.push({ sql, params, rows: result.results as Record<string, unknown>[], rowsRead: result.meta.rows_read });
        return result;
      },
      run: <T>() => underlying.run<T>(),
      raw: (...args) => underlying.raw(...args),
    };
    actual.set(wrapped, underlying); return wrapped;
  };
  return { prepare: sql => statement(sql), async batch<T>(statements) { return await native.batch<T>(statements.map(statement => actual.get(statement)!)); } };
}
async function fixture(head = 74) {
  const runtime = new Miniflare({ host: "127.0.0.1", port: 0, compatibilityDate: "2026-06-01", modules: [{ type: "ESModule", path: "backup-index-native.mjs", contents: "export default {fetch(){return new Response('isolated native D1/R2')}}" }], d1Databases: { DB: "backup-index-native" }, r2Buckets: ["BACKUPS"] });
  try {
    const native = await runtime.getD1Database("DB"), captures: Captured[] = [];
    const db = bridge(native, captures);
    await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: head });
    const fence = await acquireControlD1MaintenanceFence(db, { sourceCommit: "a".repeat(40), manifestDigest: "sha256:" + "b".repeat(64), environment: "backup-index-native-test", databaseRole: "in_place", releasePolicy: "in_place" }, NOW);
    await releaseControlD1MaintenanceFence(db, fence, "2026-10-14T00:01:00.000Z");
    return { runtime, native, db, captures, fence, store: new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" }), async close() { await runtime.dispose(); } };
  } catch (error) { await runtime.dispose(); throw error; }
}
async function inventory(db: Native) {
  const objects = (await db.prepare("select type,name,tbl_name,sql from sqlite_master where name not in (?,?) order by type,name").bind(PHYSICAL, LEGACY).all<Record<string, unknown>>()).results;
  const names = objects.filter(row => row.type === "table").map(row => String(row.name));
  const protectedTables = names.filter(name => name === "_cf_METADATA");
  const protectedReadRefusals: Record<string, string> = {};
  for (const name of protectedTables) {
    try { await db.prepare(`select * from "${name}"`).all(); }
    catch (error) { protectedReadRefusals[name] = String(error); }
    expect(protectedReadRefusals[name]).toContain("SQLITE_AUTH");
  }
  const rows: Record<string, unknown> = {}, counts: Record<string, number> = {};
  for (const name of names.filter(name => !protectedTables.includes(name))) {
    rows[name] = (await db.prepare(`select * from "${name.replaceAll('"', '""')}" ${name === "schema_migrations" ? "where version <= 73" : ""} order by rowid`).all()).results;
    counts[name] = (rows[name] as unknown[]).length;
  }
  return { schema: await storedDigest(stableStringify(objects)), data: await storedDigest(stableStringify(rows)), runs: await storedDigest(stableStringify(rows.runs)), counts, protectedTables, protectedReadRefusals };
}
interface Probe {
  readonly name: string;
  readonly run: string;
  readonly json?: string | Uint8Array;
  readonly physical?: "same" | "other";
  readonly exactId?: boolean;
  readonly foreignWorkspace?: boolean;
  readonly expected: 0 | 1;
}
const probes: readonly Probe[] = [
  { name: "unrelated-only", run: "backup_original", expected: 0 },
  { name: "exact-id-no-owner", run: "backup_original", json: "{}", exactId: true, expected: 1 },
  { name: "other-id-physical-owner", run: "backup_original", physical: "same", json: "{}", expected: 1 },
  { name: "legacy-json-only", run: "backup_original", json: '{"createdByRunId":"backup_original"}', expected: 1 },
  { name: "physical-original-json-other", run: "backup_original", physical: "same", json: '{"createdByRunId":"backup_other"}', expected: 1 },
  { name: "physical-other-json-original", run: "backup_original", physical: "other", json: '{"createdByRunId":"backup_original"}', expected: 1 },
  { name: "malformed-json-physical-original", run: "backup_original", physical: "same", json: "not-json", expected: 1 },
  { name: "malformed-json-unowned", run: "backup_original", json: "not-json", expected: 0 },
  { name: "cross-workspace-physical", run: "backup_original", physical: "same", json: "{}", foreignWorkspace: true, expected: 1 },
  { name: "cross-workspace-json", run: "backup_original", physical: "other", json: '{"createdByRunId":"backup_original"}', foreignWorkspace: true, expected: 1 },
  { name: "foreign-owners", run: "backup_original", physical: "other", json: '{"createdByRunId":"backup_other"}', expected: 0 },
  { name: "null", run: "backup_original", json: '{"createdByRunId":null}', expected: 0 },
  { name: "missing", run: "backup_original", json: "{}", expected: 0 },
  { name: "object", run: "3", json: '{"createdByRunId":{"id":"3"}}', expected: 0 },
  { name: "array", run: "3", json: '{"createdByRunId":["3"]}', expected: 0 },
  { name: "numeric-integer", run: "3", json: '{"createdByRunId":3}', expected: 1 },
  { name: "numeric-real", run: "3.0", json: '{"createdByRunId":3.0}', expected: 1 },
  { name: "real-versus-integer-text", run: "3", json: '{"createdByRunId":3.0}', expected: 0 },
  { name: "integer-versus-real-text", run: "3.0", json: '{"createdByRunId":3}', expected: 0 },
  { name: "numeric-string", run: "3", json: '{"createdByRunId":"3"}', expected: 1 },
  { name: "real-string", run: "3.0", json: '{"createdByRunId":"3.0"}', expected: 1 },
  { name: "leading-zero-numeric", run: "03", json: '{"createdByRunId":3}', expected: 0 },
  { name: "leading-zero-string", run: "03", json: '{"createdByRunId":"03"}', expected: 1 },
  { name: "true-to-one", run: "1", json: '{"createdByRunId":true}', expected: 1 },
  { name: "false-to-zero", run: "0", json: '{"createdByRunId":false}', expected: 1 },
  { name: "true-not-text-true", run: "true", json: '{"createdByRunId":true}', expected: 0 },
  { name: "exponent-real", run: "1000.0", json: '{"createdByRunId":1e3}', expected: 1 },
  { name: "exponent-not-integer-text", run: "1000", json: '{"createdByRunId":1e3}', expected: 0 },
  { name: "integer-over-js-safe-range", run: "9007199254740993", json: '{"createdByRunId":9007199254740993}', expected: 1 },
  { name: "integer-int64-max", run: "9223372036854775807", json: '{"createdByRunId":9223372036854775807}', expected: 1 },
  { name: "negative-real", run: "-3.5", json: '{"createdByRunId":-3.5}', expected: 1 },
  { name: "negative-zero-real", run: "0.0", json: '{"createdByRunId":-0.0}', expected: 1 },
  { name: "negative-zero-integer", run: "0", json: '{"createdByRunId":-0}', expected: 1 },
  { name: "case-sensitive", run: "backup_original", json: '{"createdByRunId":"Backup_Original"}', expected: 0 },
  { name: "trailing-space", run: "3", json: '{"createdByRunId":"3 "}', expected: 0 },
  { name: "embedded-nul", run: "3", json: '{"createdByRunId":"3\\u0000"}', expected: 0 },
  { name: "malformed-nan", run: "3", json: '{"createdByRunId":NaN}', expected: 0 },
  { name: "json-blob-integer", run: "3", json: new TextEncoder().encode('{"createdByRunId":3}'), expected: 1 },
];


test("native actual-union74 indexed guard preserves all38 original-affinity cases, >4096 population and every original application row", async () => {
  const f = await fixture(73);
  try {
    for (const id of ["workspace_original", "workspace_foreign"]) await f.store.putWorkspace({ id, handle: id.replaceAll("_", "-"), displayName: id, type: "personal", ownerUserId: "fixture_owner", createdAt: NOW, updatedAt: NOW });
    const runs = new Map<string, Run>();
    for (const id of new Set(probes.map(probe => probe.run))) {
      const admission = await f.store.beginBackupRun({ id, workspaceId: "workspace_original", type: "backup", status: "running", createdBy: "system", createdAt: NOW, startedAt: NOW }, { workspaceId: "workspace_original", managementState: "active", managementEpoch: 1 });
      expect(admission.status).toBe("created");
      if (admission.status === "created") runs.set(id, admission.run);
    }
    // Retained identity/billing facts are deliberately nonempty, not inferred zero.
    await f.native.prepare("insert into identity_reconciliation_operations values('retained_operation','merge','immutable',1,'prepared','retained_mutation','{\"retained\":true}',?,?)").bind(NOW, NOW).run();
    await f.native.prepare("insert into identity_reconciliation_events values('retained_operation',1,'retained_mutation','{\"retained\":true}',?)").bind(NOW).run();
    await f.native.prepare("insert into workspace_billing_intents values('workspace_original','retained_intent','authority','original_ref','{\"retained\":true}',?)").bind(NOW).run();
    await f.native.prepare("insert into workspace_billing_bindings values('workspace_original','retained_intent','authority','original_ref','organization_original','{\"retained\":true}',?)").bind(NOW).run();
    for (let offset = 0; offset < 5120; offset += 10) await f.native.batch(Array.from({ length: 10 }, (_, n) => {
      const i = offset + n, id = "unrelated_backup_" + i, owner = "unrelated_run_" + i;
      return f.native.prepare("insert into backups(id,space_id,created_by_run_id,record_json,created_at) values(?,?,?,?,?)").bind(id, i % 2 ? "workspace_original" : "workspace_foreign", i % 3 ? owner : null, JSON.stringify({ id, createdByRunId: owner }), NOW);
    }));
    const originalLedger = (await f.native.prepare("select * from schema_migrations order by version").all()).results;
    const before = await inventory(f.native);
    expect(before.counts.backups).toBe(5120);
    expect(before.counts.identity_reconciliation_operations).toBe(1);
    expect(before.counts.identity_reconciliation_events).toBe(1);
    expect(before.counts.workspace_billing_bindings).toBe(1);
    expect(Object.keys(before.counts).length).toBeGreaterThanOrEqual(46);
    expect(before.protectedTables).toEqual(["_cf_METADATA"]);
    // Ordinary readiness at73 cannot satisfy the separate indexed capability.
    expect((await f.store.getWorkspace("workspace_original"))?.id).toBe("workspace_original");
    await expect(verifyD1BackupOwnerIndexesPredeployed(f.db)).rejects.toThrow();
    await ensureD1OpenTofuLedgerSchema(f.db);
    await verifyD1BackupOwnerIndexesPredeployed(f.db);
    expect(await f.native.prepare("select name from schema_migrations where version=74").first("name")).toBe("d1_backup_owner_lookup_indexes");
    const currentLedger = (await f.native.prepare("select * from schema_migrations order by version").all<{ version: number; name: string; checksum: string }>()).results;
    expect(currentLedger.slice(0, -1)).toEqual(originalLedger);
    expect(currentLedger).toHaveLength(originalLedger.length + 1);
    expect(currentLedger.at(-1)).toMatchObject({ version: 74, name: "d1_backup_owner_lookup_indexes" });
    expect(currentLedger.at(-1)!.checksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const bucket = await f.runtime.getR2Bucket("BACKUPS");
    const measurements: { name: string; originalRowsRead: number; actualRowsRead: number | undefined; conflict: unknown }[] = [];
    // A session simulator verifies routing, not replica freshness: first-primary
    // guarantees only the first query, which must be the actual authority read.
    let primarySessions = 0;
    const primaryBinding = {
      prepare: (sql: string) => f.db.prepare(sql),
      withSession(constraint: string): D1Database {
        expect(constraint).toBe("first-primary"); primarySessions++;
        let first = true;
        return { prepare(sql) {
          if (first) { expect(sql.trimStart().startsWith("select r.id, r.space_id,")).toBe(true); first = false; }
          return f.db.prepare(sql);
        } };
      },
    };
    for (const [i, probe] of probes.entries()) {
      let prepares = 0;
      const composition: StoredServiceComposition = {
        owners: { async resolveStoredObjectOwner() { throw new Error("no caller owner adoption"); } },
        usage: {
          async readStoredSource() { return { sourceRef: "source_backups", epochRef: "epoch_original", qualificationDigest: "sha256:" + "a".repeat(64) }; },
          async readStoredObject(input) { return { workspaceId: input.workspaceId, revision: 0, bytes: "0", versionDigest: null }; },
          async prepareStoredObject() { prepares++; throw new Error("isolated fixture stops after actual local authority before catalogue effects"); },
          async confirmStoredObject() { throw new Error("unexpected confirm"); }, async cancelStoredObject() { throw new Error("unexpected cancel"); },
        },
      };
      const context = createBackupStoredOwnerContext(new ObjectKeyArtifactReferenceAllocator(), composition, bucket as unknown as R2Bucket, primaryBinding);
      const backupId = "backup_case_" + i;
      const ref = await context.allocator.allocate({ kind: "backup_control", workspaceId: "workspace_original", backupId });
      const insertedId = probe.exactId ? backupId : "fixture_other_backup";
      if (probe.json !== undefined) await f.native.prepare("insert into backups(id,space_id,created_by_run_id,record_json,created_at) values(?,?,?,?,?)").bind(insertedId, probe.foreignWorkspace ? "workspace_foreign" : "workspace_original", probe.physical === "same" ? probe.run : probe.physical === "other" ? "unrelated_owner" : null, probe.json instanceof Uint8Array ? probe.json.buffer : probe.json, NOW).run();
      try {
        f.captures.length = 0;
        await expect(context.writeBucket!(ref, { expectedRunningRun: runs.get(probe.run)!, expectedWorkspaceManagementAuthority: { workspaceId: "workspace_original", managementState: "active", managementEpoch: 1 }, allocation: { kind: "backup_control", backupId, ref } }).put(ref, new Uint8Array([1, 2, 3]))).rejects.toThrow();
        expect(f.captures, probe.name).toHaveLength(1);
        const actual = f.captures[0]!;
        const original = await f.native.prepare(ORIGINAL).bind(...actual.params).all();
        measurements.push({ name: probe.name, originalRowsRead: original.meta.rows_read, actualRowsRead: actual.rowsRead, conflict: actual.rows[0]!.has_record });
        expect(actual.rows, probe.name).toEqual(original.results);
        expect(actual.rows[0]!.has_record, probe.name).toBe(probe.expected);
        expect(actual.rowsRead, probe.name).toBeLessThanOrEqual(2);
        expect(original.meta.rows_read, probe.name).toBeGreaterThan(4096);
        expect(prepares, probe.name).toBe(probe.expected === 0 ? 1 : 0);
        expect(await bucket.head(ref), probe.name).toBeNull();
      } finally { if (probe.json !== undefined) await f.native.prepare("delete from backups where id=?").bind(insertedId).run(); }
    }
    const captured = f.captures[0]!;
    expect(primarySessions).toBe(probes.length);
    const plan = (await f.native.prepare("explain query plan " + captured.sql).bind(...captured.params).all<{ detail: string }>()).results.map(row => row.detail);
    expect(plan.filter(detail => detail.startsWith("SEARCH"))).toHaveLength(4);
    expect(plan.some(detail => detail.startsWith("SCAN"))).toBe(false);
    expect(plan.some(detail => detail.includes(LEGACY) && detail.includes("<expr>=?"))).toBe(true);
    const after = await inventory(f.native);
    expect(after).toEqual(before);
    const evidencePath = process.env.TAKOSUMI_TEST_BACKUP_INDEX_REPORT;
    if (evidencePath) {
      await Bun.write(evidencePath, JSON.stringify({ kind: "native-backup-index74-test-evidence", before, after, originalLedger, currentLedger, primarySessions, plan, actualQuery: captured.sql, measurements }, null, 2) + "\n");
      await chmod(evidencePath, 0o600);
    }
  } finally { await f.close(); }
}, 60_000);

test("native74 cold/warm indexed readiness rejects exact-name wrong shape, evicts rejection and recovers read-only", async () => {
  const f = await fixture();
  try {
    const sql = new Map((await f.native.prepare("select name,sql from sqlite_master where name in (?,?)").bind(PHYSICAL, LEGACY).all<{ name: string; sql: string }>()).results.map(row => [row.name, row.sql]));
    const variants = [
      { name: PHYSICAL, ddl: null },
      { name: LEGACY, ddl: null },
      { name: PHYSICAL, ddl: `create index ${PHYSICAL} on backups(id)` },
      { name: PHYSICAL, ddl: `create unique index ${PHYSICAL} on backups(created_by_run_id)` },
      { name: PHYSICAL, ddl: `create index ${PHYSICAL} on backups(created_by_run_id) where created_by_run_id is not null` },
      { name: PHYSICAL, ddl: `create index ${PHYSICAL} on backups(created_by_run_id collate NOCASE)` },
      { name: PHYSICAL, ddl: `create index ${PHYSICAL} on backups(created_by_run_id,id)` },
      { name: PHYSICAL, ddl: `create index ${PHYSICAL} on runs(id)` },
      { name: LEGACY, ddl: `create index ${LEGACY} on backups((${EXPR.replace("createdByRunId", "createdbyrunid")}))` },
      { name: LEGACY, ddl: `create index ${LEGACY} on backups((cast(json_extract(record_json,'$.createdByRunId') as text)))` },
      { name: LEGACY, ddl: `create unique index ${LEGACY} on backups((${EXPR}))` },
      { name: LEGACY, ddl: `create index ${LEGACY} on backups((${EXPR}) collate NOCASE)` },
      { name: LEGACY, ddl: `create index ${LEGACY} on backups((${EXPR}),id)` },
    ];
    const ledger = (await f.native.prepare("select * from schema_migrations order by version").all()).results;
    for (const variant of variants) {
      await verifyD1BackupOwnerIndexesPredeployed(f.db);
      await f.native.prepare(`drop index ${variant.name}`).run();
      if (variant.ddl) await f.native.prepare(variant.ddl).run();
      await expect(verifyD1BackupOwnerIndexesPredeployed(f.db)).rejects.toThrow(); // warm binding
      await expect(verifyD1BackupOwnerIndexesPredeployed(bridge(f.native, []))).rejects.toThrow(); // cold binding
      await expect(verifyD1OpenTofuLedgerSchemaPredeployed(bridge(f.native, []))).rejects.toThrow();
      if (variant.ddl) await f.native.prepare(`drop index ${variant.name}`).run();
      await f.native.prepare(sql.get(variant.name)!).run();
      const observed: string[] = [];
      const readonly: D1Database = { prepare(query) { observed.push(query); if (!/^\s*(?:select|pragma)\b/iu.test(query)) throw new Error("readiness attempted mutation"); return f.db.prepare(query); } };
      await verifyD1BackupOwnerIndexesPredeployed(readonly);
      expect(observed.every(query => /^\s*(?:select|pragma)\b/iu.test(query))).toBe(true);
      await verifyD1BackupOwnerIndexesPredeployed(f.db); // rejected promise evicted
    }
    expect((await f.native.prepare("select * from schema_migrations order by version").all()).results).toEqual(ledger);
  } finally { await f.close(); }
}, 60_000);

test("native indexed readiness never caches maintenance and catches activation during its metadata await", async () => {
  const f = await fixture();
  try {
    await verifyD1BackupOwnerIndexesPredeployed(f.db);
    let armed = true;
    const paused = bridge(f.native, [], async () => {
      if (!armed) return; armed = false;
      await f.native.prepare("update _takosumi_control_schema_maintenance set active=1,released_at=null where singleton=1").run();
    });
    await expect(verifyD1BackupOwnerIndexesPredeployed(paused)).rejects.toThrow();
    await expect(verifyD1BackupOwnerIndexesPredeployed(f.db)).rejects.toThrow();
    await releaseControlD1MaintenanceFence(f.db, f.fence, "2026-10-14T00:02:00.000Z");
    await verifyD1BackupOwnerIndexesPredeployed(paused);
    await verifyD1BackupOwnerIndexesPredeployed(f.db);
  } finally { await f.close(); }
}, 30_000);

test("native indexed warm74 proof rejects a completed-maintenance future tail or any changed ledger prefix and recovers", async () => {
  const f = await fixture();
  try {
    await verifyD1BackupOwnerIndexesPredeployed(f.db);
    const ledger = (await f.native.prepare("select * from schema_migrations order by version").all<{ version: number; name: string; checksum: string; applied_at: string }>()).results;
    const indexes = (await f.native.prepare("select name,sql from sqlite_master where name in (?,?) order by name").bind(PHYSICAL, LEGACY).all()).results;
    const fence = await acquireControlD1MaintenanceFence(f.db, { sourceCommit: "c".repeat(40), manifestDigest: "sha256:" + "d".repeat(64), environment: "backup-index-native-test", databaseRole: "in_place", releasePolicy: "in_place" }, NOW);
    await f.db.batch!(await wrapControlD1MaintenanceMigrationBatch(f.db, fence, [f.db.prepare("insert into schema_migrations values(75,'unknown_future',?,?)").bind("sha256:" + "f".repeat(64), NOW)]));
    await releaseControlD1MaintenanceFence(f.db, fence, "2026-10-14T00:03:00.000Z");
    await expect(verifyD1BackupOwnerIndexesPredeployed(f.db)).rejects.toThrow();
    await f.native.prepare("delete from schema_migrations where version=75").run();
    await verifyD1BackupOwnerIndexesPredeployed(f.db);
    for (const mutate of [
      "delete from schema_migrations where version=74",
      "delete from schema_migrations where version=43",
      "update schema_migrations set name='wrong_name' where version=43",
      "update schema_migrations set checksum='sha256:bad' where version=74",
      "update schema_migrations set version=75 where version=43",
    ]) {
      await f.native.prepare(mutate).run();
      await expect(verifyD1BackupOwnerIndexesPredeployed(f.db)).rejects.toThrow();
      // Restore exactly the original rows, then retry the SAME binding to prove
      // rejection eviction without carrying a stale previously-accepted proof.
      await f.native.batch([f.native.prepare("delete from schema_migrations"), ...ledger.map(row => f.native.prepare("insert into schema_migrations values(?,?,?,?)").bind(row.version, row.name, row.checksum, row.applied_at))]);
      await verifyD1BackupOwnerIndexesPredeployed(f.db);
    }
    expect((await f.native.prepare("select * from schema_migrations order by version").all()).results).toEqual(ledger);
    expect((await f.native.prepare("select name,sql from sqlite_master where name in (?,?) order by name").bind(PHYSICAL, LEGACY).all()).results).toEqual(indexes);
  } finally { await f.close(); }
}, 30_000);


test("native74 index migration rolls both index creations back on a failing second DDL and retries forward", async () => {
  const f = await fixture(73);
  try {
    const before = await inventory(f.native);
    const fault: D1Database = {
      prepare(sql) { return f.db.prepare(sql.startsWith("create index if not exists backups_legacy_created_by_run_text_idx") ? "create index fixture_invalid_backup_index on backups(no_such_column)" : sql); },
      batch: statements => f.db.batch!(statements),
    };
    await expect(ensureD1OpenTofuLedgerSchema(fault)).rejects.toThrow();
    expect((await f.native.prepare("select name from sqlite_master where name in (?,?)").bind(PHYSICAL, LEGACY).all()).results).toEqual([]);
    expect(await f.native.prepare("select max(version) as version from schema_migrations").first("version")).toBe(73);
    expect(await inventory(f.native)).toEqual(before);
    await ensureD1OpenTofuLedgerSchema(f.db);
    await verifyD1BackupOwnerIndexesPredeployed(f.db);
    expect(await inventory(f.native)).toEqual(before);
  } finally { await f.close(); }
}, 30_000);

test("native exact71/72/73/74 request bridge separates ordinary, billing, identity and indexed floors without DDL", async () => {
  for (const head of [71, 72, 73, 74]) {
    const f = await fixture(head);
    try {
      const workspace = { id: "workspace_bridge", handle: "workspace-bridge", displayName: "Native bridge", type: "personal" as const, ownerUserId: "owner_bridge", createdAt: NOW, updatedAt: NOW };
      await f.store.putWorkspace(workspace);
      const member = { id: "member_bridge", workspaceId: workspace.id, accountId: workspace.ownerUserId, roles: ["owner"], status: "active", createdAt: NOW, updatedAt: NOW };
      await f.native.prepare("insert into workspace_members(id,workspace_id,account_id,status,record_json,created_at,updated_at) values(?,?,?,'active',?,?,?)")
        .bind(member.id, member.workspaceId, member.accountId, JSON.stringify(member), NOW, NOW).run();
      const readonly: D1Database = { prepare(sql) {
        if (!/^\s*(?:select|pragma|with)\b/iu.test(sql)) throw new Error("request attempted schema mutation");
        return f.db.prepare(sql);
      }, async batch() { throw new Error("request attempted batch mutation"); } };
      const store = new CloudflareD1OpenTofuControlStore(readonly, { schemaMode: "predeployed" });
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      const coldPage = new CloudflareD1OpenTofuControlStore({ prepare: sql => readonly.prepare(sql) }, { schemaMode: "predeployed" });
      expect((await coldPage.listWorkspacesForAccountPage(member.accountId, { limit: 1 })).items).toEqual([workspace]);
      if (head >= 72) expect(await store.getWorkspaceBillingBinding(workspace.id)).toBeUndefined();
      else await expect(store.getWorkspaceBillingBinding(workspace.id)).rejects.toThrow();
      if (head >= 73) expect(await store.captureIdentityReconciliationInventory([member.accountId])).toMatchObject({ accountIds: [member.accountId], members: [member], workspaces: [{ workspace }], overflow: false });
      else await expect(store.captureIdentityReconciliationInventory([member.accountId])).rejects.toThrow();
      if (head === 74) {
        await verifyD1BackupOwnerIndexesPredeployed(readonly);
        await verifyD1OpenTofuLedgerSchemaPredeployed(readonly);
      } else {
        await expect(verifyD1BackupOwnerIndexesPredeployed(readonly)).rejects.toThrow();
        await expect(verifyD1OpenTofuLedgerSchemaPredeployed(readonly)).rejects.toThrow();
      }
      expect((await f.native.prepare("select name from sqlite_master where type='index' and name in (?,?)").bind(PHYSICAL, LEGACY).all()).results).toHaveLength(head === 74 ? 2 : 0);
      await f.native.prepare("update _takosumi_control_schema_maintenance set active=1,released_at=null where singleton=1").run();
      await expect(store.getWorkspace(workspace.id)).rejects.toThrow("maintenance_fence_active");
      await expect(coldPage.listWorkspacesForAccountPage(member.accountId, { limit: 1 })).rejects.toThrow("maintenance_fence_active");
      await expect(verifyD1BackupOwnerIndexesPredeployed(readonly)).rejects.toThrow();
    } finally { await f.close(); }
  }
}, 60_000);
