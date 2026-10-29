import { expect, test } from "bun:test";
import {
  applyControlD1Schema, buildControlD1SchemaPlan,
  CONTROL_D1_PRODUCTION_V75_V79_INTERNAL_GUARD,
  readControlD1MigrationLedger, SqliteControlD1Database,
} from "../../../deploy/platform/control_d1_schema.ts";
import {
  runControlD1SchemaProductionV66V75Cli,
  runControlD1SchemaProductionV75V79Cli,
} from "../../../deploy/platform/control_d1_schema_cli.ts";
import { ensureD1OpenTofuLedgerSchema, verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../worker/src/d1_opentofu_store.ts";
import { readControlD1MaintenanceState } from "../../../worker/src/d1_schema_maintenance.ts";
import type { D1Database, D1PreparedStatement, D1Result } from "../../../worker/src/bindings.ts";

const source = "a".repeat(40);
const databaseId = "synthetic-production75to79";
const now = "2026-10-29T00:00:00.000Z";
// The TASK-0118 production owner is pinned to its authorized v79 tail.
const planPromise = buildControlD1SchemaPlan({ throughMigrationVersion: 79 });
function options() {
  return {
    sourceCommit: source, environment: "production" as const, databaseId,
    activatedAt: now, releasedAt: () => now,
    maintenanceDrainMilliseconds: 0, waitForRequestDrain: async () => {},
    retainMaintenanceFence: true, databaseRole: "in_place" as const,
    releasePolicy: "in_place" as const,
    internalGuard: CONTROL_D1_PRODUCTION_V75_V79_INTERNAL_GUARD,
  };
}
async function baseline() {
  const db = new SqliteControlD1Database();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
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
function cliDependencies(database: D1Database) {
  return {
    sourceCommit: source, now: () => now,
    inspectSourceCheckout: async () => ({ head: source, clean: true }),
    createRemoteDatabase: async () => ({ database, configurationDigest: `sha256:${"b".repeat(64)}`, databaseId }),
  };
}

for (const [label, sql, failure] of [
  ["tampered checksum", "update schema_migrations set checksum='wrong' where version=75", "ledger_mismatch"],
  ["missing row", "delete from schema_migrations where version=10", "ledger_mismatch"],
  ["future row", "insert into schema_migrations values(80,'future','wrong','synthetic')", "future_ledger_rejected"],
] as const) {
  test(`production75to79 rejects ${label} before the first fence batch`, async () => {
    const db = await baseline();
    try {
      await db.prepare(sql).run();
      const counted = wrapped(db);
      await expect(applyControlD1Schema(counted.database, await planPromise, options()))
        .rejects.toMatchObject({ code: `production_v75_v79_${failure}` });
      expect(counted.stats.batches).toBe(0);
      expect(await readControlD1MaintenanceState(db)).toEqual({ status: "absent" });
    } finally { db.close(); }
  });
}

test("production75to79 refuses an older v66 ledger; that target needs the v66-to-v75 lane first", async () => {
  const db = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 66 });
    const counted = wrapped(db);
    await expect(applyControlD1Schema(counted.database, await planPromise, options()))
      .rejects.toMatchObject({ code: "production_v75_v79_ledger_mismatch" });
    expect(counted.stats.batches).toBe(0);
  } finally { db.close(); }
});

test("production75to79 refuses an unfenced intermediate ledger", async () => {
  const db = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 77 });
    const counted = wrapped(db);
    await expect(applyControlD1Schema(counted.database, await planPromise, options()))
      .rejects.toMatchObject({ code: "production_v75_v79_active_fence_required" });
    expect(counted.stats.batches).toBe(0);
  } finally { db.close(); }
});

for (const [status, lease] of [["queued", null], ["running", null], ["unknown-status", null], ["succeeded", "retained-lease"]] as const) {
  test(`production75to79 refuses ${status}/${lease ?? "no-lease"} before fencing`, async () => {
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

test("production75to79 atomically refuses a Run arriving between preflight and fence", async () => {
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
    expect((await readControlD1MigrationLedger(db)).at(-1)?.version).toBe(75);
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
        JSON.stringify({ id: `backup_${i}`, fixture: "x".repeat(4096) }), now).run();
    await db.prepare(`insert into usage_events(id,workspace_id,kind,quantity,usd_micros,rating_status,source,idempotency_key,created_at)
      values(?,?,?,?,?,?,?,?,?)`)
      .bind(`usage_${i}`, "ws_synthetic", "runner_minute", 1, 0, "unrated", "runner", `usage_${i}`, now).run();
  }
  await db.prepare("insert into connections(id,space_id,provider,status,connection_json,created_at,updated_at) values(?,?,?,?,?,?,?)")
    .bind("conn_synthetic", "ws_synthetic", "github", "verified", JSON.stringify({ id: "conn_synthetic", scope: "workspace" }), now, now).run();
  await run(db, "succeeded");
}
async function retained(db: D1Database) {
  const result = [];
  for (const table of ["workspaces", "workspace_members", "backups"]) {
    result.push((await db.prepare(`select id,record_json from ${table} order by id`).all()).results);
  }
  result.push((await db.prepare("select id,workspace_id,created_at from usage_events order by id").all()).results);
  result.push((await db.prepare("select id,connection_json from connections order by id").all()).results);
  return result;
}

for (const head of [76, 77, 78, 79]) {
  test(`production75to79 preserves populated originals and resumes a committed fault at${head}`, async () => {
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
      expect(result.verification).toMatchObject({ status: "ready", latestMigrationVersion: 79 });
      expect(await retained(db)).toEqual(original);
      expect(await db.prepare("select count(*) as count from capsule_members").first()).toEqual({ count: 0 });
      expect(await db.prepare("select owner_account_id from connections").first()).toEqual({ owner_account_id: null });
      const output: string[] = [];
      expect(await runControlD1SchemaProductionV75V79Cli([
        "release", "--environment", "production", "--confirm-manifest", plan.manifestDigest,
      ], {}, (value) => output.push(value), cliDependencies(db))).toBe(0);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ mode: "release", status: "released", expectedLatestMigrationVersion: 79 });
      expect(await readControlD1MaintenanceState(db)).toEqual({ status: "inactive" });
      await verifyD1OpenTofuLedgerSchemaPredeployed(db);
      await db.prepare("update workspaces set handle='released'").run();
    } finally { db.close(); }
  });
}

test("production75to79 CLI verify reports a v75 target as an expected mismatch without mutation", async () => {
  const db = await baseline();
  try {
    const counted = wrapped(db);
    const output: string[] = [];
    expect(await runControlD1SchemaProductionV75V79Cli(["verify", "--environment", "production"], {},
      (value) => output.push(value), cliDependencies(counted.database))).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ mode: "verify", status: "mismatch",
      verification: { latestMigrationVersion: 75 } });
    expect(counted.stats.batches).toBe(0);
    expect(await readControlD1MaintenanceState(db)).toEqual({ status: "absent" });
  } finally { db.close(); }
});

test("production75to79 CLI refuses environment/command overrides without opening a target", async () => {
  for (const args of [["plan", "--environment", "staging"], ["freeze", "--environment", "production"], ["fence", "--environment", "production"]]) {
    let opened = false;
    const output: string[] = [];
    expect(await runControlD1SchemaProductionV75V79Cli(args, {}, (value) => output.push(value), {
      createRemoteDatabase: async () => { opened = true; throw new Error("must_not_open"); },
    })).toBe(1);
    expect(opened).toBe(false);
    expect(JSON.parse(output[0]!).failureCode).toMatch(/^production_v75_v79_/u);
  }
});

test("production75to79 actual CLI keeps its internal admission guard and refuses a busy target", async () => {
  const db = await baseline();
  try {
    await run(db, "running");
    const counted = wrapped(db);
    const output: string[] = [];
    expect(await runControlD1SchemaProductionV75V79Cli([
      "apply", "--environment", "production", "--confirm-manifest", (await planPromise).manifestDigest,
      "--retain-maintenance-fence",
    ], {}, (value) => output.push(value), cliDependencies(counted.database))).toBe(1);
    expect(JSON.parse(output[0]!).failureCode).toBe("maintenance_runs_active");
    expect(counted.stats.batches).toBe(0);
    expect(await readControlD1MaintenanceState(db)).toEqual({ status: "absent" });
  } finally { db.close(); }
});

test("production75to79 CLI refuses an apply that drops the retained fence", async () => {
  const db = await baseline();
  try {
    const counted = wrapped(db);
    const output: string[] = [];
    expect(await runControlD1SchemaProductionV75V79Cli([
      "apply", "--environment", "production", "--confirm-manifest", (await planPromise).manifestDigest,
    ], {}, (value) => output.push(value), cliDependencies(counted.database))).toBe(1);
    expect(JSON.parse(output[0]!).failureCode).toBe("production_v75_v79_retain_fence_required");
    expect(counted.stats.batches).toBe(0);
  } finally { db.close(); }
});

test("production75to79 CLI rejects unrelated candidate/predecessor flags before opening any target", async () => {
  for (const [command, extra, expected] of [
    ["apply", ["--confirm-database-id", databaseId], "arguments_invalid"],
    ["apply", ["--confirm-source-export-sha256", `sha256:${"b".repeat(64)}`], "arguments_invalid"],
    ["apply", ["--confirm-predecessor-source", source, "--confirm-predecessor-manifest", `sha256:${"b".repeat(64)}`], "production_v75_v79_predecessor_forbidden"],
    ["release", ["--confirm-fence-source-commit", source], "production_v75_v79_forward_repair_forbidden"],
  ]) {
    let opened = false;
    const output: string[] = [];
    expect(await runControlD1SchemaProductionV75V79Cli([
      command as string, "--environment", "production", ...(extra as string[]),
    ], {}, (value) => output.push(value), {
      sourceCommit: source, createRemoteDatabase: async () => { opened = true; throw new Error("must_not_open"); },
    })).toBe(1);
    expect(opened).toBe(false);
    expect(JSON.parse(output[0]!).failureCode).toBe(expected);
  }
});

test("production75to79 default CLI plan stays pinned to v79 and the v66-to-v75 lane stays at v75", async () => {
  const output: string[] = [];
  expect(await runControlD1SchemaProductionV75V79Cli(["plan", "--environment", "production"], {}, (value) => output.push(value), {
    sourceCommit: source,
  })).toBe(0);
  const transcript = JSON.parse(output[0]!);
  expect(transcript.manifestDigest).toBe((await planPromise).manifestDigest);
  expect(transcript.expectedLatestMigrationVersion).toBe(79);
  const historical: string[] = [];
  expect(await runControlD1SchemaProductionV66V75Cli(["plan", "--environment", "production"], {}, (value) => historical.push(value), {
    sourceCommit: source,
  })).toBe(0);
  expect(JSON.parse(historical[0]!).expectedLatestMigrationVersion).toBe(75);
});
