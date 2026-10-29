import { expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import type { SqlClient, SqlParameters, SqlTransaction } from "../../../../core/adapters/storage/sql.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import type { SourceOwnershipMigrationGroup, SourceOwnershipMigrationStore } from "../../../../core/domains/sources/ownership-migration.ts";
import {
  applyPostgresSourceOwnershipBackfill,
  inspectPostgresSourceOwnershipBackfill,
} from "../../../../deploy/node-postgres/src/source-ownership-backfill.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { parsePostgresBackfillArgs, runPostgresSourceOwnershipBackfill } from "../../../../scripts/operator-source-ownership-postgres.ts";

const NOW = "2026-10-28T00:00:00.000Z";
const WS = "ws_backfill";
const SRC = "src_backfill";

function rejectDdl(client: SqlClient): SqlClient {
  return {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
      statement: string, parameters?: SqlParameters,
    ) {
      if (/^\s*(create|alter|drop|truncate)\b/iu.test(statement))
        throw new Error("backfill entrypoint attempted DDL");
      return client.query<Row>(statement, parameters);
    },
    transaction<T>(fn: (transaction: SqlTransaction) => T | Promise<T>): Promise<T> {
      return client.transaction((transaction) => fn(rejectDdl(transaction)));
    },
  };
}

test("Postgres backfill CLI is dry-run by default and requires an apply file", () => {
  expect(parsePostgresBackfillArgs([])).toEqual({});
  expect(parsePostgresBackfillArgs(["--source-id", SRC])).toEqual({ sourceId: SRC });
  expect(parsePostgresBackfillArgs(["--apply", "reviewed.json", "--source-id", SRC]))
    .toEqual({ sourceId: SRC, applyFile: "reviewed.json" });
  expect(() => parsePostgresBackfillArgs(["--apply"])).toThrow();
});

test("Postgres CLI dry-run and reviewed apply issue no DDL or server bootstrap", async () => {
  const { client } = await fixture();
  try {
    const store = new SqlOpenTofuControlStore({ client: rejectDdl(client) });
    const reports = await runPostgresSourceOwnershipBackfill(store, { sourceId: SRC });
    expect(Array.isArray(reports)).toBe(true);
    const report = (reports as readonly unknown[])[0];
    const applied = await runPostgresSourceOwnershipBackfill(store,
      { sourceId: SRC, applyFile: "reviewed.json" }, async () => JSON.stringify(report));
    expect(applied).toMatchObject({ sourceId: SRC, status: "committed" });
  } finally { await client.close(); }
}, 30_000);

test("Postgres dry-run isolates a failed Source group and continues to a valid backfill", async () => {
  const { client, store } = await fixture();
  try {
    const valid = (await store.readGroup(SRC))!;
    const injected: SourceOwnershipMigrationStore = {
      listSourceIds: async () => ["aaa_bad", "bbb_missing", "ccc_broken", SRC],
      readGroup: async (id) => {
        if (id === "aaa_bad") throw new Error("private_database_diagnostic_marker");
        if (id === "bbb_missing") return undefined;
        if (id === "ccc_broken") return {} as SourceOwnershipMigrationGroup;
        return valid;
      },
      commitGroup: async () => { throw new Error("dry-run must not commit"); },
    };
    const reports = await inspectPostgresSourceOwnershipBackfill(injected, { preparedAt: NOW });
    expect(reports.map((report) => [report.sourceId, report.reason ?? report.status]))
      .toEqual([["aaa_bad", "group_read_failed"], ["bbb_missing", "source_missing"],
        ["ccc_broken", "preparation_failed"], [SRC, "ready"]]);
    expect(JSON.stringify(reports)).not.toContain("private_database_diagnostic_marker");
  } finally { await client.close(); }
}, 30_000);

async function fixture() {
  const client = await PGliteSqlClient.create();
  const store = new SqlOpenTofuControlStore({ client });
  const workspace = { id: WS, handle: "ws-backfill", displayName: "Backfill",
    type: "personal", ownerUserId: "owner_backfill", createdAt: NOW, updatedAt: NOW };
  await client.query(`insert into takosumi_workspaces (id, handle, space_json, created_at, updated_at)
    values ($1, $2, $3::jsonb, $4, $5)`, [WS, workspace.handle, JSON.stringify(workspace), NOW, NOW]);
  const source: StoredSource = { id: SRC, workspaceId: WS, name: "Backfill", url: "https://example.test/repo.git",
    defaultRef: "main", defaultPath: ".", status: "active", autoSync: true,
    hookSecretHash: "a".repeat(64), createdAt: NOW, updatedAt: NOW };
  await client.query(`insert into takosumi_sources (id, space_id, status, source_json, created_at, updated_at)
    values ($1, $2, $3, $4::jsonb, $5, $6)`,
    [SRC, WS, source.status, JSON.stringify(source), NOW, NOW]);
  const addCapsule = async (id: string) => {
    const capsule: Capsule = { id, workspaceId: WS, projectId: "prj_backfill", name: id, slug: id,
      sourceId: SRC, installConfigId: `cfg_${id}`, environment: "production", currentStateGeneration: 0,
      status: "active", createdAt: NOW, updatedAt: NOW };
    await client.query(`insert into takosumi_capsules
      (id, space_id, project_id, name, environment, source_id, install_config_id,
       status, installation_json, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [id, WS, capsule.projectId, capsule.name, capsule.environment, SRC,
        capsule.installConfigId, capsule.status, JSON.stringify(capsule), NOW, NOW]);
    const config: InstallConfig = { id: capsule.installConfigId, workspaceId: WS, name: id,
      variableMapping: {}, outputAllowlist: {}, policy: {}, createdAt: NOW, updatedAt: NOW };
    await client.query(`insert into takosumi_install_configs
      (id, space_id, config_json, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $5)`,
      [config.id, WS, JSON.stringify(config), NOW, NOW]);
  };
  await addCapsule("cap_one");
  return { client, store, addCapsule };
}

async function seedAppliedLane(store: SqlOpenTofuControlStore): Promise<void> {
  const snapshot = { id: "snap_applied_lane", origin: "git" as const, workspaceId: WS,
    sourceId: SRC, url: "https://example.test/repo.git", ref: "release/v2", path: "infra",
    resolvedCommit: "a".repeat(40),
    archiveRef: `workspaces/${WS}/sources/${SRC}/snapshots/snap_applied_lane/source.tar.zst`,
    archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 5,
    fetchedByRunId: "sync_applied_lane", fetchedAt: NOW };
  await store.putSourceSnapshot(snapshot);
  const plan: PlanRun = {
    id: "plan_applied_lane", workspaceId: WS, capsuleId: "cap_one",
    capsuleCurrentStateVersionId: null,
    source: { kind: "git", url: snapshot.url, commit: snapshot.resolvedCommit },
    sourceDigest: "sha256:source", operation: "create", runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables", requiredProviders: [], status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy", planDigest: "sha256:plan",
    sourceSnapshotId: snapshot.id,
    capsuleContext: { workspaceId: WS, capsuleId: "cap_one", environment: "production" },
    appliedApplyRunId: "apply_applied_lane", auditEvents: [], createdAt: 1, updatedAt: 1,
  };
  const apply: ApplyRun = {
    id: "apply_applied_lane", planRunId: plan.id, workspaceId: WS,
    capsuleId: "cap_one", stateVersionId: "state_applied_lane_1", operation: "create",
    runnerProfileId: plan.runnerProfileId, status: "succeeded",
    expected: { planRunId: plan.id, capsuleId: "cap_one", currentStateVersionId: null,
      runnerProfileId: plan.runnerProfileId, sourceDigest: plan.sourceDigest,
      variablesDigest: plan.variablesDigest, policyDecisionDigest: plan.policyDecisionDigest,
      planDigest: plan.planDigest!, planArtifactDigest: "sha256:artifact" },
    stateBackend: { kind: "operator-managed", ref: "state://test" },
    stateLock: { status: "recorded", backendRef: "state://test" },
    auditEvents: [], createdAt: 1, updatedAt: 1,
  };
  await store.putPlanRun(plan);
  await store.putApplyRun(apply);
  await store.putStateVersion({ id: apply.stateVersionId!, workspaceId: WS,
    capsuleId: "cap_one", environment: "production", generation: 1,
    stateRef: "state://generation/1", digest: "sha256:state-1",
    createdByRunId: apply.id, createdAt: NOW });
  const capsule = (await store.getCapsule("cap_one"))!;
  await store.putCapsule({ ...capsule, currentStateVersionId: apply.stateVersionId,
    currentStateGeneration: 1, updatedAt: NOW });
}

test("Postgres backfill applies only the reviewed exact single-owner digest", async () => {
  const { client, store } = await fixture();
  try {
    const [report] = await inspectPostgresSourceOwnershipBackfill(store, { sourceId: SRC, preparedAt: NOW });
    expect(report).toMatchObject({ sourceId: SRC, preparedAt: NOW, status: "ready", action: "backfill" });
    expect(report?.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(report)).not.toContain("hookSecretHash");
    expect(JSON.stringify(report)).not.toContain("https://example.test");
    expect((await store.getSource(SRC))?.ownerCapsuleId).toBeUndefined();
    expect(await applyPostgresSourceOwnershipBackfill(store, report!)).toBe("committed");
    expect((await store.getSource(SRC))?.ownerCapsuleId).toBe("cap_one");
  } finally { await client.close(); }
}, 30_000);

test("Postgres backfill reports and commits config-only convergence to the applied lane", async () => {
  const { client, store } = await fixture();
  try {
    await seedAppliedLane(store);
    const [report] = await inspectPostgresSourceOwnershipBackfill(store, { sourceId: SRC, preparedAt: NOW });
    expect(report).toMatchObject({ status: "ready", action: "backfill",
      laneConfigChange: { fromRef: "main", fromPath: ".", toRef: "release/v2", toPath: "infra" } });
    expect(await applyPostgresSourceOwnershipBackfill(store, report!)).toBe("committed");
    expect(await store.getSource(SRC)).toMatchObject({ ownerCapsuleId: "cap_one",
      defaultRef: "release/v2", defaultPath: "infra" });
    expect((await store.getSourceSnapshot("snap_applied_lane"))?.archiveRef).toBe(
      `workspaces/${WS}/sources/${SRC}/snapshots/snap_applied_lane/source.tar.zst`);
  } finally { await client.close(); }
}, 30_000);

test("Postgres backfill refuses retire and normalize actions without custody", async () => {
  const retired = await fixture();
  try {
    await retired.client.query(`delete from takosumi_capsules where id = $1`, ["cap_one"]);
    const [report] = await inspectPostgresSourceOwnershipBackfill(retired.store,
      { sourceId: SRC, preparedAt: "2026-10-30T00:00:00.000Z" });
    expect(report).toMatchObject({ action: "retire", status: "refused" });
    expect(report?.custody).toContain("archive copy custody");
  } finally { await retired.client.close(); }

  const normalized = await fixture();
  try {
    await normalized.client.query(`update takosumi_sources
      set source_json = source_json || '{"ownerCapsuleId":"cap_one"}'::jsonb where id = $1`, [SRC]);
    await normalized.store.putSourceSnapshot({ id: "snap_foreign", origin: "git", workspaceId: WS,
      sourceId: SRC, url: "https://example.test/repo.git", ref: "main", path: ".",
      resolvedCommit: "a".repeat(40), archiveRef: "old-layout/foreign-source.tar.zst",
      archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 5,
      fetchedByRunId: "sync_foreign", fetchedAt: NOW });
    const [report] = await inspectPostgresSourceOwnershipBackfill(normalized.store,
      { sourceId: SRC, preparedAt: NOW });
    expect(report).toMatchObject({ action: "normalize", status: "refused" });
    expect(report?.custody).toContain("archive copy custody");
  } finally { await normalized.client.close(); }
}, 30_000);

test("Postgres backfill refuses a changed group and reports split or archive custody", async () => {
  const { client, store, addCapsule } = await fixture();
  try {
    const [reviewed] = await inspectPostgresSourceOwnershipBackfill(store, { sourceId: SRC, preparedAt: NOW });
    await client.query(`update takosumi_sources set source_json = jsonb_set(source_json, '{name}', '"changed"'::jsonb)
      where id = $1`, [SRC]);
    await expect(applyPostgresSourceOwnershipBackfill(store, reviewed!))
      .rejects.toThrow("source_ownership_backfill_review_digest_changed");
    await addCapsule("cap_two");
    const [split] = await inspectPostgresSourceOwnershipBackfill(store, { sourceId: SRC, preparedAt: NOW });
    expect(split).toMatchObject({ status: "refused", action: "split" });
    expect(split?.custody).toContain("archive copy custody");
  } finally { await client.close(); }
}, 30_000);

test("Postgres backfill refuses an archive copy even for one live owner", async () => {
  const { client, store } = await fixture();
  try {
    await store.putSourceSnapshot({ id: "snap_foreign", origin: "git", workspaceId: WS,
      sourceId: SRC, url: "https://example.test/repo.git", ref: "main", path: ".",
      resolvedCommit: "a".repeat(40), archiveRef: "old-layout/foreign-source.tar.zst",
      archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 5,
      fetchedByRunId: "sync_foreign", fetchedAt: NOW });
    const [report] = await inspectPostgresSourceOwnershipBackfill(store, { sourceId: SRC, preparedAt: NOW });
    expect(report).toMatchObject({ action: "backfill", status: "refused",
      reason: "archive_or_lineage_custody_required" });
    expect(report?.custody).toContain("archive copy custody");
    expect((await store.getSource(SRC))?.ownerCapsuleId).toBeUndefined();
  } finally { await client.close(); }
}, 30_000);
