import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { SqlClient, SqlParameters, SqlQueryResult, SqlTransaction } from "../../../../core/adapters/storage/sql.ts";
import {
  CapsuleApplyRunAdmissionConflictError,
  CapsulePlanCreationFenceConflictError,
  capsuleApplyRunAdmissionFence,
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema,
  verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { D1AppAuthorizationStore, SqlAppAuthorizationStore } from "../../../../core/domains/app-authorization/store.ts";
import type { AppAccessResolver } from "../../../../contract/app-access.ts";
import type { D1Like } from "../../../../core/adapters/storage/d1.ts";

setDefaultTimeout(30_000);
const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

type SetPhysicalAuthority = (capsule: Capsule) => Promise<void>;
async function stores(): Promise<readonly [string, OpenTofuControlStore, SetPhysicalAuthority][]> {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  const memory = new InMemoryOpenTofuControlStore();
  const d1 = new SqliteFakeD1();
  return [
    ["memory", memory, async (capsule) => { await memory.putCapsule(capsule); }],
    ["postgres", new SqlOpenTofuControlStore({ client }), async (capsule) => {
      await client.query(`update takosumi_capsules set owner_account_id=$2, ownership_epoch=$3,
        management_state=$4, management_epoch=$5 where id=$1`,
      [capsule.id, capsule.ownerAccountId ?? null, capsule.ownershipEpoch ?? 0,
        capsule.managementState ?? "active", capsule.managementEpoch ?? 0]);
    }],
    ["d1", new CloudflareD1OpenTofuControlStore(d1), async (capsule) => {
      await d1.prepare(`update capsules set owner_account_id=?, ownership_epoch=?,
        management_state=?, management_epoch=? where id=?`)
        .bind(capsule.ownerAccountId ?? null, capsule.ownershipEpoch ?? 0,
          capsule.managementState ?? "active", capsule.managementEpoch ?? 0, capsule.id).run();
    }],
  ];
}

function plan(capsule: Capsule, id: string, ownershipEpoch = 0, appManagementEpoch = 0): PlanRun {
  return {
    id, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    createdBy: "owner", ownershipEpoch, appManagementEpoch,
    source: { kind: "git", url: "https://git.example.test/app.git", commit: "0123456789abcdef0123456789abcdef01234567" },
    sourceDigest: "sha256:source", operation: "update", runnerProfileId: "runner",
    variablesDigest: "sha256:variables", executionInputsDigest: "sha256:inputs",
    requiredProviders: [], requiredProviderRequirements: [], status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy", auditEvents: [], createdAt: 1, updatedAt: 1,
  };
}

function apply(planRun: PlanRun, capsule: Capsule, id: string): ApplyRun {
  return {
    id, planRunId: planRun.id, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    operation: "update", runnerProfileId: "runner", status: "queued",
    expected: {
      planRunId: planRun.id, capsuleId: capsule.id, currentStateVersionId: capsule.currentStateVersionId ?? null,
      capsuleExecutionAuthorityEpoch: 1, runnerProfileId: "runner", sourceDigest: planRun.sourceDigest,
      variablesDigest: planRun.variablesDigest, policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan", planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "operator-managed", ref: "state" },
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [], createdAt: 1, updatedAt: 1,
  };
}

function workspaceAuthority(capsule: Capsule): WorkspaceManagementAuthority {
  return { workspaceId: capsule.workspaceId, managementState: "active", managementEpoch: 1 };
}

async function prepare(store: OpenTofuControlStore, run: PlanRun, authority: WorkspaceManagementAuthority) {
  return await store.preparePlanRun({ run, inputs: { planRunId: run.id, variables: {} },
    expectedWorkspaceManagementAuthority: authority });
}

async function claim(store: OpenTofuControlStore, run: PlanRun | ApplyRun,
  kind: "plan" | "apply", stale = false, heartbeatAt = 2) {
  return await store.transitionRun({
    id: run.id, kind, expectFrom: [stale ? "running" : "queued"],
    ...(stale ? { expectHeartbeatAt: run.heartbeatAt ?? null } : {}),
    setLeaseToken: `lease-${run.id}-${heartbeatAt}`, heartbeatAt,
    run: { ...run, status: "running", startedAt: run.startedAt ?? 1, heartbeatAt },
  });
}

test("owned app Run admission fences new Plan, Apply, queued claim, and drain ABA in every store", async () => {
  for (const [label, store, setPhysicalAuthority] of await stores()) {
    const { capsule: legacy } = await seedCapsuleModel(store, { capsuleId: `cap_app_run_${label}` });
    const authority = workspaceAuthority(legacy);
    const capsule: Capsule = { ...legacy, ownerAccountId: "owner", ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0 };
    await store.putCapsule(capsule);
    await expect(prepare(store, plan(capsule, `plan_owner_epoch_${label}`, 1, 0), authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    await expect(prepare(store, plan(capsule, `plan_management_epoch_${label}`, 0, 1), authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    const queued = plan(capsule, `plan_queued_${label}`);
    expect((await prepare(store, queued, authority)).status, label).toBe("created");
    const activePlan = plan(capsule, `plan_running_${label}`);
    await prepare(store, activePlan, authority);
    const claimed = await claim(store, activePlan, "plan");
    expect(claimed.won, label).toBe(true);
    const applyRow = apply(activePlan, capsule, `apply_queued_${label}`);
    expect((await store.beginApplyRun(applyRow, authority, capsuleApplyRunAdmissionFence(capsule, 1))).status, label)
      .toBe("created");
    const activeApply = apply(activePlan, capsule, `apply_running_${label}`);
    await store.beginApplyRun(activeApply, authority, capsuleApplyRunAdmissionFence(capsule, 1));
    const claimedApply = await claim(store, activeApply, "apply");
    expect(claimedApply.won, label).toBe(true);

    const draining: Capsule = { ...capsule, managementState: "draining", managementEpoch: 1 };
    await setPhysicalAuthority(draining);
    expect((await prepare(store, queued, authority)).status, label).toBe("existing");
    await expect(prepare(store, plan(capsule, `plan_drain_${label}`), authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    expect((await claim(store, queued, "plan")).won, label).toBe(false);
    expect((await claim(store, applyRow, "apply")).won, label).toBe(false);
    await expect(store.beginApplyRun(apply(queued, capsule, `apply_drain_${label}`), authority,
      capsuleApplyRunAdmissionFence(capsule, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    const continuation = await claim(store, claimed.run as PlanRun, "plan", true, 3);
    expect(continuation.won, label).toBe(true);
    const applyContinuation = await claim(store, claimedApply.run as ApplyRun, "apply", true, 3);
    expect(applyContinuation.won, label).toBe(true);
    const settled = { ...(continuation.run as PlanRun), status: "failed" as const, updatedAt: 4 };
    expect((await store.transitionRun({ id: settled.id, kind: "plan", expectFrom: ["running"],
      expectLeaseToken: `lease-${settled.id}-3`, clearLeaseToken: true, run: settled })).won, label).toBe(true);
    await setPhysicalAuthority({ ...draining, managementState: "frozen" });
    expect((await claim(store, applyContinuation.run as ApplyRun, "apply", true, 4)).won, label)
      .toBe(false);

    const resumed: Capsule = { ...capsule, managementEpoch: 2 };
    await setPhysicalAuthority(resumed);
    expect((await claim(store, queued, "plan")).won, label).toBe(false);
    await expect(store.beginApplyRun(apply(queued, resumed, `apply_aba_${label}`), authority,
      capsuleApplyRunAdmissionFence(resumed, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect((await prepare(store, plan(resumed, `plan_fresh_${label}`, 0, 2), authority)).status, label)
      .toBe("created");

    const transferred: Capsule = { ...resumed, ownerAccountId: "recipient", ownershipEpoch: 1,
      managementEpoch: 3 };
    await setPhysicalAuthority(transferred);
    expect((await claim(store, queued, "plan")).won, label).toBe(false);
    await expect(store.beginApplyRun(apply(queued, transferred, `apply_transfer_${label}`), authority,
      capsuleApplyRunAdmissionFence(transferred, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect((await claim(store, applyContinuation.run as ApplyRun, "apply", true, 4)).won, label)
      .toBe(false);
    // Losing the Capsule's owner tags must not turn a pinned Plan into a
    // legacy Plan that can be dispatched or applied.
    await store.putCapsule(legacy);
    expect((await claim(store, queued, "plan")).won, label).toBe(false);
    await expect(store.beginApplyRun(apply(queued, legacy, `apply_tags_lost_${label}`), authority,
      capsuleApplyRunAdmissionFence(legacy, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
  }
});

test("owned app incomplete metadata fails closed while legacy provider-free Plan apply remains valid", async () => {
  for (const [label, store] of await stores()) {
    const { capsule: legacy } = await seedCapsuleModel(store, { capsuleId: `cap_app_partial_${label}` });
    const authority = workspaceAuthority(legacy);
    const oldPlan = plan(legacy, `plan_legacy_${label}`);
    const { ownershipEpoch: _owner, appManagementEpoch: _management, ...legacyPlan } = oldPlan;
    await store.putPlanRun(legacyPlan);
    expect((await store.beginApplyRun(apply(legacyPlan, legacy, `apply_legacy_${label}`), authority,
      capsuleApplyRunAdmissionFence(legacy, 1))).status, label).toBe("created");
    await store.putCapsule({ ...legacy, ownerAccountId: "owner" });
    const { ownershipEpoch: _missingOwner, appManagementEpoch: _missingManagement,
      ...unpinned } = plan(legacy, `plan_partial_${label}`);
    await expect(prepare(store, unpinned, authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    await expect(store.beginApplyRun(apply(legacyPlan, legacy, `apply_partial_${label}`), authority,
      capsuleApplyRunAdmissionFence(legacy, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
  }
});

test("actual v77 transfer drains running work and refuses old Plan admission with physical authority", async () => {
  const access: AppAccessResolver = {
    async resolveAppAccess() { return undefined; },
    async listAccessibleApps() { return { apps: [] }; },
  };
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const d1 = new SqliteFakeD1();
  const cases = [
    ["postgres", new SqlOpenTofuControlStore({ client: pg }), new SqlAppAuthorizationStore(pg, access)],
    ["d1", new CloudflareD1OpenTofuControlStore(d1),
      new D1AppAuthorizationStore(d1 as unknown as D1Like, access)],
  ] as const;
  for (const [label, store, ownership] of cases) {
    const { capsule: legacy } = await seedCapsuleModel(store, { capsuleId: `cap_transfer_admission_${label}` });
    const capsule: Capsule = { ...legacy, ownerAccountId: "owner", ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0 };
    await store.putCapsule(capsule);
    const authority = workspaceAuthority(capsule);
    const runningPlan = plan(capsule, `plan_transfer_running_${label}`);
    await prepare(store, runningPlan, authority);
    const claimed = await claim(store, runningPlan, "plan");
    expect(claimed.won, label).toBe(true);
    const transfer = await ownership.createTransfer({ capsuleId: capsule.id,
      actorAccountId: "owner", toAccountId: "recipient", expectedOwnershipEpoch: 0 });
    expect((await ownership.acceptTransfer({ transferId: transfer.transferId,
      actorAccountId: "recipient" })).state, label).toBe("pending");
    const draining = (await store.getCapsule(capsule.id))!;
    expect(draining.managementState, label).toBe("draining");
    await expect(prepare(store, plan(capsule, `plan_transfer_drain_${label}`), authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    const continued = await claim(store, claimed.run as PlanRun, "plan", true, 3);
    expect(continued.won, label).toBe(true);
    const terminal = { ...(continued.run as PlanRun), status: "failed" as const, updatedAt: 4 };
    expect((await store.transitionRun({ id: terminal.id, kind: "plan", expectFrom: ["running"],
      expectLeaseToken: `lease-${terminal.id}-3`, clearLeaseToken: true, run: terminal })).won, label).toBe(true);
    expect((await ownership.acceptTransfer({ transferId: transfer.transferId,
      actorAccountId: "recipient" })).state, label).toBe("accepted");
    // A repair can leave the old JSON projection behind; the v77 physical
    // owner/epochs remain the authority for both reads and atomic admission.
    if (label === "postgres") {
      await pg.query(`update takosumi_capsules set installation_json=$2::jsonb where id=$1`,
        [capsule.id, JSON.stringify(capsule)]);
    } else {
      await d1.prepare(`update capsules set record_json=? where id=?`)
        .bind(JSON.stringify(capsule), capsule.id).run();
    }
    const transferred = (await store.getCapsule(capsule.id))!;
    expect(transferred.ownerAccountId, label).toBe("recipient");
    expect(transferred.ownershipEpoch, label).toBe(1);
    await expect(store.beginApplyRun(apply(runningPlan, transferred, `apply_transfer_old_${label}`),
      authority, capsuleApplyRunAdmissionFence(transferred, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect((await prepare(store, plan(transferred, `plan_transfer_new_${label}`,
      transferred.ownershipEpoch, transferred.managementEpoch), authority)).status, label).toBe("created");
  }
});

test("pre-v77 durable stores retain legacy Capsule Plan and Apply admission", async () => {
  const pg = await PGliteSqlClient.createThroughMigrationVersion(122);
  clients.push(pg);
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1, { throughMigrationVersion: 75 });
  await verifyD1OpenTofuLedgerSchemaPredeployed(d1);
  for (const [label, store] of [
    ["postgres-v122", new SqlOpenTofuControlStore({ client: pg })],
    ["d1-v75", new CloudflareD1OpenTofuControlStore(d1, { schemaMode: "predeployed" })],
  ] as const) {
    const { capsule } = await seedCapsuleModel(store, { capsuleId: `cap_legacy_${label}` });
    const authority = workspaceAuthority(capsule);
    const { ownershipEpoch: _owner, appManagementEpoch: _management, ...legacyPlan } =
      plan(capsule, `plan_legacy_${label}`);
    expect((await prepare(store, legacyPlan, authority)).status, label).toBe("created");
    const legacyApply = apply(legacyPlan, capsule, `apply_legacy_${label}`);
    expect((await store.beginApplyRun(legacyApply, authority,
      capsuleApplyRunAdmissionFence(capsule, 1))).status, label).toBe("created");
    expect((await claim(store, legacyPlan, "plan")).won, label).toBe(true);
    expect((await claim(store, legacyApply, "apply")).won, label).toBe(true);
  }
});

test("postgres current and pre-v77 SourceSync settlement lock Capsule before held Run", async () => {
  for (const version of ["current", "pre-v77"] as const) {
    const backing = version === "current" ? await PGliteSqlClient.create()
      : await PGliteSqlClient.createThroughMigrationVersion(122);
    clients.push(backing);
    const locks: string[] = [];
    const client: SqlClient = {
      query: (statement, parameters) => backing.query(statement, parameters),
      transaction: (fn) => backing.transaction(async (transaction) => {
        const proxy: SqlTransaction = {
          async query<Row extends Record<string, unknown>>(statement: string,
            parameters?: SqlParameters): Promise<SqlQueryResult<Row>> {
            const result = await transaction.query<Row>(statement, parameters);
            if (/\bfor update\b/iu.test(statement) && /\bfrom takosumi_capsules\b/iu.test(statement) && result.rows.length > 0) locks.push("capsules");
            if (/\bfor update\b/iu.test(statement) && /\bfrom takosumi_runs\b/iu.test(statement) && result.rows.length > 0) locks.push("runs");
            return result;
          },
          transaction: (nested) => nested(proxy),
        };
        return await fn(proxy);
      }),
    };
    const store = new SqlOpenTofuControlStore({ client });
    const workspaceId = "ws_source_lock_order";
    const sourceId = "src_source_lock_order";
    const runId = "sync_source_lock_order";
    const snapshotId = "snapshot_source_lock_order";
    const createdAt = "2026-10-01T00:00:00.000Z";
    const startedAt = "2026-10-01T00:00:01.000Z";
    const finishedAt = "2026-10-01T00:00:02.000Z";
    const { capsule } = await seedCapsuleModel(store, { workspaceId, sourceId,
      capsuleId: "cap_source_lock_order", sourceUrl: "https://example.test/source.git",
      withoutSnapshot: true });
    const queued: SourceSyncRun = { id: runId, kind: "source_sync", workspaceId, sourceId,
      url: "https://example.test/source.git", ref: "main", path: ".",
      archiveRef: `workspaces/${workspaceId}/sources/${sourceId}/snapshots/${snapshotId}/source.tar.zst`,
      intent: "observe", status: "queued", snapshotId, createdAt, updatedAt: createdAt };
    await store.beginSourceSyncRun(queued, { workspaceId, managementState: "active", managementEpoch: 1 });
    const running: SourceSyncRun = { ...queued, status: "running", startedAt, heartbeatAt: 1_000, updatedAt: startedAt };
    expect((await store.transitionRun({ id: runId, kind: "source_sync", expectFrom: ["queued"],
      run: running, setLeaseToken: "source-lock-lease", heartbeatAt: 1_000 })).won).toBe(true);
    const terminal: SourceSyncRun = { ...running, status: "succeeded", heartbeatAt: 2_000,
      finishedAt, updatedAt: finishedAt, resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
      archiveDigest: "sha256:source-lock", archiveSizeBytes: 1024 };
    const snapshot: SourceSnapshot = { id: snapshotId, origin: "git", workspaceId, sourceId,
      url: queued.url, ref: queued.ref, path: queued.path, archiveRef: queued.archiveRef,
      resolvedCommit: terminal.resolvedCommit!, archiveDigest: terminal.archiveDigest!,
      archiveSizeBytes: terminal.archiveSizeBytes!, repositoryInstallMetadata: { status: "absent" },
      repositoryManifest: { status: "absent" }, repositoryModules: { status: "ready", scopePath: ".", modules: [] },
      fetchedByRunId: runId, fetchedAt: finishedAt };
    locks.length = 0;
    expect((await store.commitSourceSyncSuccess({ terminalRun: terminal, leaseToken: "source-lock-lease", snapshot })).won).toBe(true);
    const firstCapsuleLock = locks.indexOf("capsules");
    const firstRunLock = locks.indexOf("runs");
    expect(firstCapsuleLock).toBeGreaterThanOrEqual(0);
    expect(firstRunLock).toBeGreaterThan(firstCapsuleLock);
    expect((await store.getCapsule(capsule.id))?.id).toBe(capsule.id);
  }
});

test("v77 D1 readiness refuses a missing transfer table or index", async () => {
  for (const statement of [
    `drop table capsule_ownership_transfers`,
    `drop index capsule_ownership_transfers_one_pending`,
    `drop index capsule_ownership_transfers_recipient`,
  ]) {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    await verifyD1OpenTofuLedgerSchemaPredeployed(db);
    await db.prepare(statement).run();
    await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db)).rejects.toThrow(/verification failed/);
  }
});
