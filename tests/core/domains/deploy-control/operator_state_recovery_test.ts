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
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

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

async function fixture(store: OpenTofuControlStore, label: string): Promise<CommitRecoveredStateInput> {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `ws_recovery_${label}`, capsuleId: `cap_recovery_${label}`,
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
    variablesDigest: DIGEST, requiredProviders: [], status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 }, policyDecisionDigest: DIGEST,
    planDigest: DIGEST, planArtifact: { kind: "object-storage", ref: "opaque_plan_artifact", digest: DIGEST },
    sourceSnapshotId: seeded.snapshot.id,
    baseStateGeneration: 0, appliedApplyRunId: `apply_recovery_${label}`,
    planResourceChanges: [{ address: "example_resource.a", type: "example_resource", actions: ["create"] }],
    auditEvents: [], createdAt: 1, updatedAt: 1,
  };
  const failed: ApplyRun = {
    id: `apply_recovery_${label}`, planRunId: plan.id, workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id, operation: "create", runnerProfileId: plan.runnerProfileId,
    status: "failed", expected: {
      planRunId: plan.id, capsuleId: seeded.capsule.id, currentStateVersionId: null,
      capsuleExecutionAuthorityEpoch: epoch, runnerProfileId: plan.runnerProfileId,
      sourceDigest: plan.sourceDigest, variablesDigest: plan.variablesDigest,
      policyDecisionDigest: plan.policyDecisionDigest, planDigest: DIGEST,
      planArtifactDigest: DIGEST,
    },
    stateBackend: { kind: "operator-managed", ref: "opaque_backend" },
    stateLock: { status: "recorded", backendRef: "opaque_backend" },
    auditEvents: [{ id: `event_${label}`, type: "apply.failed", at: 2, data: { providerDispatched: true } }],
    createdAt: 2, updatedAt: 3, finishedAt: 3,
  };
  await store.putPlanRun(plan);
  await store.putApplyRun(failed);
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
    expectedPlanRun: plan, expectedFailedApplyRun: failed,
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
