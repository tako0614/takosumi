import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { workerdD1Database, workerdD1Module } from "../../helpers/deploy-control/workerd_d1.ts";
import {
  applyControlD1Schema, buildControlD1SchemaPlan,
  CONTROL_D1_PRODUCTION_V66_V75_INTERNAL_GUARD,
  readControlD1MigrationLedger, SqliteControlD1Database,
} from "../../../deploy/platform/control_d1_schema.ts";
import { runControlD1SchemaProductionV66V75Cli } from "../../../deploy/platform/control_d1_schema_cli.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, assertControlD1NoActiveRuns, releaseControlD1MaintenanceFence, readControlD1MaintenanceState } from "../../../worker/src/d1_schema_maintenance.ts";
import type { D1Database, D1PreparedStatement, D1Result } from "../../../worker/src/bindings.ts";

const source = "a".repeat(40);
const databaseId = "synthetic-production66to75";
const now = "2026-10-26T00:00:00.000Z";
const planPromise = buildControlD1SchemaPlan();
function options() {
  return {
    sourceCommit: source, environment: "production" as const, databaseId,
    activatedAt: now, releasedAt: () => now,
    maintenanceDrainMilliseconds: 0, waitForRequestDrain: async () => {},
    retainMaintenanceFence: true, databaseRole: "in_place" as const,
    releasePolicy: "in_place" as const,
    internalGuard: CONTROL_D1_PRODUCTION_V66_V75_INTERNAL_GUARD,
  };
}
async function baseline() {
  const db = new SqliteControlD1Database();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 66 });
  return db;
}
function wrapped(db: D1Database, before?: () => Promise<void>, after?: () => Promise<void>) {
  const stats = { batches: 0 };
  const database: D1Database = {
    prepare: (query: string) => db.prepare(query),
    batch: async <T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> => {
      stats.batches++;
      await before?.();
      const result = await db.batch<T>(statements);
      await after?.();
      return result;
    },
  };
  return { database, stats };
}
async function run(db: D1Database, status: string, lease: string | null = null) {
  await db.prepare("insert into runs(id,space_id,type,status,lease_token,run_json,created_at) values(?,?,?,?,?,?,?)")
    .bind("run_synthetic", "ws_synthetic", "apply", status, lease, "{}", now).run();
}

for (const [label, sql, failure] of [
  ["tampered checksum", "update schema_migrations set checksum='wrong' where version=10", "ledger_mismatch"],
  ["missing row", "delete from schema_migrations where version=10", "ledger_mismatch"],
  ["future row", "insert into schema_migrations values(76,'future','wrong','synthetic')", "future_ledger_rejected"],
] as const) {
  test(`production66to75 rejects ${label} before the first fence batch`, async () => {
    const db = await baseline();
    try {
      await db.prepare(sql).run();
      const counted = wrapped(db);
      await expect(applyControlD1Schema(counted.database, await planPromise, options()))
        .rejects.toMatchObject({ code: `production_v66_v75_${failure}` });
      expect(counted.stats.batches).toBe(0);
      expect(await readControlD1MaintenanceState(db)).toEqual({ status: "absent" });
    } finally { db.close(); }
  });
}

test("production66to75 refuses an unfenced intermediate ledger", async () => {
  const db = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 70 });
    const counted = wrapped(db);
    await expect(applyControlD1Schema(counted.database, await planPromise, options()))
      .rejects.toMatchObject({ code: "production_v66_v75_active_fence_required" });
    expect(counted.stats.batches).toBe(0);
  } finally { db.close(); }
});

for (const [status, lease] of [["queued", null], ["running", null], ["unknown-status", null], ["succeeded", "retained-lease"]] as const) {
  test(`production66to75 refuses ${status}/${lease ?? "no-lease"} before fencing`, async () => {
    const db = await baseline();
    try {
      await run(db, status, lease);
      const counted = wrapped(db);
      await expect(applyControlD1Schema(counted.database, await planPromise, options()))
        .rejects.toMatchObject({ code: "maintenance_runs_active" });
      expect(counted.stats.batches).toBe(0);
      expect(await readControlD1MaintenanceState(db)).toEqual({ status: "absent" });
    } finally { db.close(); }
  });
}

test("production66to75 atomically refuses a Run arriving between preflight and fence", async () => {
  const db = await baseline();
  try {
    let injected = false;
    const raced = wrapped(db, async () => {
      if (injected) return;
      injected = true;
      await run(db, "running", "original-lease");
    });
    await expect(applyControlD1Schema(raced.database, await planPromise, options()))
      .rejects.toMatchObject({ code: "maintenance_fence_acquire_failed" });
    expect(raced.stats.batches).toBe(1);
    expect((await readControlD1MigrationLedger(db)).at(-1)?.version).toBe(66);
    expect(await readControlD1MaintenanceState(db)).toEqual({ status: "absent" });
    expect(await db.prepare("select status,lease_token from runs").first())
      .toEqual({ status: "running", lease_token: "original-lease" });
  } finally { db.close(); }
});

async function populate(db: D1Database) {
  const workspace = JSON.stringify({ id: "ws_synthetic", handle: "synthetic", type: "personal", ownerUserId: "account_synthetic" });
  const member = JSON.stringify({ id: "member_synthetic", workspaceId: "ws_synthetic", accountId: "account_synthetic", status: "active", roles: ["owner"] });
  await db.prepare("insert into workspaces(id,handle,record_json,created_at,updated_at,personal_bootstrap_owner_id) values(?,?,?,?,?,?)")
    .bind("ws_synthetic", "synthetic", workspace, now, now, "account_synthetic").run();
  await db.prepare("insert into workspace_members values(?,?,?,?,?,?,?)")
    .bind("member_synthetic", "ws_synthetic", "account_synthetic", "active", member, now, now).run();
  for (let i = 0; i < 32; i++) {
    await db.prepare("insert into backups(id,space_id,created_by_run_id,record_json,created_at) values(?,?,?,?,?)")
      .bind(`backup_${i}`, "ws_synthetic", i % 2 ? "run_synthetic" : null,
        JSON.stringify({ id: `backup_${i}`, createdByRunId: i % 2 ? 7 : "run_synthetic", fixture: "x".repeat(4096) }), now).run();
  }
  await run(db, "succeeded");
}
async function retained(db: D1Database) {
  const result = [];
  for (const table of ["workspaces", "workspace_members", "backups"]) {
    result.push((await db.prepare(`select id,record_json from ${table} order by id`).all()).results);
  }
  return result;
}

for (const head of [67, 68, 69, 70, 71, 72, 73, 74, 75]) {
  test(`production66to75 preserves populated originals and resumes a committed fault at${head}`, async () => {
    const db = await baseline();
    try {
      await populate(db);
      const original = await retained(db);
      let fault = false;
      const faulted = wrapped(db, undefined, async () => {
        if (!fault && (await readControlD1MigrationLedger(db)).at(-1)?.version === head) {
          fault = true;
          throw new Error(`fault_after_${head}`);
        }
      });
      const plan = await planPromise;
      await expect(applyControlD1Schema(faulted.database, plan, options())).rejects.toThrow(`fault_after_${head}`);
      expect((await readControlD1MigrationLedger(db)).at(-1)?.version).toBe(head);
      expect(await readControlD1MaintenanceState(db)).toMatchObject({ status: "active", fence: {
        sourceCommit: source, manifestDigest: plan.manifestDigest, predecessor: null, databaseId,
      } });
      await expect(db.prepare("update workspaces set handle='forbidden'").run()).rejects.toThrow();
      const result = await applyControlD1Schema(db, plan, options());
      expect(result.appliedMigrationVersions).toEqual(plan.migrations.filter((x) => x.version > head).map((x) => x.version));
      expect(result.maintenanceStatus).toBe("retained");
      expect(result.verification).toMatchObject({ status: "ready", latestMigrationVersion: 75 });
      expect(await retained(db)).toEqual(original);
      expect(await db.prepare("select count(*) as count from workspace_billing_bindings").first()).toEqual({ count: 0 });
      const output: string[] = [];
      const deps = {
        sourceCommit: source, now: () => now,
        inspectSourceCheckout: async () => ({ head: source, clean: true }),
        createRemoteDatabase: async () => ({ database: db, configurationDigest: `sha256:${"b".repeat(64)}`, databaseId }),
      };
      expect(await runControlD1SchemaProductionV66V75Cli([
        "release", "--environment", "production", "--confirm-manifest", plan.manifestDigest,
      ], {}, (value) => output.push(value), deps)).toBe(0);
      expect(await readControlD1MaintenanceState(db)).toEqual({ status: "inactive" });
      await db.prepare("update workspaces set handle='released'").run();
    } finally { db.close(); }
  });
}

test("production66to75 CLI refuses environment/command overrides without opening a target", async () => {
  for (const args of [["plan", "--environment", "staging"], ["freeze", "--environment", "production"]]) {
    let opened = false;
    const output: string[] = [];
    expect(await runControlD1SchemaProductionV66V75Cli(args, {}, (value) => output.push(value), {
      createRemoteDatabase: async () => { opened = true; throw new Error("must_not_open"); },
    })).toBe(1);
    expect(opened).toBe(false);
    expect(JSON.parse(output[0]!).failureCode).toMatch(/^production_v66_v75_/u);
  }
});

test("production66to75 actual CLI keeps its internal admission guard and refuses a busy target", async () => {
  const db = await baseline();
  try {
    await run(db, "running");
    const counted = wrapped(db);
    const output: string[] = [];
    expect(await runControlD1SchemaProductionV66V75Cli([
      "apply", "--environment", "production", "--confirm-manifest", (await planPromise).manifestDigest,
      "--retain-maintenance-fence",
    ], {}, (value) => output.push(value), {
      sourceCommit: source, inspectSourceCheckout: async () => ({ head: source, clean: true }),
      createRemoteDatabase: async () => ({ database: counted.database, configurationDigest: `sha256:${"b".repeat(64)}`, databaseId }),
    })).toBe(1);
    expect(JSON.parse(output[0]!).failureCode).toBe("maintenance_runs_active");
    expect(counted.stats.batches).toBe(0);
    expect(await readControlD1MaintenanceState(db)).toEqual({ status: "absent" });
  } finally { db.close(); }
});

test("production66to75 CLI rejects unrelated candidate/predecessor flags before opening any target", async () => {
  for (const [command, extra, expected] of [
    ["apply", ["--confirm-database-id", databaseId], "arguments_invalid"],
    ["apply", ["--confirm-source-export-sha256", `sha256:${"b".repeat(64)}`], "arguments_invalid"],
    ["apply", ["--confirm-predecessor-source", source, "--confirm-predecessor-manifest", `sha256:${"b".repeat(64)}`], "production_v66_v75_predecessor_forbidden"],
    ["release", ["--confirm-fence-source-commit", source], "production_v66_v75_forward_repair_forbidden"],
  ]) {
    let opened = false;
    const output: string[] = [];
    expect(await runControlD1SchemaProductionV66V75Cli([
      command, "--environment", "production", ...extra,
    ], {}, (value) => output.push(value), {
      sourceCommit: source, createRemoteDatabase: async () => { opened = true; throw new Error("must_not_open"); },
    })).toBe(1);
    expect(opened).toBe(false);
    expect(JSON.parse(output[0]!).failureCode).toBe(expected);
  }
});

test("native D1 quiescent fence atomically rejects a racing Run on insert and inactive UPSERT", async () => {
  const runtime = new Miniflare({
    modules: [workerdD1Module("production-schema-quiescence-fixture.mjs")],
    compatibilityDate: "2026-07-01", d1Databases: { CONTROL: "synthetic-production-schema-quiescence" },
  });
  try {
    const db = workerdD1Database(runtime);
    // This tests actual D1 CHECK/UPSERT/transaction semantics. Full canonical
    // 66->75 data preservation and fault-forward replay are the SQLite cases
    // above; this fixture does not claim remote Import API qualification.
    await db.prepare("create table runs(id text primary key,status text not null,lease_token text)").run();
    const identity = {
      sourceCommit: source, manifestDigest: (await planPromise).manifestDigest,
      environment: "production", databaseRole: "in_place" as const,
      releasePolicy: "in_place" as const, databaseId,
    };
    for (const prior of ["absent", "inactive"]) {
      await assertControlD1NoActiveRuns(db);
      let injected = false;
      const raced = wrapped(db, async () => {
        if (!injected) {
          injected = true;
          await db.prepare("insert into runs values('native_original','running','retained_original')").run();
        }
      });
      await expect(acquireControlD1MaintenanceFence(raced.database, identity, now, { requireQuiescentRuns: true }))
        .rejects.toMatchObject({ code: "maintenance_fence_acquire_failed" });
      expect(await readControlD1MaintenanceState(db)).toEqual({ status: prior });
      expect(await db.prepare("select status,lease_token from runs").first())
        .toEqual({ status: "running", lease_token: "retained_original" });
      // End this synthetic operation explicitly; the operator surface never
      // expires a real Run, clears a lease, or settles an original itself.
      await db.prepare("delete from runs where id='native_original'").run();
      const fence = await acquireControlD1MaintenanceFence(db, identity, now, { requireQuiescentRuns: true });
      expect(await readControlD1MaintenanceState(db)).toMatchObject({ status: "active", fence: { sourceCommit: source } });
      await releaseControlD1MaintenanceFence(db, fence, now);
      expect(await readControlD1MaintenanceState(db)).toEqual({ status: "inactive" });
    }
  } finally { await runtime.dispose(); }
}, 30_000);
