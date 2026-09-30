import { expect, jest, test } from "bun:test";

import {
  OpenTofuController,
  type OpenTofuApplyJob,
  type OpenTofuPlanJob,
  type OpenTofuPlanResult,
  type OpenTofuApplyResult,
  type OpenTofuRunner,
  type OpenTofuRestoreJob,
  type OpenTofuRestoreResult,
  type OpenTofuSourceSyncJob,
  type OpenTofuSourceSyncResult,
  type OpenTofuServiceDataRestoreJob,
  type RunExecutionControl,
  type RunServiceDataRestoreResult,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  type AcquireCapsuleLeaseInput,
  capsuleLeaseScope,
  type CapsuleCoordination,
  DEFAULT_CAPSULE_LEASE_TTL_MS,
  InMemoryCapsuleCoordination,
  type CapsuleLease,
  type RenewCapsuleLeaseInput,
  type ReleaseCapsuleLeaseInput,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import {
  InMemoryOpenTofuControlStore,
  capsuleRuntimeSafetyFromRun,
  capsuleApplyRunAdmissionFence,
  planRunExecutionInputsDigestMaterial,
  type StoredSource,
  type AppendRunningRunAuditEventInput,
  type TransitionRunInput,
  type TransitionRunResult,
} from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { stateVersionIdForRecoveryRun } from "../../../../core/domains/deploy-control/operator_state_recovery.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fixtureExecutionEvidence,
  fixtureStateCommit,
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  providerRequirementsForFixture,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { PhaseMintBundle, type ConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import type {
  ApplyRun,
  PlanRun,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type { SourceSyncRun } from "takosumi-contract/sources";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST = `sha256:${"f".repeat(64)}`;

function restoreAck(
  job: OpenTofuRestoreJob,
  digest = PLAN_DIGEST,
): OpenTofuRestoreResult {
  return {
    state: {
      generation: job.stateScope.generation,
      stateRef: `runner-local://restore/${job.runId}`,
      logicalTargetStateRef: job.stateScope.stateRef,
      digest,
      runId: job.runId,
      ciphertextLength: 0,
      restoreAuthority: {
        kind: "takosumi.runner-restore-ack@v1",
        version: 1,
        fence: 1,
        operationId: `test-restore:${job.runId}`,
        stateEtag: digest,
      },
    },
  };
}

function planArtifact() {
  return {
    kind: "runner-local" as const,
    ref: "runner-local://plan/tfplan",
    digest: PLAN_DIGEST,
  };
}

/**
 * Seeds the Workspace-direct Capsule model plus a succeeded PlanRun and a
 * QUEUED ApplyRun bound to the same Capsule (mirrors apply_lease_test.ts's
 * fixture). Returns the environment so the lease scope can be reconstructed.
 */
async function seedApply(
  store: InMemoryOpenTofuControlStore,
  ids: {
    capsuleId: string;
    planRunId: string;
    applyRunId: string;
    environment?: string;
    requiredProviders?: readonly string[];
  },
): Promise<{ environment: string }> {
  const environment = ids.environment ?? "production";
  const seedStateVersionId = `state_seed_${ids.capsuleId}`;
  const { capsule, source, snapshot } = await seedCapsuleModel(store, {
    capsuleId: ids.capsuleId,
    workspaceId: `ws_${ids.capsuleId}`,
    sourceId: `src_${ids.capsuleId}`,
    snapshotId: `snap_${ids.capsuleId}`,
    installConfigId: `cfg_${ids.capsuleId}`,
    environment,
    ...(ids.requiredProviders ? { requiredProviders: ids.requiredProviders } : {}),
  });
  if (ids.requiredProviders?.length) {
    await seedProviderConnections(store, capsule, {
      requiredProviders: ids.requiredProviders,
    });
  }
  await store.putCapsule({
    ...capsule,
    currentStateVersionId: seedStateVersionId,
    currentStateGeneration: 0,
    status: "active",
  });
  const currentCapsule = await store.getCapsule(capsule.id);
  if (!currentCapsule) {
    throw new Error(`fixture Capsule ${capsule.id} is missing`);
  }
  const inputs = {
    planRunId: ids.planRunId,
    variables: {},
    generatedRoot: {
      files: { "main.tf": 'module "child" { source = "./module" }' },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  } as const;
  const planRun: PlanRun = {
    id: ids.planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: ids.capsuleId,
    capsuleCurrentStateVersionId: seedStateVersionId,
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: ids.capsuleId,
      environment,
    },
    source: {
      kind: "git",
      url: source.url,
      commit: "abcdef0123456789abcdef0123456789abcdef01",
    },
    sourceSnapshotId: snapshot.id,
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: await stableJsonDigest(inputs.variables),
    executionInputsDigest: await stableJsonDigest(
      planRunExecutionInputsDigestMaterial(inputs, undefined),
    ),
    requiredProviders: ids.requiredProviders ?? [],
    ...(ids.requiredProviders?.length
      ? { requiredProviderRequirements: providerRequirementsForFixture(
          ids.requiredProviders,
        ).map((requirement) => ({ ...requirement, version: "1.0.0" })) }
      : {}),
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: PLAN_DIGEST,
    planArtifact: planArtifact(),
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const workspaceManagement = await store.getWorkspaceManagement(
    capsule.workspaceId,
  );
  if (!workspaceManagement) {
    throw new Error("fixture Workspace management is missing");
  }
  const expectedWorkspaceManagementAuthority = {
    workspaceId: capsule.workspaceId,
    managementState: "active" as const,
    managementEpoch: workspaceManagement.managementEpoch,
  };
  await store.preparePlanRun({
    run: planRun,
    inputs,
    expectedWorkspaceManagementAuthority,
  });
  const applyRun: ApplyRun = {
    id: ids.applyRunId,
    planRunId: ids.planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: ids.capsuleId,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "queued",
    expected: {
      planRunId: ids.planRunId,
      capsuleId: ids.capsuleId,
      currentStateVersionId: seedStateVersionId,
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:src",
      variablesDigest: planRun.variablesDigest,
      policyDecisionDigest: "sha256:policy",
      planDigest: PLAN_DIGEST,
      planArtifactDigest: PLAN_DIGEST,
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const applyAdmission = await store.beginApplyRun(
    applyRun,
    expectedWorkspaceManagementAuthority,
    capsuleApplyRunAdmissionFence(
      currentCapsule,
      await store.getCapsuleExecutionAuthorityEpoch(currentCapsule.id) ?? 1,
    ),
  );
  if (applyAdmission.status !== "created") {
    throw new Error("fixture Apply admission did not create a new Run");
  }
  return { environment };
}

function queuedSourceSyncRun(
  id: string,
  workspaceId: string,
  sourceId: string,
  overrides: Partial<SourceSyncRun> = {},
): SourceSyncRun {
  return {
    id,
    kind: "source_sync",
    workspaceId,
    sourceId,
    url: "https://example.test/source.git",
    ref: "main",
    path: ".",
    archiveRef: `archive-${id}`,
    intent: "observe",
    status: "queued",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    snapshotId: `snapshot-${id}`,
    ...overrides,
  };
}

function controllerWith(
  store: InMemoryOpenTofuControlStore,
  options: {
    coordination?: CapsuleCoordination;
    now?: () => number;
    plan?: (
      job: OpenTofuPlanJob,
      control?: RunExecutionControl,
    ) => Promise<OpenTofuPlanResult>;
    apply?: (
      job: OpenTofuApplyJob,
      control?: RunExecutionControl,
    ) => Promise<OpenTofuApplyResult>;
    destroy?: NonNullable<OpenTofuRunner["destroy"]>;
    sourceSync?: (job: OpenTofuSourceSyncJob) => Promise<OpenTofuSourceSyncResult>;
    restore?: (
      job: OpenTofuRestoreJob,
      control?: RunExecutionControl,
    ) => Promise<OpenTofuRestoreResult>;
    restoreServiceData?: (
      job: OpenTofuServiceDataRestoreJob,
      control?: RunExecutionControl,
    ) => Promise<RunServiceDataRestoreResult>;
    disableEnqueue?: boolean;
    runRenewalIntervalMs?: number;
    runnerProfiles?: readonly RunnerProfile[];
    defaultRunnerProfileId?: string;
    vault?: ConnectionVault;
    assertCredentialRefreshCapability?: OpenTofuRunner["assertCredentialRefreshCapability"];
    refreshCredentials?: OpenTofuRunner["refreshCredentials"];
  } = {},
) {
  const apply =
    options.apply ?? (() => Promise.resolve(fixtureStateCommit()));
  return new OpenTofuController({
    store,
    ...(options.vault ? { vault: options.vault } : {}),
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
    ...(options.coordination
      ? { capsuleCoordination: options.coordination }
      : {}),
    ...(options.runRenewalIntervalMs !== undefined
      ? { runRenewalIntervalMs: options.runRenewalIntervalMs }
      : {}),
    ...(options.disableEnqueue
      ? { enqueueRun: () => Promise.resolve() }
      : {}),
    now: options.now ?? (() => 1),
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    newId: ((): ((p: string) => string) => {
      let n = 0;
      return (p) => `${p}_${(n += 1).toString().padStart(4, "0")}`;
    })(),
    runner: {
      ...(options.assertCredentialRefreshCapability
        ? { assertCredentialRefreshCapability: options.assertCredentialRefreshCapability }
        : {}),
      ...(options.refreshCredentials
        ? { refreshCredentials: options.refreshCredentials }
        : {}),
      plan: options.plan ?? (() => Promise.reject(new Error("not used"))),
      apply: async (job, control) => {
        const result = await apply(job, control);
        return {
          ...result,
          rawOutputRef: job.rawOutputRef,
          executionEvidence: result.executionEvidence ??
            fixtureExecutionEvidence(job, "apply"),
        };
      },
      ...(options.destroy ? { destroy: options.destroy } : {}),
      ...(options.sourceSync ? { sourceSync: options.sourceSync } : {}),
      ...(options.restore ? { restore: options.restore } : {}),
      ...(options.restoreServiceData
        ? { restoreServiceData: options.restoreServiceData }
        : {}),
    },
  });
}

test("Apply completion never receives the Plan-only Core timing diagnostic", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_apply_plan_timing_exclusion",
    planRunId: "plan_apply_plan_timing_exclusion",
    applyRunId: "apply_plan_timing_exclusion",
  });
  const response = await controllerWith(store).runQueuedApply(
    "apply_plan_timing_exclusion",
  );
  expect(response.applyRun.status).toBe("succeeded");
  expect(response.applyRun.diagnostics?.some(
    (diagnostic) => diagnostic.code === "core_plan_elapsed_timings",
  )).toBeFalsy();
});

class RecoveryRestoreStore extends InMemoryOpenTofuControlStore {
  readonly recoveryRuns = new Map<string, Run>();

  override getStateRecoveryRun(id: string): Promise<Run | undefined> {
    return Promise.resolve(this.recoveryRuns.get(id));
  }
}

async function seedQueuedRestore(
  store: InMemoryOpenTofuControlStore,
  controller: OpenTofuController,
  label: string,
  restoreServiceData = false,
  stateCreator: "apply" | "state_recovery" | "orphan_recovery" = "apply",
): Promise<{
  readonly runId: string;
  readonly capsuleId: string;
  readonly environment: string;
}> {
  const { capsule, snapshot } = await seedCapsuleModel(store, {
    workspaceId: `ws_restore_renewal_${label}`,
    capsuleId: `cap_restore_renewal_${label}`,
  });
  const createdByRunId = stateCreator !== "apply"
    ? `recovery_restore_renewal_${label}` : `apply_restore_renewal_${label}`;
  const stateVersionId = stateCreator !== "apply"
    ? await stateVersionIdForRecoveryRun(createdByRunId) : `state_restore_renewal_${label}`;
  await store.putStateVersion({
    id: stateVersionId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: `state/restore-renewal/${label}`,
    digest: PLAN_DIGEST,
    createdByRunId,
    createdAt: "2026-08-29T00:00:00.000Z",
  });
  if (stateCreator === "state_recovery") {
    const planRunId = `plan_restore_recovery_${label}`;
    const failedApplyRunId = `apply_restore_recovery_${label}`;
    await store.putPlanRun({
      id: planRunId, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
      capsuleContext: { workspaceId: capsule.workspaceId, capsuleId: capsule.id, environment: capsule.environment },
      source: { kind: "git", url: snapshot.url, commit: snapshot.resolvedCommit },
      sourceSnapshotId: snapshot.id, sourceDigest: PLAN_DIGEST,
      operation: "create", runnerProfileId: "opentofu-default",
      variablesDigest: PLAN_DIGEST, requiredProviders: [], status: "succeeded",
      policy: { status: "passed", reasons: [], checkedAt: 1 }, policyDecisionDigest: PLAN_DIGEST,
      planDigest: PLAN_DIGEST, planArtifact: planArtifact(), baseStateGeneration: 0,
      auditEvents: [], createdAt: 1, updatedAt: 1,
    });
    await store.putApplyRun({
      id: failedApplyRunId, planRunId, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
      operation: "create", runnerProfileId: "opentofu-default", status: "failed",
      expected: {
        planRunId, capsuleId: capsule.id, runnerProfileId: "opentofu-default",
        sourceDigest: PLAN_DIGEST, variablesDigest: PLAN_DIGEST,
        policyDecisionDigest: PLAN_DIGEST, planDigest: PLAN_DIGEST,
      },
      stateBackend: { kind: "operator-managed", ref: "opaque_backend" },
      stateLock: { status: "recorded", backendRef: "opaque_backend" },
      auditEvents: [], createdAt: 2, updatedAt: 3, finishedAt: 3,
    });
    if (!(store instanceof RecoveryRestoreStore)) throw new Error("recovery fixture requires its recovery reader");
    store.recoveryRuns.set(createdByRunId, {
      id: createdByRunId, type: "state_recovery", status: "succeeded",
      workspaceId: capsule.workspaceId, capsuleId: capsule.id, environment: capsule.environment,
      planRunId, sourceSnapshotId: snapshot.id, createdBy: "ops",
      createdAt: "2026-08-29T00:00:00.000Z", finishedAt: "2026-08-29T00:00:00.000Z",
      stateRecovery: {
        failedApplyRunId, recoveredStateVersionId: stateVersionId, sourceSnapshotId: snapshot.id,
        plaintextSha256: PLAN_DIGEST, encryptedDigest: LOCK_DIGEST, artifactEvidenceDigest: LOCK_DIGEST,
      },
    });
  }
  const serviceData = {
    ref: `backup/restore-renewal/${label}/service-data`,
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    exportedCount: 1,
    unsupportedCount: 0,
    missingCount: 0,
  } as const;
  const backupId = `backup_restore_renewal_${label}`;
  await store.putBackupRecord({
    id: backupId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    ref: `backup/restore-renewal/${label}/control`,
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    ...(restoreServiceData ? { serviceData } : {}),
    createdAt: "2026-08-29T00:00:00.000Z",
  });
  await store.putCapsule({
    ...capsule,
    status: "destroyed",
    currentStateGeneration: 2,
    updatedAt: "2026-08-29T00:00:01.000Z",
  });
  const restore = await controller.createRestoreRun(
    capsule.workspaceId,
    backupId,
    {
      capsuleId: capsule.id,
      environment: capsule.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
      ...(restoreServiceData ? { restoreServiceData: true } : {}),
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "ops" });
  return {
    runId: restore.id,
    capsuleId: capsule.id,
    environment: capsule.environment,
  };
}

test("Restore refuses recovery state with missing recovery lineage before runner dispatch", async () => {
  const store = new RecoveryRestoreStore();
  let dispatched = 0;
  const controller = controllerWith(store, {
    disableEnqueue: true,
    restore: async (job) => {
      dispatched += 1;
      return restoreAck(job);
    },
  });
  const target = await seedQueuedRestore(store, controller, "orphan_recovery", false, "orphan_recovery");
  await expect(controller.runQueuedRestore(target.runId)).rejects.toThrow("recovery lineage");
  expect(dispatched).toBe(0);
});

test("Restore accepts exact recovery lineage and rechecks it before the adapter write", async () => {
  const store = new RecoveryRestoreStore();
  let dispatched = 0;
  const controller = controllerWith(store, {
    disableEnqueue: true,
    restore: async (job, options) => {
      dispatched += 1;
      expect(await options?.sourceAuthority?.readExact()).toEqual(job.sourceState);
      return restoreAck(job);
    },
  });
  const target = await seedQueuedRestore(store, controller, "valid_recovery", false, "state_recovery");
  expect((await controller.runQueuedRestore(target.runId))?.status).toBe("succeeded");
  expect(dispatched).toBe(1);
});

test("Restore rejects changed recovery lineage at the adapter write fence", async () => {
  const store = new RecoveryRestoreStore();
  const controller = controllerWith(store, {
    disableEnqueue: true,
    restore: async (job, options) => {
      const recovery = (await store.getStateRecoveryRun(job.sourceState.createdByRunId))!;
      store.recoveryRuns.set(recovery.id, { ...recovery, stateRecovery: { ...recovery.stateRecovery!, plaintextSha256: LOCK_DIGEST } });
      await options?.sourceAuthority?.readExact();
      throw new Error("must not reach the target artifact write");
    },
  });
  const target = await seedQueuedRestore(store, controller, "changed_recovery", false, "state_recovery");
  await expect(controller.runQueuedRestore(target.runId)).rejects.toThrow("recovery lineage");
});

function isApplyHeartbeatRenewal(input: TransitionRunInput): boolean {
  return (
    input.kind === "apply" &&
    input.expectFrom.includes("running") &&
    input.expectLeaseToken !== undefined &&
    input.run.status === "running" &&
    input.setLeaseToken === undefined &&
    input.clearLeaseToken !== true
  );
}

class OneTransientHeartbeatFailureStore extends InMemoryOpenTofuControlStore {
  heartbeatRenewalAttempts = 0;

  override async transitionRun(
    input: TransitionRunInput,
  ): Promise<TransitionRunResult> {
    if (isApplyHeartbeatRenewal(input)) {
      this.heartbeatRenewalAttempts += 1;
      if (this.heartbeatRenewalAttempts === 1) {
        throw new Error("transient D1 heartbeat transport reset");
      }
    }
    return await super.transitionRun(input);
  }
}

class HeartbeatCountingStore extends InMemoryOpenTofuControlStore {
  heartbeatRenewalAttempts = 0;

  override async transitionRun(
    input: TransitionRunInput,
  ): Promise<TransitionRunResult> {
    if (isApplyHeartbeatRenewal(input)) {
      this.heartbeatRenewalAttempts += 1;
    }
    return await super.transitionRun(input);
  }
}

class LoseApplyHeartbeatStore extends HeartbeatCountingStore {
  loseHeldRun = false;

  override async transitionRun(input: TransitionRunInput): Promise<TransitionRunResult> {
    if (this.loseHeldRun && isApplyHeartbeatRenewal(input)) {
      return { won: false, run: await this.getApplyRun(input.id) };
    }
    return await super.transitionRun(input);
  }
}

// --- cancel-vs-claim ---

test("cancel that wins forces a later consumer claim to lose (no dispatch, no resurrection)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_cancel_first",
    planRunId: "plan_cf",
    applyRunId: "apply_cf",
  });
  let applied = false;
  const controller = controllerWith(store, {
    apply: () => {
      applied = true;
      return Promise.resolve({});
    },
  });

  // Cancel wins the queued row first.
  const cancelled = await controller.cancelRun("apply_cf");
  expect(cancelled.status).toBe("cancelled");

  // A consumer claim now races: the claim CAS (expectFrom 'queued') loses, so the
  // runner is NEVER dispatched and the cancelled run is not resurrected.
  const response = await controller.runQueuedApply("apply_cf");
  expect(applied).toBe(false);
  expect(response.applyRun.status).toBe("cancelled");
  expect((await store.getApplyRun("apply_cf"))?.status).toBe("cancelled");
});

test("settleRunDuringDrain settles only unstarted rows through the controller seam", async () => {
  const beginDrain = async (
    store: InMemoryOpenTofuControlStore,
    workspaceId: string,
  ) => {
    const active = await store.getWorkspaceManagement(workspaceId);
    if (!active) throw new Error("fixture Workspace management is missing");
    const result = await store.beginWorkspaceDraining(workspaceId, active);
    if (result.status !== "started") {
      throw new Error(`fixture drain did not start: ${result.status}`);
    }
    return result.management;
  };

  // A queued Plan is cancelled through the real controller and its private
  // preparation inputs are removed by the same terminal path.
  {
    const store = new InMemoryOpenTofuControlStore();
    await seedApply(store, {
      capsuleId: "cap_cancel_drain_plan",
      planRunId: "plan_cancel_drain_plan",
      applyRunId: "apply_cancel_drain_plan",
    });
    const seeded = (await store.getPlanRun("plan_cancel_drain_plan"))!;
    const queued: PlanRun = { ...seeded, status: "queued" };
    await store.putPlanRun(queued);
    expect(await store.getPlanRunInputs(queued.id)).toBeDefined();
    const management = await beginDrain(store, queued.workspaceId);
    const controller = controllerWith(store, { now: () => 3 });

    const cancelled = await controller.settleRunDuringDrain(queued.id, management);

    expect(cancelled.status).toBe("cancelled");
    expect((await store.getPlanRun(queued.id))?.status).toBe("cancelled");
    expect(await store.getPlanRunInputs(queued.id)).toBeUndefined();
  }

  // Persisted waiting_approval and the legacy succeeded+requiresApproval
  // representation take the same drain-owned cancellation route.
  for (const scenario of [
    { suffix: "waiting", status: "waiting_approval" as const },
    { suffix: "legacy", status: "succeeded" as const, requiresApproval: true },
  ]) {
    const store = new InMemoryOpenTofuControlStore();
    await seedApply(store, {
      capsuleId: `cap_cancel_drain_${scenario.suffix}`,
      planRunId: `plan_cancel_drain_${scenario.suffix}`,
      applyRunId: `apply_cancel_drain_${scenario.suffix}`,
    });
    const seeded = (await store.getPlanRun(`plan_cancel_drain_${scenario.suffix}`))!;
    const gated: PlanRun = {
      ...seeded,
      status: scenario.status,
      ...(scenario.requiresApproval ? { requiresApproval: true } : {}),
    };
    await store.putPlanRun(gated);
    const management = await beginDrain(store, gated.workspaceId);
    const controller = controllerWith(store, { now: () => 3 });

    const cancelled = await controller.settleRunDuringDrain(gated.id, management);

    expect(cancelled.status).toBe("cancelled");
    expect((await store.getPlanRun(gated.id))?.status).toBe("cancelled");
  }

  // An Apply cancellation reaches the terminal observer without invoking the
  // external runner or dispatching a second execution.
  {
    const store = new InMemoryOpenTofuControlStore();
    await seedApply(store, {
      capsuleId: "cap_cancel_drain_apply",
      planRunId: "plan_cancel_drain_apply",
      applyRunId: "apply_cancel_drain_apply",
    });
    const queued = (await store.getApplyRun("apply_cancel_drain_apply"))!;
    const management = await beginDrain(store, queued.workspaceId);
    let runnerCalls = 0;
    const terminalStatuses: string[] = [];
    const controller = controllerWith(store, {
      now: () => 3,
      apply: async () => {
        runnerCalls += 1;
        return fixtureStateCommit();
      },
    });
    controller.setTerminalRunObserver(async (run) => {
      terminalStatuses.push(run.status);
    });

    const cancelled = await controller.settleRunDuringDrain(queued.id, management);

    expect(cancelled.status).toBe("cancelled");
    expect(runnerCalls).toBe(0);
    expect(terminalStatuses).toEqual(["cancelled"]);
  }

  // A queued retry carrying started evidence is not an unclaimed row.
  {
    const store = new InMemoryOpenTofuControlStore();
    await seedApply(store, {
      capsuleId: "cap_cancel_drain_started",
      planRunId: "plan_cancel_drain_started",
      applyRunId: "apply_cancel_drain_started",
    });
    const seeded = (await store.getApplyRun("apply_cancel_drain_started"))!;
    const retry: ApplyRun = {
      ...seeded,
      status: "queued",
      startedAt: 10,
      updatedAt: 10,
    };
    await store.putApplyRun(retry);
    const management = await beginDrain(store, retry.workspaceId);
    const controller = controllerWith(store, { now: () => 3 });

    await expect(
      controller.settleRunDuringDrain(retry.id, management),
    ).rejects.toThrow(/cannot be settled by management drain/);
    expect(await store.getApplyRun(retry.id)).toEqual(retry);
  }

  // A held execution lease is likewise refused before the drain CAS.
  {
    const store = new InMemoryOpenTofuControlStore();
    await seedApply(store, {
      capsuleId: "cap_cancel_drain_held",
      planRunId: "plan_cancel_drain_held",
      applyRunId: "apply_cancel_drain_held",
    });
    const seeded = (await store.getApplyRun("apply_cancel_drain_held"))!;
    const held: ApplyRun = {
      ...seeded,
      status: "running",
      startedAt: 2,
      heartbeatAt: 2,
      updatedAt: 2,
    };
    expect(
      await store.transitionRun({
        id: held.id,
        kind: "apply",
        expectFrom: ["queued"],
        run: held,
        setLeaseToken: "drain-held-lease",
      }),
    ).toEqual({ won: true, run: held });
    const management = await beginDrain(store, held.workspaceId);
    const controller = controllerWith(store, { now: () => 3 });

    await expect(
      controller.settleRunDuringDrain(held.id, management),
    ).rejects.toThrow(/cannot be settled by management drain/);
    expect(await store.getApplyRun(held.id)).toEqual(held);
  }

  // A stale drain observation loses the exact Workspace CAS and leaves the
  // queued Apply available for a caller holding the current observation.
  {
    const store = new InMemoryOpenTofuControlStore();
    await seedApply(store, {
      capsuleId: "cap_cancel_drain_stale",
      planRunId: "plan_cancel_drain_stale",
      applyRunId: "apply_cancel_drain_stale",
    });
    const queued = (await store.getApplyRun("apply_cancel_drain_stale"))!;
    const management = await beginDrain(store, queued.workspaceId);
    const stale = { ...management, managementEpoch: management.managementEpoch + 1 };
    const controller = controllerWith(store, { now: () => 3 });

    await expect(
      controller.settleRunDuringDrain(queued.id, stale),
    ).rejects.toThrow(/only queued runs can be cancelled/);
    expect(await store.getApplyRun(queued.id)).toEqual(queued);
  }
});

test("settleRunDuringDrain settles queued SourceSync without execution side effects", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const workspaceId = "source-drain-controller-workspace";
  const sourceId = "source-drain-controller-source";
  await store.putWorkspace({
    id: workspaceId,
    handle: "source-drain-controller",
    displayName: "Source drain controller",
    type: "personal",
    ownerUserId: "source-drain-controller-owner",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  });
  const source: StoredSource = {
    id: sourceId,
    workspaceId,
    name: "source-drain-controller",
    url: "https://example.test/source.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    hookSecretHash: "source-drain-controller-hash",
    autoSync: false,
    lastSeenCommit: "before-drain",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
  await store.putSource(source);
  const original = {
    workspaceId,
    managementState: "active" as const,
    managementEpoch: 1,
  };
  const queued = queuedSourceSyncRun(
    "source-drain-controller-run",
    workspaceId,
    sourceId,
  );
  expect(await store.beginSourceSyncRun(queued, original)).toEqual({
    status: "created",
    run: queued,
  });
  const invalidRows = [
    queuedSourceSyncRun("source-drain-controller-started", workspaceId, sourceId, {
      startedAt: "2026-09-11T00:00:01.000Z",
      updatedAt: "2026-09-11T00:00:01.000Z",
    }),
    queuedSourceSyncRun("source-drain-controller-result", workspaceId, sourceId, {
      resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
    }),
  ];
  for (const run of invalidRows) {
    expect(await store.beginSourceSyncRun(run, original)).toEqual({
      status: "created",
      run,
    });
  }

  let sourceRunnerCalls = 0;
  const controller = controllerWith(store, {
    now: () => Date.parse("2026-09-11T00:00:03.000Z"),
    sourceSync: async () => {
      sourceRunnerCalls += 1;
      return {
        resolvedCommit: "should-not-run",
        archiveDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        archiveSizeBytes: 1,
        repositoryModules: { status: "ready", scopePath: ".", modules: [] },
      };
    },
  });
  await expect(controller.cancelRun(queued.id)).rejects.toThrow(
    /not a cancellable plan or apply run/,
  );
  expect(await store.getSourceSyncRun(queued.id)).toEqual(queued);

  const draining = {
    workspaceId,
    managementState: "draining" as const,
    managementEpoch: 2,
  };
  expect(await store.beginWorkspaceDraining(workspaceId, original)).toEqual({
    status: "started",
    management: draining,
  });
  await expect(
    controller.settleRunDuringDrain(queued.id, { ...draining, managementEpoch: 3 }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
  expect(await store.getSourceSyncRun(queued.id)).toEqual(queued);

  const finishedAt = "2026-09-11T00:00:03.000Z";
  const failed: SourceSyncRun = {
    ...queued,
    status: "failed",
    errorCode: "workspace_management_draining",
    error: "Workspace management stopped before this source sync was started.",
    updatedAt: finishedAt,
    finishedAt,
  };
  expect(await controller.settleRunDuringDrain(queued.id, draining)).toEqual({
    id: queued.id,
    workspaceId,
    type: "source_sync",
    status: "failed",
    sourceId,
    ref: "main",
    createdBy: "system",
    createdAt: queued.createdAt,
    finishedAt,
    errorCode: "workspace_management_draining",
  });
  expect(await store.getSourceSyncRun(queued.id)).toEqual(failed);
  expect(await store.getSource(sourceId)).toEqual(source);
  expect(await store.getSourceSnapshot(queued.snapshotId!)).toBeUndefined();
  expect(sourceRunnerCalls).toBe(0);
  expect(await controller.runQueuedSourceSync(queued.id)).toEqual(failed);
  expect(sourceRunnerCalls).toBe(0);

  for (const run of invalidRows) {
    await expect(
      controller.settleRunDuringDrain(run.id, draining),
    ).rejects.toMatchObject({ code: "failed_precondition" });
    expect(await store.getSourceSyncRun(run.id)).toEqual(run);
  }
});

test("settleRunDuringDrain settles queued Restore without observer or execution side effects", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const workspaceId = "restore-drain-controller-workspace";
  await store.putWorkspace({
    id: workspaceId,
    handle: "restore-drain-controller",
    displayName: "Restore drain controller",
    type: "personal",
    ownerUserId: "restore-drain-controller-owner",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  });
  const original = {
    workspaceId,
    managementState: "active" as const,
    managementEpoch: 1,
  };
  const restoreRun = (
    id: string,
    status: "queued" | "waiting_approval",
    overrides: Partial<Run> = {},
  ): Run => ({
    id,
    workspaceId,
    capsuleId: `capsule-${id}`,
    environment: "production",
    type: "restore",
    status,
    backupId: `backup-${id}`,
    restoreStateGeneration: 1,
    restoredFromStateVersionId: `state-${id}`,
    planDigest: PLAN_DIGEST,
    createdBy: "system",
    createdAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  });
  const queued = restoreRun("restore-drain-controller-run", "queued");
  const started = restoreRun("restore-drain-controller-started", "queued", {
    startedAt: "2026-09-11T00:00:01.000Z",
  });
  const resultPresent = restoreRun("restore-drain-controller-result", "queued", {
    restoredStateVersionId: "state-already-restored",
  });
  for (const run of [queued, started, resultPresent]) {
    expect(await store.beginRestoreRun(run, original)).toEqual({
      status: "created",
      run,
    });
  }

  let restoreRunnerCalls = 0;
  const restoreEvents: string[] = [];
  const controller = controllerWith(store, {
    now: () => Date.parse("2026-09-11T00:00:03.000Z"),
    restore: async (job) => {
      restoreRunnerCalls += 1;
      return restoreAck(job);
    },
  });
  controller.setRestoreRunObserver(async (event) => {
    restoreEvents.push(event.phase);
  });

  await expect(controller.cancelRun(queued.id)).rejects.toMatchObject({
    code: "failed_precondition",
  });
  expect(await store.getBackupRun(queued.id)).toEqual(queued);

  const draining = {
    workspaceId,
    managementState: "draining" as const,
    managementEpoch: 2,
  };
  expect(await store.beginWorkspaceDraining(workspaceId, original)).toEqual({
    status: "started",
    management: draining,
  });
  const finishedAt = "2026-09-11T00:00:03.000Z";
  const cancelled: Run = {
    ...queued,
    status: "cancelled",
    finishedAt,
  };
  expect(await store.listStateVersions(queued.capsuleId!, queued.environment!)).toEqual([]);
  expect(await controller.settleRunDuringDrain(queued.id, draining)).toEqual(cancelled);
  expect(await store.getBackupRun(queued.id)).toEqual(cancelled);
  expect(await controller.runQueuedRestore(queued.id)).toEqual(cancelled);
  expect(restoreRunnerCalls).toBe(0);
  expect(restoreEvents).toEqual([]);
  expect(await store.listStateVersions(queued.capsuleId!, queued.environment!)).toEqual([]);

  for (const run of [started, resultPresent]) {
    await expect(
      controller.settleRunDuringDrain(run.id, draining),
    ).rejects.toMatchObject({ code: "failed_precondition" });
    expect(await store.getBackupRun(run.id)).toEqual(run);
  }
});

test("a consumer claim that wins forces a concurrent cancel to be rejected (never clobbers the running apply)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_claim_first",
    planRunId: "plan_clf",
    applyRunId: "apply_clf",
  });
  // Gate the runner so the apply stays 'running' while we attempt the cancel.
  let releaseApply!: () => void;
  const applyHolds = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  const controller = controllerWith(store, {
    apply: async () => {
      await applyHolds;
      return fixtureStateCommit();
    },
  });

  // Start the claim; it moves the row to 'running' and blocks in the runner.
  const claimPromise = controller.runQueuedApply("apply_clf");
  // Let the claim mark running (flush microtasks + a macrotask) before the cancel.
  await new Promise((r) => setTimeout(r, 5));
  expect((await store.getApplyRun("apply_clf"))?.status).toBe("running");

  // The cancel CAS (expectFrom 'queued') now loses: a running apply is not
  // cancellable, and the cancel must not clobber it.
  await expect(controller.cancelRun("apply_clf")).rejects.toThrow(
    /only queued runs can be cancelled/,
  );

  releaseApply();
  const response = await claimPromise;
  expect(response.applyRun.status).toBe("succeeded");
});

test("a requeued destroy after successful pre_destroy cannot be cancelled or clear runtime safety", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_destroy_requeued",
    planRunId: "plan_destroy_requeued",
    applyRunId: "apply_destroy_requeued",
  });
  const planRun = (await store.getPlanRun("plan_destroy_requeued"))!;
  await store.putPlanRun({ ...planRun, operation: "destroy" });
  const applyRun = (await store.getApplyRun("apply_destroy_requeued"))!;
  await store.putApplyRun({
    ...applyRun,
    operation: "destroy",
    status: "queued",
    startedAt: 10,
    heartbeatAt: undefined,
    auditEvents: [
      ...applyRun.auditEvents,
      {
        id: "audit_pre_destroy_succeeded",
        type: "lifecycle_action.pre_destroy.succeeded",
        at: 11,
        data: {
          phase: "pre_destroy",
          status: "succeeded",
          commandCount: 1,
          actionDispatched: true,
        },
      },
      {
        id: "audit_destroy_retry",
        type: "destroy.retry_scheduled",
        at: 12,
        data: { reason: "runner_infrastructure_error" },
      },
    ],
    updatedAt: 12,
  });
  const controller = controllerWith(store);

  await expect(controller.cancelRun("apply_destroy_requeued")).rejects.toThrow(
    /has already started/,
  );
  expect((await store.getApplyRun("apply_destroy_requeued"))?.status).toBe(
    "queued",
  );
  expect(
    await store.getCapsuleRuntimeSafety("cap_destroy_requeued"),
  ).toMatchObject({
    phase: "terminating",
    runId: "apply_destroy_requeued",
    runType: "destroy_apply",
  });
});

test("a requeued Plan after runner infrastructure error cannot be cancelled or clear its started evidence", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_plan_requeued",
    planRunId: "plan_requeued",
    applyRunId: "apply_plan_requeued",
  });
  const planRun = (await store.getPlanRun("plan_requeued"))!;
  const planInputs = await store.getPlanRunInputs(planRun.id);
  const queued: PlanRun = {
    ...planRun,
    status: "queued",
    startedAt: 10,
    heartbeatAt: undefined,
    diagnostics: undefined,
    finishedAt: undefined,
    auditEvents: [
      ...planRun.auditEvents,
      {
        id: "audit_plan_retry",
        type: "plan.retry_scheduled",
        at: 12,
        data: { reason: "runner_infrastructure_error" },
      },
    ],
    updatedAt: 12,
  };
  await store.putPlanRun(queued);
  const controller = controllerWith(store);

  await expect(controller.cancelRun(queued.id)).rejects.toThrow(
    /has already started/,
  );
  expect(await store.getPlanRun(queued.id)).toEqual(queued);
  expect(await store.getPlanRunInputs(queued.id)).toEqual(planInputs);
});

test("a previously-started queued Plan retry loses its claim while Workspace management is draining", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_plan_claim_started_retry",
    planRunId: "plan_claim_started_retry",
    applyRunId: "apply_plan_claim_started_retry",
  });
  const planRun = (await store.getPlanRun("plan_claim_started_retry"))!;
  const planInputs = await store.getPlanRunInputs(planRun.id);
  const queuedRetry: PlanRun = {
    ...planRun,
    status: "queued",
    startedAt: 10,
    heartbeatAt: undefined,
    diagnostics: undefined,
    finishedAt: undefined,
    auditEvents: [
      ...planRun.auditEvents,
      {
        id: "audit_plan_claim_started_retry",
        type: "plan.retry_scheduled",
        at: 12,
        data: { reason: "runner_infrastructure_error" },
      },
    ],
    updatedAt: 12,
  };
  await store.putPlanRun(queuedRetry);
  const workspaceManagement = await store.getWorkspaceManagement(
    queuedRetry.workspaceId,
  );
  if (!workspaceManagement) {
    throw new Error("fixture Workspace management is missing");
  }
  const drain = await store.beginWorkspaceDraining(
    queuedRetry.workspaceId,
    {
      workspaceId: queuedRetry.workspaceId,
      managementState: "active",
      managementEpoch: workspaceManagement.managementEpoch,
    },
  );
  expect(drain.status).toBe("started");

  let planDispatches = 0;
  const controller = controllerWith(store, {
    plan: async () => {
      planDispatches += 1;
      return { planDigest: PLAN_DIGEST, planArtifact: planArtifact() };
    },
  });

  const result = await controller.runQueuedPlan(queuedRetry.id);

  // The draining Workspace fence makes this a non-admissible fresh claim. The
  // RunEngine must return the row observed by the losing claim and never invoke
  // the external planner or mutate the queued retry's private inputs.
  expect(result?.status).toBe("queued");
  expect(planDispatches).toBe(0);
  expect(await store.getPlanRun(queuedRetry.id)).toEqual(queuedRetry);
  expect(await store.getPlanRunInputs(queuedRetry.id)).toEqual(planInputs);
});

test("Plan cancel loses when a claim and infrastructure requeue happen between its read and CAS", async () => {
  class ClaimAndRequeueBeforeCancelStore extends InMemoryOpenTofuControlStore {
    #interceptCancel = true;

    override async transitionRun(
      input: TransitionRunInput,
    ): Promise<TransitionRunResult> {
      if (
        this.#interceptCancel &&
        input.kind === "plan" &&
        input.run.status === "cancelled"
      ) {
        this.#interceptCancel = false;
        const current = await this.getPlanRun(input.id);
        if (current) {
          const claimed: PlanRun = {
            ...current,
            status: "running",
            startedAt: 10,
            heartbeatAt: 10,
            updatedAt: 10,
          };
          const claim = await super.transitionRun({
            id: current.id,
            kind: "plan",
            expectFrom: ["queued"],
            run: claimed,
            setLeaseToken: "plan-race-lease",
          });
          if (!claim.won) throw new Error("plan claim fixture did not win");
          await super.transitionRun({
            id: current.id,
            kind: "plan",
            expectFrom: ["running"],
            expectLeaseToken: "plan-race-lease",
            run: {
              ...claimed,
              status: "queued",
              heartbeatAt: undefined,
              finishedAt: undefined,
              updatedAt: 12,
            },
            clearLeaseToken: true,
            clearHeartbeat: true,
          });
        }
      }
      return await super.transitionRun(input);
    }
  }

  const store = new ClaimAndRequeueBeforeCancelStore();
  await seedApply(store, {
    capsuleId: "cap_plan_cancel_requeue_race",
    planRunId: "plan_cancel_requeue_race",
    applyRunId: "apply_plan_cancel_requeue_race",
  });
  const planRun = (await store.getPlanRun("plan_cancel_requeue_race"))!;
  await store.putPlanRun({ ...planRun, status: "queued", updatedAt: 2 });
  const planInputs = await store.getPlanRunInputs(planRun.id);
  const controller = controllerWith(store);

  await expect(controller.cancelRun(planRun.id)).rejects.toThrow(
    /has already started/,
  );
  expect(await store.getPlanRun(planRun.id)).toMatchObject({
    status: "queued",
    startedAt: 10,
    updatedAt: 12,
  });
  expect(await store.getPlanRunInputs(planRun.id)).toEqual(planInputs);
});

test("cancel loses when an apply is started and requeued between its read and CAS", async () => {
  class RequeueBeforeCancelStore extends InMemoryOpenTofuControlStore {
    #interceptCancel = true;

    override async transitionRun(
      input: TransitionRunInput,
    ): Promise<TransitionRunResult> {
      if (
        this.#interceptCancel &&
        input.kind === "apply" &&
        input.run.status === "cancelled"
      ) {
        this.#interceptCancel = false;
        const current = await this.getApplyRun(input.id);
        if (current) {
          await this.putApplyRun({
            ...current,
            status: "queued",
            startedAt: 10,
            updatedAt: 12,
          });
        }
      }
      return await super.transitionRun(input);
    }
  }

  const store = new RequeueBeforeCancelStore();
  await seedApply(store, {
    capsuleId: "cap_cancel_requeue_race",
    planRunId: "plan_cancel_requeue_race",
    applyRunId: "apply_cancel_requeue_race",
  });
  const controller = controllerWith(store);

  await expect(
    controller.cancelRun("apply_cancel_requeue_race"),
  ).rejects.toThrow(/has already started/);
  expect(await store.getApplyRun("apply_cancel_requeue_race")).toMatchObject({
    status: "queued",
    startedAt: 10,
    updatedAt: 12,
  });
});

test("cancel that wins forces a later PLAN claim to lose (no dispatch)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // Seed a queued plan directly so we can race cancel vs the plan claim.
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "ws_plan_cancel",
    capsuleId: "cap_plan_cancel",
  });
  const planRun: PlanRun = {
    id: "plan_pc",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    source: { kind: "git", url: "https://example.test/x.git", ref: "main" },
    sourceDigest: "sha256:src",
    variablesDigest: "sha256:vars",
    operation: "update",
    runnerProfileId: "opentofu-default",
    requiredProviders: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(planRun);
  let planned = false;
  const controller = new OpenTofuController({
    store,
    now: () => 1,
    newId: (p) => `${p}_x`,
    runner: {
      plan: () => {
        planned = true;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  const cancelled = await controller.cancelRun("plan_pc");
  expect(cancelled.status).toBe("cancelled");

  const result = await controller.runQueuedPlan("plan_pc");
  expect(planned).toBe(false);
  expect(result?.status).toBe("cancelled");
});

test("two concurrent queued claims for the same apply: exactly one dispatches", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_race0001",
    planRunId: "plan_race",
    applyRunId: "apply_race",
  });
  let applyCalls = 0;
  const controller = controllerWith(store, {
    apply: () => {
      applyCalls += 1;
      return Promise.resolve(fixtureStateCommit());
    },
  });

  // Race two consumers claiming the SAME queued apply. The fenced claim CAS
  // (expectFrom 'queued') lets exactly one win; the loser must not dispatch.
  const [a, b] = await Promise.all([
    controller.runQueuedApply("apply_race"),
    controller.runQueuedApply("apply_race"),
  ]);

  expect(applyCalls).toBe(1);
  const statuses = [a.applyRun.status, b.applyRun.status].sort();
  // The winner reaches `succeeded`; the loser observes the winner's row (either
  // still `running` if it lost mid-flight, or the final `succeeded`). It never
  // re-runs the apply.
  expect(statuses.every((s) => s === "running" || s === "succeeded")).toBe(
    true,
  );
  expect((await store.getApplyRun("apply_race"))?.status).toBe("succeeded");
});

// --- heartbeat + lease renewal during a long apply ---

async function settleAsyncUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 500 && !predicate(); index++) {
    await Promise.resolve();
    if (index % 20 === 19) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  expect(predicate()).toBe(true);
}

function awaitExecutionAbort(control: RunExecutionControl | undefined): Promise<OpenTofuApplyResult> {
  const signal = control?.signal;
  if (!signal) throw new Error("fixture runner requires an execution signal");
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<OpenTofuApplyResult>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function seedRenewableApplyFixture(
  store: InMemoryOpenTofuControlStore,
  label: string,
  onIssue?: (count: number) => Promise<void>,
  issueExpiry?: (input: {
    readonly issues: number;
    readonly attemptRef: string;
  }) => string,
): Promise<{
  readonly applyRunId: string;
  readonly planRunId: string;
  readonly vault: ConnectionVault;
  readonly issueCount: () => number;
  readonly issuanceGenerationRefs: () => readonly string[];
}> {
  const provider = "registry.opentofu.org/cloudflare/cloudflare";
  const capsuleId = `cap_${label}`;
  const planRunId = `plan_${label}`;
  const applyRunId = `apply_${label}`;
  await seedApply(store, {
    capsuleId,
    planRunId,
    applyRunId,
    requiredProviders: [provider],
  });
  const workspaceId = `ws_${capsuleId}`;
  const connectionId = `conn_fixture_${workspaceId}_cloudflare`;
  const original = await store.getConnection(connectionId);
  if (!original) throw new Error("renewable fixture connection is missing");
  await store.putConnection({
    ...original,
    materialization: "run-issued",
    credentialRecipe: {
      id: "test-renewable", authMode: "run",
      envNames: ["CLOUDFLARE_API_TOKEN"], fileEnvNames: [],
      requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
      renewableEnv: {
        sourceEnvName: "CLOUDFLARE_API_TOKEN",
        fileEnvName: "CLOUDFLARE_API_TOKEN_FILE",
        minimumProviderVersion: "1.0.0",
      },
    },
  });
  let issues = 0;
  const issuanceGenerationRefs: string[] = [];
  const vault = {
    mintForCapsuleProviderBindings: async (
      _workspaceId: string,
      _entries: unknown,
      options?: { readonly issuanceGenerationRef?: string },
    ) => {
      issues += 1;
      const attemptRef = options?.issuanceGenerationRef ?? "";
      issuanceGenerationRefs.push(attemptRef);
      await onIssue?.(issues);
      const token = `local_renewable_token_${issues}_0123456789abcdef`;
      const issuedAt = Date.now();
      const expiresAt = issueExpiry
        ? issueExpiry({ issues, attemptRef })
        : new Date(issuedAt + 121_000).toISOString();
      return new PhaseMintBundle(
        { env: { CLOUDFLARE_API_TOKEN: token } }, [],
        [{ provider, connectionId, temporary: true, ttlEnforced: true,
          ttlSeconds: Math.round((Date.parse(expiresAt) - issuedAt) / 1000),
          expiresAt }],
      );
    },
  } as unknown as ConnectionVault;
  return {
    applyRunId,
    planRunId,
    vault,
    issueCount: () => issues,
    issuanceGenerationRefs: () => issuanceGenerationRefs,
  };
}

test("renewable ApplyRun reissues before expiry and stops after terminal result", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId, planRunId, vault, issueCount, issuanceGenerationRefs } =
    await seedRenewableApplyFixture(store, "credential_renewal");
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let completeApply!: (value: OpenTofuApplyResult) => void;
  let applySignal: AbortSignal | undefined;
  const refreshes: unknown[] = [];
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async (update) => { refreshes.push(update); },
      apply: async (_job, control) => {
        applySignal = control?.signal;
        resolveStarted();
        return await new Promise<OpenTofuApplyResult>((resolve) => {
          completeApply = resolve;
        });
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    expect(issueCount()).toBe(1);
    jest.advanceTimersByTime(31_000);
    // Renewal includes a fresh Run/lease CAS and the full broker policy path;
    // drain those asynchronous continuations without advancing the expiry clock.
    await settleAsyncUntil(() => refreshes.length === 1);
    expect(issueCount()).toBe(2);
    expect(issuanceGenerationRefs()).toHaveLength(2);
    expect(issuanceGenerationRefs()[0]).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(issuanceGenerationRefs()[1]).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(issuanceGenerationRefs()[1]).not.toBe(issuanceGenerationRefs()[0]);
    expect(applySignal?.aborted).toBe(false);
    expect(refreshes).toMatchObject([{
      owner: { kind: "apply", id: applyRunId },
      runnerRunId: planRunId,
      sequence: 1,
      credentials: [{ value: "local_renewable_token_2_0123456789abcdef" }],
    }]);
    completeApply(fixtureStateCommit({
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
    }));
    const response = await pending;
    expect(response.applyRun.status).toBe("succeeded");
    const accepted = (await store.getApplyRun(applyRunId))?.auditEvents.filter(
      (event) => event.type === "credential.refresh.accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted?.[0]?.data).toMatchObject({
      sequence: 1,
      connectionId: "conn_fixture_ws_cap_credential_renewal_cloudflare",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      acknowledgedAt: expect.any(String),
      previousExpiresAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    const logs = await controller.getRunLogs(applyRunId);
    expect(logs.auditEvents).toContainEqual(accepted?.[0]);
    expect(logs.credentialMints.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain("local_renewable_token_");
    jest.advanceTimersByTime(300_000);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(issueCount()).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});

test("a renewal never replays the retained issuance identity of the initial mint", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let retainedExpiry = "";
  let retainedAttemptRef = "";
  const { applyRunId, vault, issueCount, issuanceGenerationRefs } =
    await seedRenewableApplyFixture(store, "credential_replay", undefined, ({
      issues,
      attemptRef,
    }) => {
      if (issues === 1) {
        retainedAttemptRef = attemptRef;
        retainedExpiry = new Date(Date.now() + 121_000).toISOString();
        return retainedExpiry;
      }
      // The sponsorship authority retains one issuance operation per exact
      // exchange identity and replays its bytes. A renewal that reuses the
      // initial exchange identity therefore receives the already-issued
      // expiry -- the observed production failure -- while a distinct renewal
      // attempt buys a new lifetime.
      return attemptRef === retainedAttemptRef
        ? retainedExpiry
        : new Date(Date.now() + 300_000).toISOString();
    });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const refreshes: unknown[] = [];
  let applySignal: AbortSignal | undefined;
  let abortedWith: unknown;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async (update) => { refreshes.push(update); },
      apply: async (_job, control) => {
        applySignal = control?.signal;
        resolveStarted();
        try {
          return await awaitExecutionAbort(control);
        } catch (error) {
          abortedWith ??= error;
          throw error;
        }
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    void pending.catch(() => {});
    await started;
    expect(issueCount()).toBe(1);
    jest.advanceTimersByTime(31_000);
    await settleAsyncUntil(
      () => refreshes.length === 1 || (applySignal?.aborted ?? false),
    );
    // Delivery is the contract: a replayed issuance leaves the pinned
    // binding with too little lifetime, and the observed production failure
    // aborts the child with `renewed credential does not match the pinned
    // binding` instead of delivering a refreshed credential.
    expect(abortedWith).toBeUndefined();
    expect(refreshes).toHaveLength(1);
    expect(applySignal?.aborted).toBe(false);
    expect(issuanceGenerationRefs()).toHaveLength(2);
    expect(issuanceGenerationRefs()[1]).not.toBe(issuanceGenerationRefs()[0]);
  } finally {
    jest.useRealTimers();
  }
});

test("an acknowledged refresh waits for durable audit before terminal Apply commit", async () => {
  let enteredAudit!: () => void;
  const auditEntered = new Promise<void>((resolve) => { enteredAudit = resolve; });
  let releaseAudit!: () => void;
  const auditRelease = new Promise<void>((resolve) => { releaseAudit = resolve; });
  class DeferredAuditStore extends InMemoryOpenTofuControlStore {
    override async appendRunningRunAuditEvent(
      input: AppendRunningRunAuditEventInput,
    ): Promise<boolean> {
      enteredAudit();
      await auditRelease;
      return await super.appendRunningRunAuditEvent(input);
    }
  }
  const store = new DeferredAuditStore();
  const { applyRunId, vault } = await seedRenewableApplyFixture(store, "refresh_audit_deferred");
  let startedApply!: () => void;
  const started = new Promise<void>((resolve) => { startedApply = resolve; });
  let completeApply!: (value: OpenTofuApplyResult) => void;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async () => {},
      apply: async () => {
        startedApply();
        return await new Promise<OpenTofuApplyResult>((resolve) => {
          completeApply = resolve;
        });
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    let settled = false;
    void pending.then(() => { settled = true; });
    await started;
    jest.advanceTimersByTime(31_000);
    await auditEntered;
    completeApply(fixtureStateCommit({
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
    }));
    jest.advanceTimersByTime(101);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(settled).toBe(false);
    expect((await store.getApplyRun(applyRunId))?.status).toBe("running");
    releaseAudit();
    expect((await pending).applyRun.status).toBe("succeeded");
    expect((await store.getApplyRun(applyRunId))?.auditEvents.some(
      (event) => event.type === "credential.refresh.accepted",
    )).toBe(true);
  } finally {
    releaseAudit();
    jest.useRealTimers();
  }
});

test("an ACK arriving during bounded teardown still waits for its audit write", async () => {
  let enteredAudit!: () => void;
  const auditEntered = new Promise<void>((resolve) => { enteredAudit = resolve; });
  let releaseAudit!: () => void;
  const auditRelease = new Promise<void>((resolve) => { releaseAudit = resolve; });
  class DeferredAuditStore extends InMemoryOpenTofuControlStore {
    override async appendRunningRunAuditEvent(
      input: AppendRunningRunAuditEventInput,
    ): Promise<boolean> {
      enteredAudit();
      await auditRelease;
      return await super.appendRunningRunAuditEvent(input);
    }
  }
  const store = new DeferredAuditStore();
  const { applyRunId, vault } = await seedRenewableApplyFixture(store, "refresh_ack_during_teardown");
  let startedApply!: () => void;
  const started = new Promise<void>((resolve) => { startedApply = resolve; });
  let enteredRefresh!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { enteredRefresh = resolve; });
  let acknowledgeRefresh!: () => void;
  const refreshAck = new Promise<void>((resolve) => { acknowledgeRefresh = resolve; });
  let completeApply!: (value: OpenTofuApplyResult) => void;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async () => {
        enteredRefresh();
        await refreshAck;
      },
      apply: async () => {
        startedApply();
        return await new Promise<OpenTofuApplyResult>((resolve) => {
          completeApply = resolve;
        });
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    let settled = false;
    void pending.then(() => { settled = true; });
    await started;
    jest.advanceTimersByTime(31_000);
    await refreshEntered;
    completeApply(fixtureStateCommit({
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
    }));
    for (let index = 0; index < 10; index++) await Promise.resolve();
    acknowledgeRefresh();
    await auditEntered;
    jest.advanceTimersByTime(101);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(settled).toBe(false);
    expect((await store.getApplyRun(applyRunId))?.status).toBe("running");
    releaseAudit();
    expect((await pending).applyRun.status).toBe("succeeded");
    expect((await store.getApplyRun(applyRunId))?.auditEvents.some(
      (event) => event.type === "credential.refresh.accepted",
    )).toBe(true);
  } finally {
    acknowledgeRefresh();
    releaseAudit();
    jest.useRealTimers();
  }
});

test("an unresolved dispatched refresh cannot publish a successful Apply", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId, vault } = await seedRenewableApplyFixture(store, "refresh_ack_unresolved");
  let startedApply!: () => void;
  const started = new Promise<void>((resolve) => { startedApply = resolve; });
  let enteredRefresh!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { enteredRefresh = resolve; });
  let releaseRefresh!: () => void;
  const refreshRelease = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let completeApply!: (value: OpenTofuApplyResult) => void;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async () => {
        enteredRefresh();
        await refreshRelease;
      },
      apply: async () => {
        startedApply();
        return await new Promise<OpenTofuApplyResult>((resolve) => {
          completeApply = resolve;
        });
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    jest.advanceTimersByTime(31_000);
    await refreshEntered;
    completeApply(fixtureStateCommit({
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
    }));
    for (let index = 0; index < 10; index++) await Promise.resolve();
    jest.advanceTimersByTime(101);
    const response = await pending;
    expect(response.applyRun.status).not.toBe("succeeded");
    expect((await store.getApplyRun(applyRunId))?.auditEvents.some(
      (event) => event.type === "credential.refresh.accepted",
    )).toBe(false);
  } finally {
    releaseRefresh();
    jest.useRealTimers();
  }
});

test("a refresh rejected during teardown cannot publish a successful Apply or ack", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId, vault } = await seedRenewableApplyFixture(store, "refresh_reject_teardown");
  let startedApply!: () => void;
  const started = new Promise<void>((resolve) => { startedApply = resolve; });
  let enteredRefresh!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { enteredRefresh = resolve; });
  let rejectRefresh!: (error: Error) => void;
  const refreshResult = new Promise<void>((_resolve, reject) => { rejectRefresh = reject; });
  let completeApply!: (value: OpenTofuApplyResult) => void;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async () => {
        enteredRefresh();
        await refreshResult;
      },
      apply: async () => {
        startedApply();
        return await new Promise<OpenTofuApplyResult>((resolve) => {
          completeApply = resolve;
        });
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    jest.advanceTimersByTime(31_000);
    await refreshEntered;
    completeApply(fixtureStateCommit({
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
    }));
    for (let index = 0; index < 10; index++) await Promise.resolve();
    rejectRefresh(new Error("refresh delivery failed during teardown"));
    expect((await pending).applyRun.status).not.toBe("succeeded");
    expect((await store.getApplyRun(applyRunId))?.auditEvents.some(
      (event) => event.type === "credential.refresh.accepted",
    )).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test("refresh acknowledgement survives stale heartbeat and terminal writes but a stale owner cannot append", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId } = await seedRenewableApplyFixture(store, "refresh_audit_cas");
  const queued = await store.getApplyRun(applyRunId);
  if (!queued) throw new Error("Apply fixture is missing");
  const claim = await store.transitionRun({
    id: applyRunId,
    kind: "apply",
    expectFrom: ["queued"],
    run: { ...queued, status: "running", heartbeatAt: 10 },
    setLeaseToken: "owner-a",
    heartbeatAt: 10,
  });
  expect(claim.won).toBe(true);
  const stale = claim.run as ApplyRun;
  const event = {
    id: `${applyRunId}:credential.refresh.accepted:1`,
    type: "credential.refresh.accepted",
    at: 11,
    data: { sequence: 1, connectionId: "conn_fixture", provider: "cloudflare" },
  };
  expect(await store.appendRunningRunAuditEvent({
    id: applyRunId, kind: "apply", workspaceId: stale.workspaceId,
    leaseToken: "owner-a", event,
  })).toBe(true);
  expect((await store.transitionRun({
    id: applyRunId, kind: "apply", expectFrom: ["running"],
    expectLeaseToken: "owner-a", heartbeatAt: 12,
    run: { ...stale, heartbeatAt: 12, updatedAt: 12 },
  })).won).toBe(true);
  const finished = await store.transitionRun({
    id: applyRunId, kind: "apply", expectFrom: ["running"],
    expectLeaseToken: "owner-a", clearLeaseToken: true,
    run: { ...stale, status: "failed", updatedAt: 13, finishedAt: 13 },
  });
  expect(finished.won).toBe(true);
  expect((await store.getApplyRun(applyRunId))?.auditEvents.filter(
    (item) => item.type === "credential.refresh.accepted",
  )).toEqual([event]);
  expect(await store.appendRunningRunAuditEvent({
    id: applyRunId, kind: "apply", workspaceId: stale.workspaceId,
    leaseToken: "owner-a", event: { ...event, id: `${event.id}:late` },
  })).toBe(false);
});

test("a stale-running successor may record its first refresh without colliding with the prior attempt", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId } = await seedRenewableApplyFixture(store, "refresh_audit_takeover");
  const queued = await store.getApplyRun(applyRunId);
  if (!queued) throw new Error("Apply fixture is missing");
  const first = await store.transitionRun({
    id: applyRunId, kind: "apply", expectFrom: ["queued"],
    run: { ...queued, status: "running", heartbeatAt: 10 },
    setLeaseToken: "owner-a", heartbeatAt: 10,
  });
  expect(first.won).toBe(true);
  const running = first.run as ApplyRun;
  const event = {
    type: "credential.refresh.accepted", at: 11,
    data: { sequence: 1, connectionId: "conn_fixture", provider: "cloudflare" },
  };
  expect(await store.appendRunningRunAuditEvent({
    id: applyRunId, kind: "apply", workspaceId: running.workspaceId,
    leaseToken: "owner-a", event: { ...event, id: "attempt-a-ack" },
  })).toBe(true);
  const takeover = await store.transitionRun({
    id: applyRunId, kind: "apply", expectFrom: ["running"],
    expectHeartbeatAt: 10,
    run: { ...running, heartbeatAt: 20, updatedAt: 20 },
    setLeaseToken: "owner-b", heartbeatAt: 20,
  });
  expect(takeover.won).toBe(true);
  expect(await store.appendRunningRunAuditEvent({
    id: applyRunId, kind: "apply", workspaceId: running.workspaceId,
    leaseToken: "owner-a", event: { ...event, id: "attempt-a-late" },
  })).toBe(false);
  expect(await store.appendRunningRunAuditEvent({
    id: applyRunId, kind: "apply", workspaceId: running.workspaceId,
    leaseToken: "owner-b", event: { ...event, id: "attempt-b-ack" },
  })).toBe(true);
  expect((await store.getApplyRun(applyRunId))?.auditEvents.filter(
    (item) => item.type === "credential.refresh.accepted",
  ).map((item) => item.id)).toEqual(["attempt-a-ack", "attempt-b-ack"]);
});

test("renewable PlanRun refreshes under its own plan owner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { planRunId, vault, issueCount } =
    await seedRenewableApplyFixture(store, "plan_credential_renewal");
  const prepared = await store.getPlanRun(planRunId);
  if (!prepared) throw new Error("renewable Plan fixture is missing");
  await store.putPlanRun({
    ...prepared,
    status: "queued",
    planDigest: undefined,
    planArtifact: undefined,
    policyDecisionDigest: undefined,
  });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let resolveRefreshEntered!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { resolveRefreshEntered = resolve; });
  let completePlan!: (value: OpenTofuPlanResult) => void;
  const refreshes: unknown[] = [];
  const capabilities: unknown[] = [];
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async (input) => { capabilities.push(input); },
      refreshCredentials: async (update) => {
        refreshes.push(update);
        resolveRefreshEntered();
      },
      plan: async () => {
        resolveStarted();
        return await new Promise<OpenTofuPlanResult>((resolve) => {
          completePlan = resolve;
        });
      },
    });
    const pending = controller.runQueuedPlan(planRunId);
    await started;
    expect(capabilities).toMatchObject([{
      owner: { kind: "plan", id: planRunId },
      runnerRunId: planRunId,
    }]);
    jest.advanceTimersByTime(31_000);
    await refreshEntered;
    expect(issueCount()).toBe(2);
    expect(refreshes).toMatchObject([{
      owner: { kind: "plan", id: planRunId },
      runnerRunId: planRunId,
      sequence: 1,
    }]);
    completePlan({
      planDigest: PLAN_DIGEST,
      planArtifact: planArtifact(),
      providerLockDigest: LOCK_DIGEST,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
    });
    const result = await pending;
    expect(result?.status).toBe("succeeded");
    const timingDiagnostics = result?.diagnostics?.filter(
      (diagnostic) => diagnostic.code === "core_plan_elapsed_timings",
    );
    expect(timingDiagnostics).toHaveLength(1);
    const timings = JSON.parse(timingDiagnostics?.[0]?.detail ?? "null") as
      Record<string, unknown>;
    expect(Object.keys(timings).sort()).toEqual([
      "brokerBindingResolutionMs",
      "brokerPrePolicyMs",
      "brokerRuntimeInputsMs",
      "claimMs",
      "credentialMintMs",
      "credentialValidationMs",
      "dispatchPreparationMs",
      "postMintPolicyAuditMs",
      "preClaimPreparationMs",
      "providerBindingResolutionMs",
      "renewalOutsideRunnerMs",
      "resolveRunEnvironmentMs",
      "runnerPlanMs",
      "vaultMintMs",
    ].sort());
    expect(Object.values(timings).every((value) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
    )).toBe(true);
    expect(JSON.stringify(result?.diagnostics)).not.toContain(
      "local_renewable_token",
    );
  } finally {
    jest.useRealTimers();
  }
});

test("renewable provider floor rejects a selected older version before runner dispatch", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId, planRunId, vault } =
    await seedRenewableApplyFixture(store, "refresh_provider_floor");
  const planRun = await store.getPlanRun(planRunId);
  if (!planRun?.requiredProviderRequirements) {
    throw new Error("renewable floor fixture Plan provider requirement is missing");
  }
  await store.putPlanRun({
    ...planRun,
    requiredProviderRequirements: planRun.requiredProviderRequirements.map(
      (requirement) => ({ ...requirement, version: "4.0.0" }),
    ),
  });
  const connectionId = "conn_fixture_ws_cap_refresh_provider_floor_cloudflare";
  const connection = await store.getConnection(connectionId);
  if (!connection?.credentialRecipe?.renewableEnv) {
    throw new Error("renewable floor fixture connection is missing");
  }
  await store.putConnection({
    ...connection,
    credentialRecipe: {
      ...connection.credentialRecipe,
      renewableEnv: {
        ...connection.credentialRecipe.renewableEnv,
        minimumProviderVersion: "4.1.0",
      },
    },
  });
  let capabilityChecks = 0;
  let applyCalls = 0;
  const controller = controllerWith(store, {
    vault,
    now: () => Date.parse("2026-09-27T07:00:00.000Z"),
    assertCredentialRefreshCapability: async () => { capabilityChecks += 1; },
    refreshCredentials: async () => {},
    apply: async () => {
      applyCalls += 1;
      return fixtureStateCommit();
    },
  });
  const response = await controller.runQueuedApply(applyRunId);
  expect(response.applyRun.status).toBe("failed");
  expect(response.applyRun.diagnostics?.map((item) => item.code)).toContain(
    "renewable_provider_version_unproven",
  );
  expect(capabilityChecks).toBe(0);
  expect(applyCalls).toBe(0);
});

test("a delayed runner capability probe cannot dispatch an expired initial credential", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId, vault, issueCount } =
    await seedRenewableApplyFixture(store, "refresh_delayed_capability");
  let resolveProbeStarted!: () => void;
  const probeStarted = new Promise<void>((resolve) => { resolveProbeStarted = resolve; });
  let releaseProbe!: () => void;
  const probeHold = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let applyCalls = 0;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {
        resolveProbeStarted();
        await probeHold;
      },
      refreshCredentials: async () => {},
      apply: async () => {
        applyCalls += 1;
        return fixtureStateCommit();
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await probeStarted;
    expect(issueCount()).toBe(1);
    jest.advanceTimersByTime(121_000);
    releaseProbe();
    const response = await pending;
    expect(response.applyRun.status).toBe("failed");
    expect(response.applyRun.diagnostics?.map((item) => item.code)).toContain(
      "credential_service_unavailable",
    );
    expect(applyCalls).toBe(0);
    expect(issueCount()).toBe(1);
  } finally {
    releaseProbe();
    jest.useRealTimers();
  }
});

test("renewable ApplyRun loses its Run fence before mint and delivers nothing", async () => {
  const store = new LoseApplyHeartbeatStore();
  const { applyRunId, vault, issueCount } =
    await seedRenewableApplyFixture(store, "refresh_lost_run_before_mint");
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const refreshes: unknown[] = [];
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async (update) => { refreshes.push(update); },
      apply: async (_job, control) => {
        resolveStarted();
        return await awaitExecutionAbort(control);
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    expect(issueCount()).toBe(1);
    store.loseHeldRun = true;
    jest.advanceTimersByTime(31_000);
    const response = await pending;
    expect(response.applyRun.status).toBe("failed");
    expect(response.applyRun.diagnostics?.map((item) => item.code)).toContain("run_heartbeat_lost");
    expect(issueCount()).toBe(1);
    expect(refreshes).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test("renewable ApplyRun discards an issued value when Capsule lease is lost during mint", async () => {
  const store = new HeartbeatCountingStore();
  let secondMintStarted = false;
  let releaseSecondMint!: () => void;
  const secondMintHold = new Promise<void>((resolve) => { releaseSecondMint = resolve; });
  const { applyRunId, vault, issueCount } =
    await seedRenewableApplyFixture(store, "refresh_lost_capsule_during_mint", async (count) => {
      if (count === 2) {
        secondMintStarted = true;
        await secondMintHold;
      }
    });
  let loseCapsuleLease = false;
  const inner = new InMemoryCapsuleCoordination({ now: () => Date.now() });
  const coordination: CapsuleCoordination = {
    acquireLease: (input) => inner.acquireLease(input),
    releaseLease: (input) => inner.releaseLease(input),
    renewLease: async (input) => loseCapsuleLease
      ? {
          scope: input.scope,
          holderId: input.holderId,
          token: input.token,
          acquired: false,
          expiresAt: new Date(Date.now()).toISOString(),
        }
      : await inner.renewLease(input),
  };
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const refreshes: unknown[] = [];
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, coordination, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async (update) => { refreshes.push(update); },
      apply: async (_job, control) => {
        resolveStarted();
        return await awaitExecutionAbort(control);
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    jest.advanceTimersByTime(31_000);
    await settleAsyncUntil(() => secondMintStarted);
    loseCapsuleLease = true;
    releaseSecondMint();
    const response = await pending;
    expect(response.applyRun.status).toBe("failed");
    expect(response.applyRun.diagnostics?.map((item) => item.code)).toContain("capsule_lease_lost");
    expect(issueCount()).toBe(2);
    expect(refreshes).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test("refresh failure preserves a typed provider-failed partial-state receipt", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId, vault } =
    await seedRenewableApplyFixture(store, "refresh_partial_state");
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let refreshAttempts = 0;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async () => {
        refreshAttempts += 1;
        throw new Error("refresh delivery unavailable");
      },
      apply: async (job, control) => {
        resolveStarted();
        const signal = control?.signal;
        if (!signal) throw new Error("fixture runner requires a signal");
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
        }
        return fixtureStateCommit({
          providerExecutionFailure: {
            kind: "provider_execution_failed" as const,
            statePersistence: "persisted" as const,
            errorCode: "partial_provider_failure",
          },
          providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
          executionEvidence: fixtureExecutionEvidence(job, "apply", {
            outcome: "provider_failed_state_persisted",
          }),
        });
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    jest.advanceTimersByTime(31_000);
    const response = await pending;
    expect(refreshAttempts).toBe(1);
    expect(response.applyRun.status).toBe("failed");
    expect(response.applyRun.diagnostics?.map((item) => item.code)).toContain(
      "partial_provider_failure",
    );
    const capsule = await store.getCapsule(response.applyRun.capsuleId!);
    expect(capsule?.currentStateGeneration).toBe(1);
    expect(capsuleRuntimeSafetyFromRun(response.applyRun).phase).toBe("unknown");
  } finally {
    jest.useRealTimers();
  }
});

test("refresh failure cannot turn a late successful Apply receipt into a succeeded Run", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId, vault } =
    await seedRenewableApplyFixture(store, "refresh_late_apply_success");
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let returnedStateDigest: string | undefined;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async () => { throw new Error("refresh delivery unavailable"); },
      apply: async (_job, control) => {
        resolveStarted();
        const signal = control?.signal;
        if (!signal) throw new Error("fixture runner requires a signal");
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
        }
        const result = fixtureStateCommit({
          providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        });
        returnedStateDigest = result.stateDigest;
        return result;
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    jest.advanceTimersByTime(31_000);
    const response = await pending;
    expect(returnedStateDigest).toBeDefined();
    expect(response.applyRun.status).toBe("failed");
    expect((await store.getApplyRun(applyRunId))?.auditEvents.some(
      (event) => event.type === "credential.refresh.accepted",
    )).toBe(false);
    expect(response.applyRun.auditEvents.some((event) =>
      event.data?.providerDispatched === true
    )).toBe(true);
    expect(capsuleRuntimeSafetyFromRun(response.applyRun).phase).toBe("unknown");
  } finally {
    jest.useRealTimers();
  }
});

test("refresh failure cannot publish a late successful Plan artifact or timing", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { planRunId, vault } =
    await seedRenewableApplyFixture(store, "refresh_late_plan_success");
  const prepared = await store.getPlanRun(planRunId);
  if (!prepared) throw new Error("renewable Plan fixture is missing");
  await store.putPlanRun({
    ...prepared,
    status: "queued",
    planDigest: undefined,
    planArtifact: undefined,
    policyDecisionDigest: undefined,
  });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async () => { throw new Error("refresh delivery unavailable"); },
      plan: async (_job, control) => {
        resolveStarted();
        const signal = control?.signal;
        if (!signal) throw new Error("fixture runner requires a signal");
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
        }
        return {
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
          providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        };
      },
    });
    const pending = controller.runQueuedPlan(planRunId);
    await started;
    jest.advanceTimersByTime(31_000);
    const result = await pending;
    expect(result?.status).toBe("failed");
    expect(result?.planDigest).toBeUndefined();
    expect(result?.planArtifact).toBeUndefined();
    expect(result?.diagnostics?.some((diagnostic) =>
      diagnostic.code === "core_plan_elapsed_timings"
    )).toBeFalsy();
  } finally {
    jest.useRealTimers();
  }
});

test("an unknown Apply blocks a credentialless new Apply on the stale state generation", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const capsuleId = "cap_unknown_credentialless_apply";
  const applyRunId = "apply_unknown_credentialless_original";
  await seedApply(store, {
    capsuleId,
    planRunId: "plan_unknown_credentialless_apply",
    applyRunId,
  });
  const original = await store.getApplyRun(applyRunId);
  if (!original) throw new Error("original Apply fixture is missing");
  await store.putApplyRun({
    ...original,
    status: "failed",
    startedAt: 2,
    finishedAt: 3,
    updatedAt: 3,
    auditEvents: [{
      id: "audit_unknown_credentialless_original",
      type: "apply.failed",
      at: 3,
      data: { providerDispatched: true },
    }],
  });
  expect(await store.getCapsuleRuntimeSafety(capsuleId)).toMatchObject({
    phase: "unknown",
    runId: applyRunId,
  });
  const subsequentId = "apply_unknown_credentialless_subsequent";
  const capsule = await store.getCapsule(capsuleId);
  const management = await store.getWorkspaceManagement(original.workspaceId);
  if (!capsule || !management) throw new Error("admission fixture is missing");
  const admission = await store.beginApplyRun({
    ...original,
    id: subsequentId,
    status: "queued",
    auditEvents: [],
    updatedAt: 4,
  }, {
    workspaceId: original.workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  }, capsuleApplyRunAdmissionFence(
    capsule,
    await store.getCapsuleExecutionAuthorityEpoch(capsuleId) ?? 1,
  ));
  expect(admission.status).toBe("created");
  let providerDispatches = 0;
  const response = await controllerWith(store, {
    now: () => 5,
    apply: async () => {
      providerDispatches += 1;
      return fixtureStateCommit();
    },
  }).runQueuedApply(subsequentId);
  expect(response.applyRun.status).toBe("failed");
  expect(response.applyRun.diagnostics?.map((item) => item.code)).toContain(
    "runtime_safety_mismatch",
  );
  expect(providerDispatches).toBe(0);
  expect(await store.getCapsuleRuntimeSafety(capsuleId)).toMatchObject({
    phase: "unknown",
    runId: applyRunId,
  });
});

test("an unknown Apply blocks a credentialless ordinary Destroy beneath its own terminating projection", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const capsuleId = "cap_unknown_credentialless_destroy";
  const originalId = "apply_unknown_before_destroy";
  const planRunId = "plan_unknown_credentialless_destroy";
  await seedApply(store, { capsuleId, planRunId, applyRunId: originalId });
  const original = await store.getApplyRun(originalId);
  const plan = await store.getPlanRun(planRunId);
  if (!original || !plan) throw new Error("Destroy fixture is missing");
  await store.putApplyRun({
    ...original,
    status: "failed",
    startedAt: 2,
    finishedAt: 3,
    updatedAt: 3,
    auditEvents: [{
      id: "audit_unknown_before_destroy",
      type: "apply.failed",
      at: 3,
      data: { providerDispatched: true },
    }],
  });
  await store.putPlanRun({ ...plan, operation: "destroy" });
  const destroyId = "destroy_unknown_credentialless_subsequent";
  const capsule = await store.getCapsule(capsuleId);
  const management = await store.getWorkspaceManagement(original.workspaceId);
  if (!capsule || !management) throw new Error("Destroy admission fixture is missing");
  const admission = await store.beginApplyRun({
    ...original,
    id: destroyId,
    operation: "destroy",
    status: "queued",
    auditEvents: [],
    updatedAt: 4,
  }, {
    workspaceId: original.workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  }, capsuleApplyRunAdmissionFence(
    capsule,
    await store.getCapsuleExecutionAuthorityEpoch(capsuleId) ?? 1,
  ));
  expect(admission.status).toBe("created");
  expect(await store.getCapsuleRuntimeSafety(capsuleId)).toMatchObject({
    phase: "terminating",
    runId: destroyId,
  });
  expect(await store.getCapsuleRuntimeSafety(capsuleId, {
    excludeRunId: destroyId,
  })).toMatchObject({ phase: "unknown", runId: originalId });
  let providerDispatches = 0;
  const response = await controllerWith(store, {
    now: () => 5,
    destroy: async () => {
      providerDispatches += 1;
      throw new Error("Destroy must not dispatch against unknown state");
    },
  }).runQueuedApply(destroyId);
  expect(response.applyRun.status).toBe("failed");
  expect(response.applyRun.diagnostics?.map((item) => item.code)).toContain(
    "runtime_safety_mismatch",
  );
  expect(providerDispatches).toBe(0);
  expect(await store.getCapsuleRuntimeSafety(capsuleId, {
    excludeRunId: destroyId,
  })).toMatchObject({ phase: "unknown", runId: originalId });
});

test("refresh failure without runner receipt remains unknown after dispatch", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { applyRunId, vault } =
    await seedRenewableApplyFixture(store, "refresh_unknown_receipt");
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let applyCalls = 0;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async () => { throw new Error("refresh delivery unavailable"); },
      apply: async (_job, control) => {
        applyCalls += 1;
        resolveStarted();
        try {
          return await awaitExecutionAbort(control);
        } catch {
          throw new DOMException("runner fetch aborted without receipt", "AbortError");
        }
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    jest.advanceTimersByTime(31_000);
    const response = await pending;
    expect(response.applyRun.status).toBe("failed");
    expect(applyCalls).toBe(1);
    expect(response.applyRun.auditEvents.some((event) =>
      event.data?.providerDispatched === true
    )).toBe(true);
    expect(capsuleRuntimeSafetyFromRun(response.applyRun).phase).toBe("unknown");
  } finally {
    jest.useRealTimers();
  }
});

test("expired credential aborts the child and never adopts a late mint", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let secondMintStarted = false;
  let secondMintReturned = false;
  let releaseSecondMint!: () => void;
  const secondMintHold = new Promise<void>((resolve) => { releaseSecondMint = resolve; });
  const { applyRunId, vault, issueCount } =
    await seedRenewableApplyFixture(store, "refresh_expiry_watchdog", async (count) => {
      if (count === 2) {
        secondMintStarted = true;
        await secondMintHold;
        secondMintReturned = true;
      }
    });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const refreshes: unknown[] = [];
  let childAborted = false;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-27T07:00:00.000Z"));
  try {
    const controller = controllerWith(store, {
      vault, now: () => Date.now(), runRenewalIntervalMs: 0,
      assertCredentialRefreshCapability: async () => {},
      refreshCredentials: async (update) => { refreshes.push(update); },
      apply: async (_job, control) => {
        resolveStarted();
        try {
          return await awaitExecutionAbort(control);
        } finally {
          childAborted = true;
        }
      },
    });
    const pending = controller.runQueuedApply(applyRunId);
    await started;
    jest.advanceTimersByTime(31_000);
    await settleAsyncUntil(() => secondMintStarted);
    jest.advanceTimersByTime(90_000);
    await settleAsyncUntil(() => childAborted);
    // The teardown waits at most 100ms for an issuer that ignores cancellation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    jest.advanceTimersByTime(100);
    const response = await pending;
    expect(response.applyRun.status).toBe("failed");
    expect(response.applyRun.diagnostics?.map((item) => item.code)).toContain(
      "credential_service_unavailable",
    );
    releaseSecondMint();
    await settleAsyncUntil(() => secondMintReturned);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(issueCount()).toBe(2);
    expect(refreshes).toEqual([]);
    expect(capsuleRuntimeSafetyFromRun(response.applyRun).phase).toBe("unknown");
  } finally {
    releaseSecondMint();
    jest.useRealTimers();
  }
});

test("one transient run-heartbeat transport failure recovers before apply dispatch", async () => {
  const store = new OneTransientHeartbeatFailureStore();
  await seedApply(store, {
    capsuleId: "cap_hb_retry",
    planRunId: "plan_hb_retry",
    applyRunId: "apply_hb_retry",
  });
  let applyCalls = 0;
  const controller = controllerWith(store, {
    runRenewalIntervalMs: 0,
    apply: () => {
      applyCalls += 1;
      return Promise.resolve(fixtureStateCommit());
    },
  });

  const response = await controller.runQueuedApply("apply_hb_retry");

  expect(response.applyRun.status).toBe("succeeded");
  expect(applyCalls).toBe(1);
  expect(store.heartbeatRenewalAttempts).toBeGreaterThanOrEqual(3);
});

test("run-heartbeat transport failure does not retry after heartbeat headroom is exhausted", async () => {
  const store = new OneTransientHeartbeatFailureStore();
  await seedApply(store, {
    capsuleId: "cap_hb_no_headroom",
    planRunId: "plan_hb_no_headroom",
    applyRunId: "apply_hb_no_headroom",
  });
  let applyCalls = 0;
  const controller = controllerWith(store, {
    now: () =>
      store.heartbeatRenewalAttempts > 0 ? 10 * 60 * 1000 + 100 : 1,
    runRenewalIntervalMs: 0,
    apply: () => {
      applyCalls += 1;
      return Promise.resolve(fixtureStateCommit());
    },
  });

  const response = await controller.runQueuedApply("apply_hb_no_headroom");

  expect(response.applyRun.status).toBe("failed");
  expect(response.applyRun.diagnostics?.map((item) => item.code)).toEqual([
    "run_heartbeat_unavailable",
  ]);
  expect(store.heartbeatRenewalAttempts).toBe(1);
  expect(applyCalls).toBe(0);
});

test("one transient coordination-renew transport failure recovers before apply dispatch", async () => {
  const store = new HeartbeatCountingStore();
  await seedApply(store, {
    capsuleId: "cap_lease_retry",
    planRunId: "plan_lease_retry",
    applyRunId: "apply_lease_retry",
  });
  const inner = new InMemoryCapsuleCoordination({ now: () => 1 });
  let renewAttempts = 0;
  const coordination: CapsuleCoordination = {
    acquireLease: (input) => inner.acquireLease(input),
    releaseLease: (input) => inner.releaseLease(input),
    renewLease: (input) => {
      renewAttempts += 1;
      if (renewAttempts === 1) {
        return Promise.reject(
          Object.assign(new Error("transient coordination transport reset"), {
            retryable: true,
          }),
        );
      }
      return inner.renewLease(input);
    },
  };
  let applyCalls = 0;
  const controller = controllerWith(store, {
    coordination,
    runRenewalIntervalMs: 0,
    apply: () => {
      applyCalls += 1;
      return Promise.resolve(fixtureStateCommit());
    },
  });

  const response = await controller.runQueuedApply("apply_lease_retry");

  expect(response.applyRun.status).toBe("succeeded");
  expect(applyCalls).toBe(1);
  expect(renewAttempts).toBe(store.heartbeatRenewalAttempts + 1);
});

test("coordination retry that proves not-held aborts immediately without another heartbeat", async () => {
  const store = new HeartbeatCountingStore();
  await seedApply(store, {
    capsuleId: "cap_lease_retry_lost",
    planRunId: "plan_lease_retry_lost",
    applyRunId: "apply_lease_retry_lost",
  });
  const inner = new InMemoryCapsuleCoordination({ now: () => 1 });
  let renewAttempts = 0;
  const coordination: CapsuleCoordination = {
    acquireLease: (input) => inner.acquireLease(input),
    releaseLease: (input) => inner.releaseLease(input),
    renewLease: (input) => {
      renewAttempts += 1;
      if (renewAttempts === 1) {
        return Promise.reject(
          Object.assign(new Error("transient coordination transport reset"), {
            retryable: true,
          }),
        );
      }
      return Promise.resolve({
        scope: input.scope,
        holderId: input.holderId,
        token: input.token,
        acquired: false,
        expiresAt: "1970-01-01T00:00:00.000Z",
      });
    },
  };
  let applyCalls = 0;
  const controller = controllerWith(store, {
    coordination,
    runRenewalIntervalMs: 0,
    apply: () => {
      applyCalls += 1;
      return Promise.resolve(fixtureStateCommit());
    },
  });

  const response = await controller.runQueuedApply("apply_lease_retry_lost");

  expect(response.applyRun.status).toBe("failed");
  expect(response.applyRun.diagnostics?.map((item) => item.code)).toEqual([
    "capsule_lease_lost",
  ]);
  expect(renewAttempts).toBe(2);
  expect(store.heartbeatRenewalAttempts).toBe(1);
  expect(applyCalls).toBe(0);
});

test("the run heartbeat is re-stamped AND the lease renewed while a long apply blocks in the runner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_hb000001",
    planRunId: "plan_hb",
    applyRunId: "apply_hb",
  });

  // A monotonically advancing clock so each renewal tick stamps a strictly later
  // heartbeat than the claim's startedAt heartbeat.
  let clock = 1000;
  const now = () => (clock += 1);
  const coordination = new InMemoryCapsuleCoordination({ now });

  // Count renewLease calls (the renewal harness should fire at least once while
  // the apply blocks) without changing the in-memory renew semantics.
  let renewCalls = 0;
  const observingCoordination: CapsuleCoordination = {
    acquireLease: (input: AcquireCapsuleLeaseInput) =>
      coordination.acquireLease(input),
    releaseLease: (input: ReleaseCapsuleLeaseInput) =>
      coordination.releaseLease(input),
    renewLease: (input: RenewCapsuleLeaseInput): Promise<CapsuleLease> => {
      renewCalls += 1;
      return coordination.renewLease(input);
    },
  };

  // The runner blocks (driving a "long apply") long enough for the renewal timer
  // (small injected interval) to fire at least one tick, then returns. We capture
  // the claim heartbeat and the LATER mid-flight heartbeat INSIDE the runner —
  // the terminal write resets heartbeatAt to the final value, so the observation
  // must happen while the run is still `running`.
  let claimHeartbeat = 0;
  let midFlightHeartbeat = 0;
  const controller = controllerWith(store, {
    coordination: observingCoordination,
    now,
    runRenewalIntervalMs: 5,
    apply: async () => {
      claimHeartbeat = (await store.getApplyRun("apply_hb"))?.heartbeatAt ?? 0;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const current = (await store.getApplyRun("apply_hb"))?.heartbeatAt ?? 0;
        if (current > claimHeartbeat && renewCalls > 0) {
          midFlightHeartbeat = current;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return fixtureStateCommit();
    },
  });

  const response = await controller.runQueuedApply("apply_hb");

  expect(response.applyRun.status).toBe("succeeded");
  // A renewal tick re-stamped the heartbeat past the claim value and renewed the
  // capsule lease while the apply was blocked in the runner.
  expect(renewCalls).toBeGreaterThan(0);
  expect(midFlightHeartbeat).toBeGreaterThan(claimHeartbeat);
});

test("restore transport aborts before external mutation after Capsule lease loss and successor takeover", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let coordinationNow = 1_000;
  let leaseSequence = 0;
  const coordination = new InMemoryCapsuleCoordination({
    now: () => coordinationNow,
    newToken: () => `restore_coordination_${++leaseSequence}`,
  });
  let observedSignal: AbortSignal | undefined;
  let externalMutationCompleted = false;
  let successorAcquired = false;
  let target:
    | { readonly capsuleId: string; readonly environment: string }
    | undefined;
  const controller = controllerWith(store, {
    coordination,
    disableEnqueue: true,
    runRenewalIntervalMs: 1,
    now: (() => {
      let now = 10_000;
      return () => ++now;
    })(),
    restore: async (job, control) => {
      observedSignal = control?.signal;
      coordinationNow += DEFAULT_CAPSULE_LEASE_TTL_MS + 1;
      const successor = await coordination.acquireLease({
        scope: capsuleLeaseScope(target!.capsuleId, target!.environment),
        holderId: "restore-successor",
        ttlMs: DEFAULT_CAPSULE_LEASE_TTL_MS,
      });
      successorAcquired = successor.acquired;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (!control?.signal?.aborted) externalMutationCompleted = true;
      return restoreAck(job);
    },
  });
  target = await seedQueuedRestore(store, controller, "state");

  await expect(controller.runQueuedRestore(target.runId)).rejects.toThrow(
    /capsule_lease_lost/u,
  );
  expect(successorAcquired).toBe(true);
  expect(observedSignal).toBeDefined();
  expect(observedSignal?.aborted).toBe(true);
  expect(externalMutationCompleted).toBe(false);
  expect((await store.getBackupRun(target.runId))?.status).toBe("failed");
});

test("service-data restore aborts before external mutation after Capsule lease loss and successor takeover", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let coordinationNow = 2_000;
  let leaseSequence = 0;
  const coordination = new InMemoryCapsuleCoordination({
    now: () => coordinationNow,
    newToken: () => `restore_service_coordination_${++leaseSequence}`,
  });
  let observedSignal: AbortSignal | undefined;
  let externalMutationCompleted = false;
  let successorAcquired = false;
  let target:
    | { readonly capsuleId: string; readonly environment: string }
    | undefined;
  const controller = controllerWith(store, {
    coordination,
    disableEnqueue: true,
    runRenewalIntervalMs: 1,
    now: (() => {
      let now = 20_000;
      return () => ++now;
    })(),
    restore: (job) => Promise.resolve(restoreAck(job)),
    restoreServiceData: async (job, control) => {
      observedSignal = control?.signal;
      coordinationNow += DEFAULT_CAPSULE_LEASE_TTL_MS + 1;
      const successor = await coordination.acquireLease({
        scope: capsuleLeaseScope(target!.capsuleId, target!.environment),
        holderId: "restore-service-successor",
        ttlMs: DEFAULT_CAPSULE_LEASE_TTL_MS,
      });
      successorAcquired = successor.acquired;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (!control?.signal?.aborted) externalMutationCompleted = true;
      return {
        status: "restored",
        ref: job.serviceData.ref,
        digest: job.serviceData.digest,
        sizeBytes: job.serviceData.sizeBytes,
        restoredCount: job.serviceData.exportedCount,
      };
    },
  });
  target = await seedQueuedRestore(store, controller, "service_data", true);

  await expect(controller.runQueuedRestore(target.runId)).rejects.toThrow(
    /capsule_lease_lost/u,
  );
  expect(successorAcquired).toBe(true);
  expect(observedSignal).toBeDefined();
  expect(observedSignal?.aborted).toBe(true);
  expect(externalMutationCompleted).toBe(false);
  expect((await store.getBackupRun(target.runId))?.status).toBe("failed");
});

test("the plan heartbeat is re-stamped while a long plan blocks in the runner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule, source, snapshot } = await seedCapsuleModel(store, {
    workspaceId: "ws_plan_hb",
    capsuleId: "cap_plan_hb",
  });
  await store.putCapsule({
    ...capsule,
    currentStateVersionId: "state_seed_plan_hb",
    currentStateGeneration: 0,
    status: "active",
  });
  const inputs = {
    planRunId: "plan_hb_long",
    variables: {},
    generatedRoot: {
      files: { "main.tf": 'module "child" { source = "./module" }' },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  } as const;
  const planRun: PlanRun = {
    id: "plan_hb_long",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    capsuleCurrentStateVersionId: "state_seed_plan_hb",
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      environment: capsule.environment,
    },
    source: {
      kind: "git",
      url: source.url,
      commit: "abcdef0123456789abcdef0123456789abcdef01",
    },
    sourceSnapshotId: snapshot.id,
    sourceDigest: "sha256:src",
    variablesDigest: await stableJsonDigest(inputs.variables),
    executionInputsDigest: await stableJsonDigest(
      planRunExecutionInputsDigestMaterial(inputs, undefined),
    ),
    operation: "update",
    runnerProfileId: "provider-free",
    requiredProviders: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const workspaceManagement = await store.getWorkspaceManagement(
    capsule.workspaceId,
  );
  if (!workspaceManagement) {
    throw new Error("fixture Workspace management is missing");
  }
  await store.preparePlanRun({
    run: planRun,
    inputs,
    expectedWorkspaceManagementAuthority: {
      workspaceId: capsule.workspaceId,
      managementState: "active",
      managementEpoch: workspaceManagement.managementEpoch,
    },
  });

  let clock = 2000;
  const now = () => (clock += 1);
  let claimHeartbeat = 0;
  let midFlightHeartbeat = 0;
  const controller = controllerWith(store, {
    now,
    runRenewalIntervalMs: 5,
    runnerProfiles: [
      {
        id: "provider-free",
        name: "Provider-free",
        substrate: "test",
        executorId: "opentofu.default",
        lifecycle: { state: "active" },
        availability: { state: "available" },
        stateBackend: { kind: "local", ref: "state://test" } as never,
        allowedProviders: [],
        createdAt: 1,
      },
    ],
    defaultRunnerProfileId: "provider-free",
    plan: async () => {
      claimHeartbeat =
        (await store.getPlanRun("plan_hb_long"))?.heartbeatAt ?? 0;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const current =
          (await store.getPlanRun("plan_hb_long"))?.heartbeatAt ?? 0;
        if (current > claimHeartbeat) {
          midFlightHeartbeat = current;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return {
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
      };
    },
  });

  const response = await controller.runQueuedPlan("plan_hb_long");

  expect(response?.status).toBe("succeeded");
  expect(midFlightHeartbeat).toBeGreaterThan(claimHeartbeat);
});
