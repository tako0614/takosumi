import { afterEach, expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  recoverFailedInitialCreateState,
  recoveryPlanForStateVersion,
  VERIFIED_RECOVERY_ARTIFACT_FORMAT,
  type CommitRecoveredStateInput,
  type VerifiedRecoveryArtifact,
} from "../../../../core/domains/deploy-control/operator_state_recovery.ts";
import { getCapsuleAdoptedSourceSnapshot } from "../../../../core/domains/deploy-control/capsule_source_revision.ts";
import { getCurrentResourceInventory } from "../../../../core/domains/deploy-control/current_resource_inventory.ts";
import { RunQueryService } from "../../../../core/domains/deploy-control/run_query.ts";
import {
  InMemoryOpenTofuControlStore,
  capsuleApplyRunAdmissionFence,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type { D1PreparedStatement, D1Result } from "../../../../worker/src/bindings.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import {
  D1_MAX_BOUND_PARAMS,
  SqliteFakeD1,
} from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

class MutateBeforeNextD1Batch extends SqliteFakeD1 {
  beforeNextBatch: (() => Promise<void>) | undefined;

  override async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const mutate = this.beforeNextBatch;
    this.beforeNextBatch = undefined;
    if (mutate) await mutate();
    return await super.batch<T>(statements);
  }
}

class CountD1Bindings extends SqliteFakeD1 {
  readonly boundCounts: number[] = [];

  override prepare(query: string): D1PreparedStatement {
    const statement = super.prepare(query);
    return {
      bind: (...values) => {
        this.boundCounts.push(values.length);
        return statement.bind(...values);
      },
      first: <T>() => statement.first<T>(),
      all: <T>() => statement.all<T>(),
      run: <T>() => statement.run<T>(),
    };
  }
}

const NOW = "2026-06-07T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}` as const;
const ENCRYPTED = `sha256:${"b".repeat(64)}` as const;
const EVIDENCE = `sha256:${"c".repeat(64)}` as const;
const ARTIFACT_BASE = {
  format: VERIFIED_RECOVERY_ARTIFACT_FORMAT,
  immutable: true,
  adapterAllocated: true,
  readbackVerified: true,
  generation: 1,
  stateRef: "workspaces/fixture/state-versions/00000001.tfstate.enc",
  encryptedDigest: ENCRYPTED,
  plaintextSha256: DIGEST,
  evidenceDigest: EVIDENCE,
} as const;
const clients: PGliteSqlClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

async function fixture(
  store: OpenTofuControlStore,
  label: string,
  admitted = false,
): Promise<CommitRecoveredStateInput> {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `ws_recovery_${label}`, capsuleId: `cap_recovery_${label}`,
    sourceId: `src_recovery_${label}`,
    snapshotId: `snap_recovery_${label}`,
    installConfigId: `cfg_recovery_${label}`,
  });
  const epoch = await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id);
  if (epoch === undefined) throw new Error("missing fixture execution epoch");
  const plan: PlanRun = {
    id: `plan_recovery_${label}`, workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id, capsuleCurrentStateVersionId: null,
    capsuleExecutionAuthorityEpoch: epoch,
    capsuleContext: { workspaceId: seeded.workspace.id, capsuleId: seeded.capsule.id, environment: seeded.capsule.environment },
    source: { kind: "git", url: seeded.snapshot.url, commit: seeded.snapshot.resolvedCommit },
    sourceDigest: DIGEST, operation: "create", runnerProfileId: "opentofu-default",
    variablesDigest: DIGEST, executionInputsDigest: DIGEST,
    requiredProviders: [], status: admitted ? "queued" : "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 }, policyDecisionDigest: DIGEST,
    planDigest: DIGEST, planArtifact: { kind: "object-storage", ref: "opaque_plan_artifact", digest: DIGEST },
    sourceSnapshotId: seeded.snapshot.id,
    baseStateGeneration: 0,
    ...(admitted ? {} : { appliedApplyRunId: `apply_recovery_${label}` }),
    planResourceChanges: [{ address: "example_resource.a", type: "example_resource", actions: ["create"] }],
    auditEvents: [], createdAt: 1, updatedAt: 1,
  };
  const failed: ApplyRun = {
    id: `apply_recovery_${label}`, planRunId: plan.id, workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id, operation: "create", runnerProfileId: plan.runnerProfileId,
    status: admitted ? "queued" : "failed", expected: {
      planRunId: plan.id, capsuleId: seeded.capsule.id, currentStateVersionId: null,
      capsuleExecutionAuthorityEpoch: epoch, runnerProfileId: plan.runnerProfileId,
      sourceDigest: plan.sourceDigest, variablesDigest: plan.variablesDigest,
      policyDecisionDigest: plan.policyDecisionDigest, planDigest: DIGEST,
      planArtifactDigest: DIGEST,
    },
    stateBackend: { kind: "operator-managed", ref: "opaque_backend" },
    stateLock: { status: admitted ? "pending" : "recorded", backendRef: "opaque_backend" },
    auditEvents: admitted ? [] : [
      { id: `event_${label}`, type: "apply.failed", at: 2, data: { providerDispatched: true } },
    ],
    createdAt: 2, updatedAt: admitted ? 2 : 3,
    ...(!admitted ? { finishedAt: 3 } : {}),
  };
  let expectedPlan = plan;
  let expectedFailedApply = failed;
  if (admitted) {
    const authority = await store.getWorkspaceManagement(seeded.workspace.id);
    if (!authority || authority.managementState !== "active") {
      throw new Error("missing active fixture Workspace authority");
    }
    const prepared = await store.preparePlanRun({
      run: plan,
      inputs: { planRunId: plan.id, variables: {} },
      expectedWorkspaceManagementAuthority: authority,
    });
    if (prepared.status !== "created") throw new Error("fixture Plan admission conflicted");
    const succeededPlan = { ...plan, status: "succeeded" as const, updatedAt: 3 };
    const planTransition = await store.transitionRun({
      id: plan.id, kind: "plan", expectFrom: ["queued"], run: succeededPlan,
    });
    if (!planTransition.won) throw new Error("fixture Plan did not settle");
    const applyAdmission = await store.beginApplyRun(
      failed,
      authority,
      capsuleApplyRunAdmissionFence(seeded.capsule, epoch),
    );
    if (applyAdmission.status !== "created") throw new Error("fixture Apply admission conflicted");
    const failedApply: ApplyRun = {
      ...failed,
      status: "failed",
      stateLock: { status: "recorded", backendRef: "opaque_backend" },
      auditEvents: [{ id: `event_${label}`, type: "apply.failed", at: 2, data: { providerDispatched: true } }],
      updatedAt: 3,
      startedAt: 2,
      finishedAt: 3,
    };
    const applyTransition = await store.transitionRun({
      id: failed.id, kind: "apply", expectFrom: ["queued"], run: failedApply,
    });
    if (!applyTransition.won) throw new Error("fixture Apply did not settle");
    expectedPlan = (await store.getPlanRun(plan.id))!;
    expectedFailedApply = (await store.getApplyRun(failed.id))!;
  } else {
    await store.putPlanRun(plan);
    await store.putApplyRun(failed);
  }
  const capsule = await store.patchCapsule(seeded.capsule.id, { status: "error", updatedAt: NOW },
    { currentStateVersionId: undefined, status: "pending" });
  if (!capsule) throw new Error("missing fixture Capsule");
  const stateIdDigest = await stableJsonDigest({ kind: "takosumi.state-recovery-state-version-id@v1", runId: `recovery_${label}` });
  const stateVersionId = `state_${stateIdDigest.slice("sha256:".length)}`;
  const activityIdDigest = await stableJsonDigest({ kind: "takosumi.state-recovery-activity-id@v1", runId: `recovery_${label}` });
  const artifact: VerifiedRecoveryArtifact = {
    ...ARTIFACT_BASE,
    workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    environment: capsule.environment, recoveryRunId: `recovery_${label}`,
  };
  const run: Run = {
    id: `recovery_${label}`, workspaceId: seeded.workspace.id,
    capsuleId: capsule.id, environment: capsule.environment,
    planRunId: plan.id, sourceSnapshotId: seeded.snapshot.id,
    type: "state_recovery", status: "succeeded", createdBy: "operator_test",
    createdAt: NOW, startedAt: NOW, finishedAt: NOW,
    stateRecovery: {
      failedApplyRunId: failed.id, recoveredStateVersionId: stateVersionId,
      sourceSnapshotId: seeded.snapshot.id,
      artifactEvidenceDigest: EVIDENCE, plaintextSha256: DIGEST, encryptedDigest: ENCRYPTED,
    },
  };
  return {
    expectedCapsule: capsule, expectedInstallConfig: seeded.installConfig,
    expectedSource: seeded.source, expectedSourceSnapshot: seeded.snapshot,
    expectedPlanRun: expectedPlan, expectedFailedApplyRun: expectedFailedApply,
    expectedWorkspaceManagement: { workspaceId: seeded.workspace.id, managementState: "active", managementEpoch: 1 },
    expectedExecutionAuthorityEpoch: epoch, artifact, recoveryRun: run,
    activity: {
      id: `activity_${activityIdDigest.slice("sha256:".length)}`,
      workspaceId: capsule.workspaceId, actorId: run.createdBy,
      action: "capsule.state_recovered", targetType: "capsule", targetId: capsule.id,
      runId: run.id, createdAt: NOW,
      metadata: {
        failedApplyRunId: failed.id, stateVersionId, sourceSnapshotId: seeded.snapshot.id,
        artifactEvidenceDigest: EVIDENCE,
      },
    },
    stateVersion: {
      id: stateVersionId, workspaceId: seeded.workspace.id, capsuleId: capsule.id,
      environment: capsule.environment, generation: 1, stateRef: artifact.stateRef,
      digest: DIGEST, createdByRunId: run.id, createdAt: NOW,
    },
  };
}

test("state-only recovery commits and exact-replays on all stores without a false Output or inventory", async () => {
  for (const [label, store] of await stores()) {
    const command = await fixture(store, label);
    const committed = await store.commitRecoveredState(command);
    expect(committed.status, label).toBe("committed");
    expect((await store.getStateVersion(command.stateVersion.id))?.createdByRunId, label).toBe(command.recoveryRun.id);
    expect((await store.getCapsule(command.expectedCapsule.id))?.currentOutputId, label).toBeUndefined();
    expect(await store.getCapsuleExecutionAuthorityEpoch(command.expectedCapsule.id), label).toBe(command.expectedExecutionAuthorityEpoch + 1);
    expect((await store.getStateRecoveryRun(command.recoveryRun.id))?.stateRecovery, label).toEqual(command.recoveryRun.stateRecovery);
    expect((await store.commitRecoveredState(command)).status, label).toBe("replayed");
    const adopted = await getCapsuleAdoptedSourceSnapshot(store, committed.capsule);
    expect(adopted?.id, label).toBe(command.expectedSourceSnapshot.id);
    expect((await recoveryPlanForStateVersion(store, committed.capsule, command.stateVersion))?.id, label)
      .toBe(command.expectedPlanRun.id);
    const inventory = await getCurrentResourceInventory(store, command.expectedCapsule.id);
    expect(inventory.inventory.availability, label).toBe("recovery_unknown");
    expect("resources" in inventory.inventory, label).toBe(false);
    expect(await store.listActivityEvents(command.expectedCapsule.workspaceId), label)
      .toContainEqual(command.activity);
    const runQuery = new RunQueryService(store);
    expect((await runQuery.getRun(command.recoveryRun.id)).stateRecovery, label)
      .toEqual(command.recoveryRun.stateRecovery);
    expect(await runQuery.getRunLogs(command.recoveryRun.id), label).toEqual({
      diagnostics: [], auditEvents: [], credentialMints: [],
    });
  }
});

test("recovery commit rejects a noncanonical StateVersion id despite matching backlinks", async () => {
  for (const [label, store] of await stores()) {
    const command = await fixture(store, `noncanonical_state_id_${label}`);
    const id = `state_noncanonical_${label}`;
    const changed: CommitRecoveredStateInput = {
      ...command,
      stateVersion: { ...command.stateVersion, id },
      recoveryRun: {
        ...command.recoveryRun,
        stateRecovery: {
          ...command.recoveryRun.stateRecovery!,
          recoveredStateVersionId: id,
        },
      },
      activity: {
        ...command.activity,
        metadata: { ...command.activity.metadata, stateVersionId: id },
      },
    };
    await expect(store.commitRecoveredState(changed), label).rejects.toThrow();
    expect(await store.getStateVersion(id), `${label}:state`).toBeUndefined();
    expect(await store.getStateRecoveryRun(command.recoveryRun.id), `${label}:run`).toBeUndefined();
    expect(await store.listActivityEvents(command.expectedCapsule.workspaceId), `${label}:activity`)
      .not.toContainEqual(changed.activity);
  }
});

test("recovery provenance rejects a Plan backlink changed after commit", async () => {
  for (const [label, store] of await stores()) {
    const command = await fixture(store, `changed_plan_backlink_${label}`);
    const committed = await store.commitRecoveredState(command);
    expect(committed.status, label).toBe("committed");
    const capsule = await store.getCapsule(command.expectedCapsule.id);
    if (!capsule) throw new Error("missing recovered Capsule");
    await store.putPlanRun({
      ...command.expectedPlanRun,
      appliedApplyRunId: `other_apply_${label}`,
    });
    expect(await recoveryPlanForStateVersion(store, capsule, command.stateVersion), label)
      .toBeUndefined();
  }
});

test("recovery producer accepts runs admitted with private Workspace authority on all stores", async () => {
  for (const [label, store] of await stores()) {
    const command = await fixture(store, `admitted_${label}`, true);
    for (const run of [command.expectedPlanRun, command.expectedFailedApplyRun]) {
      const kind = run === command.expectedPlanRun ? "plan" : "apply";
      expect(Object.hasOwn(run, "workspaceManagementAuthority"), `${label}:${kind}:public`)
        .toBe(false);
      expect(await store.getRunManagementAuthority({
        id: run.id, workspaceId: run.workspaceId, kind,
      }), `${label}:${kind}:stored`).toEqual({
        workspaceId: run.workspaceId, managementState: "active", managementEpoch: 1,
      });
    }
    const result = await recoverFailedInitialCreateState({
      store,
      verifier: { verify: async () => command.artifact },
      artifactHandle: "opaque_handle",
      failedApplyRunId: command.expectedFailedApplyRun.id,
      recoveryRunId: command.recoveryRun.id,
      createdBy: "operator_test",
      now: NOW,
    });
    expect(result.status, label).toBe("committed");
  }
});

test("D1 recovery guard binds the complete observed authority JSON snapshots", async () => {
  for (const target of ["config", "plan", "apply"] as const) {
    const d1 = new MutateBeforeNextD1Batch();
    const store = new CloudflareD1OpenTofuControlStore(d1);
    const command = await fixture(store, `d1_authority_race_${target}`, true);
    d1.beforeNextBatch = async () => {
      if (target === "config") {
        await d1.prepare(
          "update install_configs set record_json = json_set(record_json, '$.workspaceManagementAuthority.managementEpoch', 2) where id = ?",
        ).bind(command.expectedInstallConfig.id).run();
      } else {
        await d1.prepare(
          "update runs set run_json = json_set(run_json, '$.workspaceManagementAuthority.managementEpoch', 2) where id = ?",
        ).bind(target === "plan" ? command.expectedPlanRun.id : command.expectedFailedApplyRun.id).run();
      }
    };
    expect((await store.commitRecoveredState(command)).status, target).toBe("conflict");
    expect(await store.getStateRecoveryRun(command.recoveryRun.id), target).toBeUndefined();
    expect(await store.getStateVersion(command.stateVersion.id), target).toBeUndefined();
  }
});

test("Postgres and D1 recovery reject physical Run identity, status, kind, and lease drift", async () => {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  const pgStore = new SqlOpenTofuControlStore({ client });
  const d1 = new SqliteFakeD1();
  const d1Store = new CloudflareD1OpenTofuControlStore(d1);
  const adapters = [
    {
      label: "postgres",
      store: pgStore,
      update: async (target: "plan" | "apply", field: string, id: string, otherId: string) => {
        const table = "takosumi_runs";
        if (field === "status") {
          await client.query(`update ${table} set status = 'running' where id = $1`, [id]);
        } else if (field === "scope") {
          await client.query(`update ${table} set space_id = $1 where id = $2`, [otherId, id]);
        } else if (field === "capsule") {
          await client.query(`update ${table} set installation_id = $1 where id = $2`, [otherId, id]);
        } else if (field === "kind") {
          await client.query(`update ${table} set kind = $1 where id = $2`, [target === "plan" ? "apply" : "plan", id]);
        } else {
          await client.query(`update ${table} set lease_token = 'active-lease' where id = $1`, [id]);
        }
      },
    },
    {
      label: "d1",
      store: d1Store,
      update: async (target: "plan" | "apply", field: string, id: string, otherId: string) => {
        const column = field === "scope" ? "space_id" : field === "capsule" ? "installation_id"
          : field === "kind" ? "type"
          : field === "lease" ? "lease_token" : "status";
        const value = field === "status" ? "running" : field === "scope" || field === "capsule" ? otherId
          : field === "kind" ? target === "plan" ? "apply" : "plan" : "active-lease";
        await d1.prepare(`update runs set ${column} = ? where id = ?`).bind(value, id).run();
      },
    },
  ];
  for (const adapter of adapters) {
    for (const target of ["plan", "apply"] as const) {
      for (const field of ["status", "scope", "capsule", "kind", "lease"] as const) {
        const command = await fixture(adapter.store, `physical_${adapter.label}_${target}_${field}`);
        const other = field === "scope" || field === "capsule"
          ? await fixture(adapter.store, `physical_other_${adapter.label}_${target}_${field}`)
          : undefined;
        const runId = target === "plan"
          ? command.expectedPlanRun.id : command.expectedFailedApplyRun.id;
        const otherId = field === "capsule"
          ? other?.expectedCapsule.id : other?.expectedCapsule.workspaceId;
        await adapter.update(target, field, runId, otherId ?? "");
        expect((await adapter.store.commitRecoveredState(command)).status,
          `${adapter.label}:${target}:${field}`).toBe("conflict");
        expect(await adapter.store.getStateVersion(command.stateVersion.id),
          `${adapter.label}:${target}:${field}:state`).toBeUndefined();
        expect(await adapter.store.getStateRecoveryRun(command.recoveryRun.id),
          `${adapter.label}:${target}:${field}:run`).toBeUndefined();
        expect((await adapter.store.getCapsule(command.expectedCapsule.id))?.currentStateVersionId,
          `${adapter.label}:${target}:${field}:capsule`).toBeUndefined();
      }
    }
  }
});

test("D1 recovery first-statement guard rejects physical Run drift racing the batch", async () => {
  const d1 = new MutateBeforeNextD1Batch();
  const store = new CloudflareD1OpenTofuControlStore(d1);
  const command = await fixture(store, "physical_batch_race");
  d1.beforeNextBatch = async () => {
    await d1.prepare("update runs set lease_token = ? where id = ?")
      .bind("racing-active-lease", command.expectedFailedApplyRun.id).run();
  };
  expect((await store.commitRecoveredState(command)).status).toBe("conflict");
  expect(await store.getStateVersion(command.stateVersion.id)).toBeUndefined();
  expect(await store.getStateRecoveryRun(command.recoveryRun.id)).toBeUndefined();
  expect((await store.getCapsule(command.expectedCapsule.id))?.currentStateVersionId).toBeUndefined();
  expect(await store.listActivityEvents(command.expectedCapsule.workspaceId)).not.toContainEqual(command.activity);
});

test("D1 recovery candidate guard remains within the 100-parameter ceiling", async () => {
  const d1 = new CountD1Bindings();
  const store = new CloudflareD1OpenTofuControlStore(d1);
  const command = await fixture(store, "d1_parameter_ceiling");
  expect((await store.commitRecoveredState(command)).status).toBe("committed");
  expect(d1.boundCounts.length).toBeGreaterThan(0);
  expect(Math.max(...d1.boundCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
});

test("recovery rejects a changed public Plan and Workspace management epoch", async () => {
  for (const [label, store] of await stores()) {
    const changedPlan = await fixture(store, `public_change_${label}`, true);
    expect((await store.commitRecoveredState({
      ...changedPlan,
      expectedPlanRun: {
        ...changedPlan.expectedPlanRun, executionInputsDigest: "sha256:changed",
      },
    })).status, `${label}:public-plan`).toBe("conflict");

    const changedEpoch = await fixture(store, `epoch_change_${label}`, true);
    const drain = await store.beginWorkspaceDraining(
      changedEpoch.expectedCapsule.workspaceId,
      changedEpoch.expectedWorkspaceManagement,
    );
    expect(drain.status, `${label}:drain`).toBe("started");
    expect((await store.commitRecoveredState(changedEpoch)).status, `${label}:epoch`).toBe("conflict");
    expect(await store.getStateRecoveryRun(changedEpoch.recoveryRun.id), `${label}:epoch-run`)
      .toBeUndefined();
  }
});

test("recovery rejects changed scope, capsule, configuration and newer work without a partial state", async () => {
  for (const [label, store] of await stores()) {
    const command = await fixture(store, `guard_${label}`);
    await expect(store.commitRecoveredState({ ...command, expectedExecutionAuthorityEpoch: 99 }), label).rejects.toThrow();
    expect(await store.getStateVersion(command.stateVersion.id), label).toBeUndefined();
    await store.putPlanRun({ ...command.expectedPlanRun, id: `newer_plan_${label}`, createdAt: 4, updatedAt: 4 });
    expect((await store.commitRecoveredState(command)).status, label).toBe("conflict");
    expect(await store.getStateVersion(command.stateVersion.id), label).toBeUndefined();
    expect(await store.getStateRecoveryRun(command.recoveryRun.id), label).toBeUndefined();
  }
});

test("operator producer accepts only a verified immutable descriptor and reconciles its exact retry", async () => {
  for (const [label, store] of await stores()) {
    const command = await fixture(store, `producer_${label}`);
    const producer = (artifact: VerifiedRecoveryArtifact) => recoverFailedInitialCreateState({
      store, verifier: { verify: async () => artifact }, artifactHandle: "opaque_handle",
      failedApplyRunId: command.expectedFailedApplyRun.id,
      recoveryRunId: command.recoveryRun.id, createdBy: "operator_test", now: NOW,
    });
    await expect(producer({ ...command.artifact, capsuleId: "other" }), label).rejects.toThrow();
    expect(await store.getStateVersion(command.stateVersion.id), label).toBeUndefined();
    expect((await producer(command.artifact)).status, label).toBe("committed");
    expect((await store.getStateRecoveryRun(command.recoveryRun.id))?.executionEvidence, label).toBeUndefined();
    expect((await producer(command.artifact)).status, label).toBe("replayed");
    await expect(producer({ ...command.artifact, encryptedDigest: DIGEST }), label).rejects.toThrow();
    expect((await store.listActivityEvents(command.expectedCapsule.workspaceId)).filter(
      (event) => event.id === command.activity.id,
    ), label).toHaveLength(1);
  }
});

test("artifact scope and generation collisions fail before any recovery write", async () => {
  for (const [label, store] of await stores()) {
    const command = await fixture(store, `collision_${label}`);
    await expect(store.commitRecoveredState({
      ...command, artifact: { ...command.artifact, workspaceId: "other" },
    }), label).rejects.toThrow();
    await store.putStateVersion({ ...command.stateVersion, id: `other_generation_one_${label}` });
    expect((await store.commitRecoveredState(command)).status, label).toBe("conflict");
    expect(await store.getStateVersion(command.stateVersion.id), label).toBeUndefined();
    expect(await store.getStateRecoveryRun(command.recoveryRun.id), label).toBeUndefined();
  }
});

test("producer replay refuses a changed deterministic Activity row", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const command = await fixture(store, "activity_replay");
  const producer = () => recoverFailedInitialCreateState({
    store, verifier: { verify: async () => command.artifact }, artifactHandle: "opaque_handle",
    failedApplyRunId: command.expectedFailedApplyRun.id,
    recoveryRunId: command.recoveryRun.id, createdBy: "operator_test", now: NOW,
  });
  expect((await producer()).status).toBe("committed");
  await store.putActivityEvent({ ...command.activity, metadata: { ...command.activity.metadata, artifactEvidenceDigest: DIGEST } });
  await expect(producer()).rejects.toThrow("state recovery replay no longer matches");
});

test("recovery commit and provenance reader reject mismatched Plan context or source URL", async () => {
  for (const [kind, mutation] of [
    ["context", (plan: PlanRun): PlanRun => ({
      ...plan, capsuleContext: { ...plan.capsuleContext!, environment: "other" },
    })],
    ["source", (plan: PlanRun): PlanRun => ({
      ...plan, source: { ...plan.source, url: "https://example.invalid/other.git" },
    })],
  ] as const) {
    const store = new InMemoryOpenTofuControlStore();
    const command = await fixture(store, `plan_${kind}`);
    const mismatchedPlan = mutation(command.expectedPlanRun);
    await store.putPlanRun(mismatchedPlan);
    await expect(store.commitRecoveredState({ ...command, expectedPlanRun: mismatchedPlan }), kind).rejects.toThrow();
    expect(await store.getStateVersion(command.stateVersion.id), kind).toBeUndefined();
    await store.putPlanRun(command.expectedPlanRun);
    expect((await store.commitRecoveredState(command)).status, kind).toBe("committed");
    const capsule = await store.getCapsule(command.expectedCapsule.id);
    if (!capsule) throw new Error("missing recovered Capsule");
    await store.putPlanRun(mismatchedPlan);
    expect(await recoveryPlanForStateVersion(store, capsule, command.stateVersion), kind).toBeUndefined();
    await expect(getCurrentResourceInventory(store, capsule.id), kind).rejects.toThrow(
      "Recovery Run does not match the current Capsule state",
    );
  }
});
