import { afterEach, expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { convergeOwnedSourceLane } from "../../../../core/domains/sources/owned-lane.ts";
import {
  VERIFIED_RECOVERY_ARTIFACT_FORMAT,
  stateVersionIdForRecoveryRun,
  type CommitRecoveredStateInput,
} from "../../../../core/domains/deploy-control/operator_state_recovery.ts";
import { type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient, splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const NOW = "2026-10-29T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}` as const;
const ENCRYPTED = `sha256:${"b".repeat(64)}` as const;
const EVIDENCE = `sha256:${"c".repeat(64)}` as const;
const pgClients: PGliteSqlClient[] = [];
afterEach(async () => { await Promise.all(pgClients.splice(0).map((client) => client.close())); });

async function installInactiveMaintenanceTable(db: SqliteFakeD1) {
  await db.exec(`create table _takosumi_control_schema_maintenance (
    singleton integer primary key, active integer not null, migration_bypass integer not null,
    fence_id text not null, source_commit text not null, manifest_digest text not null,
    environment text not null, activated_at text not null, released_at text,
    database_role text not null, release_policy text not null, database_id text,
    source_export_sha256 text, predecessor_fence_id text,
    predecessor_source_commit text, predecessor_manifest_digest text,
    release_readiness_digest text
  )`);
  await db.prepare(`insert into _takosumi_control_schema_maintenance
    (singleton,active,migration_bypass,fence_id,source_commit,manifest_digest,
      environment,activated_at,released_at,database_role,release_policy)
    values (1,0,0,?,?,?,?,?,?,?,?)`).bind(
      DIGEST, "a".repeat(40), DIGEST, "test", NOW, NOW, "legacy", "never",
    ).run();
}

async function seedRawCapsule(store: OpenTofuControlStore, label: string, legacy = false) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `ws_${label}`, sourceId: `src_${label}`, snapshotId: `snap_${label}`,
    installConfigId: `cfg_${label}`, capsuleId: `cap_${label}`,
  });
  const capsule: Capsule = legacy
    ? { ...seeded.capsule, status: "stale" }
    : { ...seeded.capsule, status: "stale", ownerAccountId: "user_test",
      ownershipEpoch: 3, managementState: "active", managementEpoch: 4,
      storageRoot: `apps/${seeded.capsule.id}` };
  await store.putCapsule(capsule);
  return { ...seeded, capsule };
}

async function assertRawAndLane(
  store: OpenTofuControlStore,
  label: string,
  readRaw: (id: string) => Promise<Capsule>,
  legacyBackfill?: (id: string) => Promise<void>,
) {
  const seeded = await seedRawCapsule(store, label, legacyBackfill !== undefined);
  const { capsule, source, snapshot } = seeded;
  if (legacyBackfill) await legacyBackfill(capsule.id);
  expect(JSON.stringify(await store.getCapsule(capsule.id)), `${label}:get`)
    .toBe(JSON.stringify(await readRaw(capsule.id)));
  expect(await store.getCapsulesByIds([capsule.id]), `${label}:batch`).toEqual([await readRaw(capsule.id)]);
  await store.putStateVersion({
    id: `state_${label}`, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    environment: capsule.environment, generation: 1, stateRef: `state/${label}`,
    digest: DIGEST, createdByRunId: `apply_${label}`, createdAt: NOW,
  });
  await store.putPlanRun({
    id: `plan_${label}`, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    source: { kind: "git", url: snapshot.url, commit: snapshot.resolvedCommit },
    sourceDigest: DIGEST, operation: "create", runnerProfileId: "opentofu-default",
    variablesDigest: DIGEST, requiredProviders: [], status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 }, policyDecisionDigest: DIGEST,
    sourceSnapshotId: snapshot.id, auditEvents: [], createdAt: 1, updatedAt: 1,
  });
  await store.putApplyRun({
    id: `apply_${label}`, planRunId: `plan_${label}`, workspaceId: capsule.workspaceId,
    capsuleId: capsule.id, operation: "create", runnerProfileId: "opentofu-default",
    status: "succeeded", stateVersionId: `state_${label}`, expected: {
      planRunId: `plan_${label}`, capsuleId: capsule.id,
      currentStateVersionId: null, runnerProfileId: "opentofu-default",
      sourceDigest: DIGEST, variablesDigest: DIGEST, policyDecisionDigest: DIGEST,
    },
    stateBackend: { kind: "operator-managed", ref: "opaque" },
    stateLock: { status: "recorded", backendRef: "opaque" },
    auditEvents: [], createdAt: 2, updatedAt: 3,
  });
  const applied = { ...capsule, currentStateVersionId: `state_${label}`, currentStateGeneration: 1 };
  await store.putCapsule(applied);
  const original = await store.getSource(source.id);
  if (!original) throw new Error("missing Source");
  const moved = { ...original, defaultRef: "moved", defaultPath: "other", ownerCapsuleId: capsule.id };
  await store.putSource(moved);
  const converged = await convergeOwnedSourceLane(store, source.id);
  expect(converged?.defaultRef, `${label}:ref`).toBe(snapshot.ref);
  expect(converged?.defaultPath, `${label}:path`).toBe(snapshot.path);
}

async function assertRecovery(
  store: OpenTofuControlStore,
  label: string,
  prepareCapsule?: (capsule: Capsule) => Promise<void>,
) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `ws_recovery_${label}`, sourceId: `src_recovery_${label}`,
    snapshotId: `snap_recovery_${label}`, installConfigId: `cfg_recovery_${label}`,
    capsuleId: `cap_recovery_${label}`,
  });
  const { capsule, source, snapshot, installConfig, workspace } = seeded;
  if (prepareCapsule) await prepareCapsule(capsule);
  const epoch = await store.getCapsuleExecutionAuthorityEpoch(capsule.id);
  if (epoch === undefined) throw new Error("missing Capsule execution epoch");
  const plan: PlanRun = {
    id: `plan_recovery_${label}`, workspaceId: workspace.id, capsuleId: capsule.id,
    capsuleCurrentStateVersionId: null, capsuleExecutionAuthorityEpoch: epoch,
    capsuleContext: { workspaceId: workspace.id, capsuleId: capsule.id, environment: capsule.environment },
    source: { kind: "git", url: snapshot.url, commit: snapshot.resolvedCommit },
    sourceDigest: DIGEST, operation: "create", runnerProfileId: "opentofu-default",
    variablesDigest: DIGEST, executionInputsDigest: DIGEST, requiredProviders: [],
    status: "succeeded", policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: DIGEST, planDigest: DIGEST,
    planArtifact: { kind: "object-storage", ref: "opaque_plan_artifact", digest: DIGEST },
    sourceSnapshotId: snapshot.id, baseStateGeneration: 0,
    appliedApplyRunId: `apply_recovery_${label}`,
    planResourceChanges: [{ address: "example_resource.a", type: "example_resource", actions: ["create"] }],
    auditEvents: [], createdAt: 1, updatedAt: 1,
  };
  const apply: ApplyRun = {
    id: `apply_recovery_${label}`, planRunId: plan.id, workspaceId: workspace.id,
    capsuleId: capsule.id, operation: "create", runnerProfileId: plan.runnerProfileId,
    status: "failed", expected: {
      planRunId: plan.id, capsuleId: capsule.id, currentStateVersionId: null,
      capsuleExecutionAuthorityEpoch: epoch, runnerProfileId: plan.runnerProfileId,
      sourceDigest: DIGEST, variablesDigest: DIGEST, policyDecisionDigest: DIGEST,
      planDigest: DIGEST, planArtifactDigest: DIGEST,
    },
    stateBackend: { kind: "operator-managed", ref: "opaque_backend" },
    stateLock: { status: "recorded", backendRef: "opaque_backend" },
    auditEvents: [{ id: `event_${label}`, type: "apply.failed", at: 2, data: { providerDispatched: true } }],
    createdAt: 2, updatedAt: 3, finishedAt: 3,
  };
  await store.putPlanRun(plan);
  await store.putApplyRun(apply);
  const expectedCapsule = await store.patchCapsule(capsule.id,
    { status: "error", updatedAt: NOW },
    { currentStateVersionId: undefined, status: "pending" });
  if (!expectedCapsule) throw new Error("missing error Capsule");
  const recoveryId = `recovery_${label}`;
  const stateId = await stateVersionIdForRecoveryRun(recoveryId);
  const activityDigest = await stableJsonDigest({ kind: "takosumi.state-recovery-activity-id@v1", runId: recoveryId });
  const artifact = {
    format: VERIFIED_RECOVERY_ARTIFACT_FORMAT, immutable: true, adapterAllocated: true,
    readbackVerified: true, workspaceId: workspace.id, capsuleId: capsule.id,
    environment: capsule.environment, generation: 1, recoveryRunId: recoveryId,
    stateRef: `workspaces/${workspace.id}/state-versions/00000001.tfstate.enc`,
    encryptedDigest: ENCRYPTED, plaintextSha256: DIGEST, evidenceDigest: EVIDENCE,
  } as const;
  const run: Run = {
    id: recoveryId, workspaceId: workspace.id, capsuleId: capsule.id,
    environment: capsule.environment, planRunId: plan.id, sourceSnapshotId: snapshot.id,
    type: "state_recovery", status: "succeeded", createdBy: "operator_test",
    createdAt: NOW, startedAt: NOW, finishedAt: NOW,
    stateRecovery: {
      failedApplyRunId: apply.id, recoveredStateVersionId: stateId,
      sourceSnapshotId: snapshot.id, artifactEvidenceDigest: EVIDENCE,
      plaintextSha256: DIGEST, encryptedDigest: ENCRYPTED,
    },
  };
  const command: CommitRecoveredStateInput = {
    expectedCapsule, expectedInstallConfig: installConfig, expectedSource: source,
    expectedSourceSnapshot: snapshot, expectedPlanRun: plan, expectedFailedApplyRun: apply,
    expectedWorkspaceManagement: { workspaceId: workspace.id, managementState: "active", managementEpoch: 1 },
    expectedExecutionAuthorityEpoch: epoch, artifact, recoveryRun: run,
    stateVersion: {
      id: stateId, workspaceId: workspace.id, capsuleId: capsule.id,
      environment: capsule.environment, generation: 1, stateRef: artifact.stateRef,
      digest: DIGEST, createdByRunId: recoveryId, createdAt: NOW,
    },
    activity: {
      id: `activity_${activityDigest.slice("sha256:".length)}`, workspaceId: workspace.id,
      actorId: run.createdBy, action: "capsule.state_recovered", targetType: "capsule",
      targetId: capsule.id, runId: recoveryId, createdAt: NOW,
      metadata: { failedApplyRunId: apply.id, stateVersionId: stateId,
        sourceSnapshotId: snapshot.id, artifactEvidenceDigest: EVIDENCE },
    },
  };
  const result = await store.commitRecoveredState(command);
  expect(result.status, `${label}:commit`).toBe("committed");
  expect((await store.getCapsule(capsule.id))?.currentStateVersionId, `${label}:cursor`).toBe(stateId);
  expect((await store.commitRecoveredState(command)).status, `${label}:replay`).toBe("replayed");
}

for (const version of [75, 76, 77] as const) {
  test(`D1 v${version}: Capsule reads preserve stored JSON and owned Source CAS converges`, async () => {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: version });
    await installInactiveMaintenanceTable(db);
    const store = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    await assertRawAndLane(store, `d1_${version}`, async (id) => {
      const row = await db.prepare("select record_json from capsules where id=?").bind(id)
        .first<{ record_json: string }>();
      if (!row) throw new Error("missing raw Capsule");
      return JSON.parse(row.record_json) as Capsule;
    });
    await assertRecovery(store, `d1_${version}`, async (capsule) => {
      if (version !== 77) return;
      await store.putCapsule({ ...capsule, ownerAccountId: "user_test", ownershipEpoch: 3,
        managementState: "active", managementEpoch: 4, storageRoot: `apps/${capsule.id}` });
    });
    const head = await db.prepare("select max(version) as version from schema_migrations")
      .first<{ version: number }>();
    expect(head?.version, `d1_${version}:migration head`).toBe(version);
  });
}

test("Postgres v122 legacy rows and v123 new rows preserve Capsule CAS after migration-first upgrade", async () => {
  const pg = await PGliteSqlClient.createThroughMigrationVersion(122);
  pgClients.push(pg);
  // v122 writes and v123 runtime are separate phases: the current runtime maps
  // expanded columns and must only be opened after the catalog is expanded.
  const legacy: Capsule = {
    id: "cap_pg_legacy", workspaceId: "ws_pg_legacy", projectId: "prj_pg_legacy",
    name: "legacy", slug: "legacy", sourceId: "src_pg_legacy",
    installConfigId: "cfg_pg_legacy", environment: "production",
    currentStateGeneration: 0, status: "pending", createdAt: NOW, updatedAt: NOW,
  };
  await pg.query(`insert into takosumi_capsules
    (id, space_id, project_id, name, environment, source_id, install_config_id,
      current_state_version_id, status, installation_json, created_at, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7,null,$8,$9::jsonb,$10,$11)`, [
    legacy.id, legacy.workspaceId, legacy.projectId, legacy.name, legacy.environment,
    legacy.sourceId, legacy.installConfigId, legacy.status, JSON.stringify(legacy), NOW, NOW,
  ]);
  const migration = postgresStorageMigrationStatements.find((item) => item.version === 123);
  expect(migration?.id).toBe("deploy.app_ownership.expand");
  for (const statement of splitSqlStatements(migration!.sql)) await pg.query(statement);
  const store = new SqlOpenTofuControlStore({ client: pg });
  expect(await store.getCapsule(legacy.id)).toEqual(legacy);
  await assertRawAndLane(store, "pg_new", async (id) => {
    const result = await pg.query<{ installation_json: Capsule }>(
      "select installation_json from takosumi_capsules where id=$1", [id]);
    return result.rows[0]!.installation_json;
  });
  await assertRecovery(store, "pg_new", async (capsule) => {
    await store.putCapsule({ ...capsule, ownerAccountId: "user_test", ownershipEpoch: 3,
      managementState: "active", managementEpoch: 4, storageRoot: `apps/${capsule.id}` });
  });
});

test("physical-only backfill keeps raw Capsule CAS valid for D1 and Postgres", async () => {
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1, { throughMigrationVersion: 77 });
  await installInactiveMaintenanceTable(d1);
  const d1Store = new CloudflareD1OpenTofuControlStore(d1, { schemaMode: "predeployed" });
  await assertRawAndLane(d1Store, "d1_backfill", async (id) => {
    const row = await d1.prepare("select record_json from capsules where id=?").bind(id)
      .first<{ record_json: string }>();
    return JSON.parse(row!.record_json) as Capsule;
  }, async (id) => {
    await d1.prepare(`update capsules set owner_account_id=?, ownership_epoch=3,
      management_state='active',management_epoch=4,storage_root=? where id=?`)
      .bind("user_test", `apps/${id}`, id).run();
  });
  await assertRecovery(d1Store, "d1_backfill", async (capsule) => {
    await d1.prepare(`update capsules set owner_account_id=?, ownership_epoch=3,
      management_state='active',management_epoch=4,storage_root=? where id=?`)
      .bind("user_test", `apps/${capsule.id}`, capsule.id).run();
    const raw = await d1.prepare("select record_json from capsules where id=?").bind(capsule.id)
      .first<{ record_json: string }>();
    expect(JSON.stringify(await d1Store.getCapsule(capsule.id))).toBe(raw!.record_json);
  });

  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const pgStore = new SqlOpenTofuControlStore({ client: pg });
  await assertRawAndLane(pgStore, "pg_backfill", async (id) => {
    const row = await pg.query<{ installation_json: Capsule }>(
      "select installation_json from takosumi_capsules where id=$1", [id]);
    return row.rows[0]!.installation_json;
  }, async (id) => {
    await pg.query(`update takosumi_capsules set owner_account_id=$1,
      ownership_epoch=3, management_state='active',management_epoch=4,storage_root=$2 where id=$3`,
      ["user_test", `apps/${id}`, id]);
  });
  await assertRecovery(pgStore, "pg_backfill", async (capsule) => {
    await pg.query(`update takosumi_capsules set owner_account_id=$1,
      ownership_epoch=3, management_state='active',management_epoch=4,storage_root=$2 where id=$3`,
      ["user_test", `apps/${capsule.id}`, capsule.id]);
    const raw = await pg.query<{ installation_json: Capsule }>(
      "select installation_json from takosumi_capsules where id=$1", [capsule.id]);
    expect(await pgStore.getCapsule(capsule.id)).toEqual(raw.rows[0]!.installation_json);
  });
});
