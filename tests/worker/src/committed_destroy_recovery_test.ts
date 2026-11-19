import { expect, mock, spyOn, test } from "bun:test";
import type { DispatchStateScope } from "@takosumi/internal/deploy-control-api";
import { stableJsonDigest } from "../../../core/adapters/source/digest.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import {
  InMemoryCapsuleCoordination,
  type CapsuleCoordination,
} from "../../../core/domains/deploy-control/capsule_lease.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuController,
  RUN_HEARTBEAT_STALE_MS,
  type OpenTofuDestroyJob,
} from "../../../core/domains/deploy-control/mod.ts";
import { RunCredentialBroker } from "../../../core/domains/deploy-control/run_credential_broker.ts";
import { RunEnvResolver } from "../../../core/domains/deploy-control/run_env_resolver.ts";
import { createDefaultRunnerProfiles } from "../../../core/domains/deploy-control/runner_profiles.ts";
import {
  InMemoryOpenTofuControlStore,
  planRunExecutionInputsDigestMaterial,
  type PlanRunInputs,
} from "../../../core/domains/deploy-control/store.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import {
  dispatchRunOwnerWithApplyReceipts,
  registerRunOwnerApplyReceiptReader,
} from "../../../worker/src/committed_apply_recovery.ts";
import { CloudflareContainerOpenTofuRunner } from "../../../worker/src/container_runner.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  FIXTURE_STATE_DIGEST,
  fixtureExecutionEvidence,
  seedCapsuleModel,
} from "../../helpers/deploy-control/model_fixture.ts";

const PLAN_DIGEST = `sha256:${"a".repeat(64)}` as const;
const DESTROY_STATE_DIGEST = `sha256:${"d".repeat(64)}` as const;
const LEGACY_PROVIDER = "registry.opentofu.org/hashicorp/random";
const LOCK_DIGEST = `sha256:${"e".repeat(64)}` as const;
const UPDATED_WORKER_AUTHORITY = {
  ...FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  controllerArtifact: { digest: `sha256:${"1".repeat(64)}`, immutable: true },
  runnerArtifact: { digest: `sha256:${"1".repeat(64)}`, immutable: true },
} as const;

async function fixture(options: {
  readonly phase?: "queued" | "fresh" | "preparing";
  readonly persistedFailure?: boolean;
  readonly responseStatus?: number;
  readonly legacy?: boolean;
  readonly afterWorkerUpdate?: boolean;
  readonly admittedExecutionAuthority?: typeof FIXTURE_EXECUTION_EVIDENCE_AUTHORITY;
  readonly capsuleCoordination?: CapsuleCoordination;
  readonly changeReceipt?: (receipt: Record<string, unknown>) => void;
} = {}) {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, { requiredProviders: [] });
  const profile = createDefaultRunnerProfiles(1)[0]!;
  const artifactReferenceAllocator = new ObjectKeyArtifactReferenceAllocator();
  const currentTime = Date.now();
  let now = currentTime - RUN_HEARTBEAT_STALE_MS - 3_000;
  const composition = {
    store,
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    now: () => now,
  };
  const planning = new OpenTofuController({
    ...composition,
    runner: {
      plan: async ({ planRun }) => ({
        planDigest: PLAN_DIGEST,
        planArtifact: { kind: "runner-local", ref: "opaque-plan", digest: PLAN_DIGEST },
        requiredProviders: planRun.requiredProviders,
        ...(planRun.requiredProviders.length === 0 ? { providerLockArtifact: null } : {
          providerLockDigest: LOCK_DIGEST,
          providerLockArtifact: {
            kind: "object-storage",
            ref: `r2://fixture/runs/${planRun.id}/provider-lockfile.hcl`,
            digest: LOCK_DIGEST,
            sizeBytes: 24,
            contentType: "application/vnd.opentofu.lock.hcl",
          },
        }),
      }),
      apply: async (job) => ({
        stateDigest: FIXTURE_STATE_DIGEST,
        rawOutputRef: job.rawOutputRef,
        outputs: { launch_url: { sensitive: false, value: "https://fixture.example" } },
        executionEvidence: fixtureExecutionEvidence(job, "apply"),
      }),
    },
  });
  const create = await planning.createCapsulePlan(capsule.id);
  const applied = await planning.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  expect(applied.applyRun.status).toBe("succeeded");
  const active = (await store.getCapsule(capsule.id))!;
  expect(active).toMatchObject({ status: "active", currentStateGeneration: 1 });
  const priorState = (await store.getStateVersion(active.currentStateVersionId!))!;
  const priorOutputs = await store.listOutputs(capsule.id);
  expect(priorOutputs).toHaveLength(1);

  if (options.legacy) {
    // Model the recorded provider inventory of a pre-v1 sourceless Capsule.
    const appliedPlan = (await store.getPlanRun(create.planRun.id))!;
    await store.putPlanRun({
      ...appliedPlan,
      source: { kind: "local", path: "/resource-shape/legacy-generated-root" } as never,
      sourceSnapshotId: "snap_legacy_generated_root",
      requiredProviders: [LEGACY_PROVIDER],
      requiredProviderRequirements: [{
        source: LEGACY_PROVIDER, moduleLocalName: "random", allowed: true, credentialRequired: false,
      }],
    });
    await store.putCapsule({ ...active, sourceId: undefined as never });
  }

  const { planRun: waiting } = await planning.createCapsuleDestroyPlan(capsule.id);
  expect(waiting).toMatchObject({ status: "waiting_approval" });
  expect(waiting.source.kind).toBe(options.legacy ? "operator_module" : "git");
  await planning.approveRun(waiting.id);
  const planRun = (await store.getPlanRun(waiting.id))!;
  expect(planRun.baseStateGeneration).toBe(priorState.generation);
  if (!options.legacy) expect(planRun.sourceSnapshotId).toBeDefined();
  expect(await store.getPlanRunInputs(planRun.id)).toBeDefined();

  let job!: OpenTofuDestroyJob;
  const receiptCommittedAt = new Date(now + 1_500).toISOString();
  const inspect = mock(async (id: string, action: string) => ({
    kind: "takosumi.runner-mutation-inspection@v1",
    runId: id,
    authority: {
      status: "valid", action, version: 1, fence: 1, redispatchBlocked: true,
      ...(options.phase === "preparing" ? { phase: "preparing" } : { phase: "completed", completion: {} }),
      ...(options.admittedExecutionAuthority ? { admittedExecutionAuthority: options.admittedExecutionAuthority } : {}),
    },
  }));
  const adopt = mock(async (_id: string, _action: string, allocation: { stateScope: DispatchStateScope }) => {
    const { generation, stateRef } = allocation.stateScope;
    const receipt = {
      status: options.persistedFailure ? "failed" : "succeeded",
      exitCode: options.persistedFailure ? 1 : 0,
      state: { generation, stateRef, digest: DESTROY_STATE_DIGEST },
      executionEvidence: {
        ...fixtureExecutionEvidence(job, "destroy", options.persistedFailure ? { outcome: "provider_failed_state_persisted" } : {}),
        committedAt: receiptCommittedAt,
      },
      ...(options.persistedFailure ? {
        errorCode: "provider_execution_failed",
        providerExecutionFailure: { kind: "provider_execution_failed", statePersistence: "persisted" },
      } : {}),
    };
    options.changeReceipt?.(receipt);
    return Response.json(receipt, { status: options.responseStatus ?? (options.persistedFailure ? 500 : 200) });
  });
  const fetch = mock(async (_request: Request) => { throw new Error("runner transport is unavailable in the fixture"); });
  const runner = new CloudflareContainerOpenTofuRunner({ RUNNER: {
    idFromName: (id: string) => id,
    get: () => ({ inspectMutationAuthority: inspect, adoptDeterminedMutation: adopt, fetch }),
  } } as unknown as CloudflareWorkerEnv);
  const controller = new OpenTofuController({
    ...composition,
    executionEvidenceAuthority: options.afterWorkerUpdate ? UPDATED_WORKER_AUTHORITY : composition.executionEvidenceAuthority,
    runner,
    capsuleCoordination: options.capsuleCoordination,
    enqueueRun: async () => {},
  });
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun).toMatchObject({ operation: "destroy", status: "queued" });
  let run = applyRun;
  if (options.phase !== "queued") {
    const startedAt = now + 100;
    const heartbeatAt = options.phase === "fresh" ? currentTime : now + 1_000;
    run = { ...run, status: "running", startedAt, heartbeatAt, updatedAt: heartbeatAt };
    const claim = await store.transitionRun({
      id: run.id, kind: "apply", expectFrom: ["queued"],
      run, setLeaseToken: "previous-run-owner", heartbeatAt,
    });
    expect(claim.won).toBe(true);
  }
  now = currentTime;

  const digest = await stableJsonDigest({ kind: "takosumi.state-version-id@v1", applyRunId: run.id });
  const stateVersionId = `state_${digest.slice(7)}`;
  job = {
    applyRun: run, planRun, planArtifact: planRun.planArtifact!, runnerProfile: profile,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    executionEvidenceCommit: { destroyed: true, stateVersionId },
  };
  const operations = { dispatchQueuedRun: controller.dispatchQueuedRun.bind(controller) };
  registerRunOwnerApplyReceiptReader(operations, runner);
  const dispatch = () => dispatchRunOwnerWithApplyReceipts(
    operations, { action: "apply", runId: run.id, workspaceId: run.workspaceId }, { deadlineAt: Date.now() + 5_000 },
  );
  return { store, run, planRun, capsule, priorState, priorOutputs, inspect, adopt, fetch, runner, dispatch, stateVersionId };
}

for (const persistedFailure of [false, true]) {
  const outcome = persistedFailure ? "persisted provider failure" : "successful teardown";
  test(`stale Destroy adopts a completed receipt for ${outcome}`, async () => {
    const f = await fixture({ persistedFailure });
    const environment = spyOn(RunEnvResolver.prototype, "resolveRunEnvironment");
    const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
    const renew = spyOn(RunCredentialBroker.prototype, "renewRunCredential");
    const destroy = spyOn(f.runner, "destroy");
    try {
      await f.dispatch();
      const run = await f.store.getApplyRun(f.run.id);
      expect(run).toMatchObject({
        id: f.run.id,
        planRunId: f.planRun.id,
        startedAt: f.run.startedAt,
        operation: "destroy",
        status: persistedFailure ? "failed" : "succeeded",
        stateVersionId: f.stateVersionId,
      });
      expect(run?.executionEvidence?.commit).toEqual({
        stateVersionId: f.stateVersionId,
        ...(persistedFailure ? {} : { destroyed: true }),
      });
      expect(run?.outputId).toBeUndefined();
      const capsule = await f.store.getCapsule(f.capsule.id);
      expect(capsule).toMatchObject({
        status: persistedFailure ? "error" : "destroyed",
        currentStateVersionId: f.stateVersionId,
        currentStateGeneration: 2,
      });
      expect(capsule?.currentOutputId).toBeUndefined();
      expect(await f.store.getPlanRun(f.planRun.id)).toMatchObject({ appliedApplyRunId: f.run.id });
      expect(await f.store.listOutputs(f.capsule.id)).toEqual(f.priorOutputs);
      expect(await f.store.listStateVersions(f.capsule.id, f.capsule.environment)).toEqual([
        f.priorState,
        expect.objectContaining({
          id: f.stateVersionId, generation: 2, digest: DESTROY_STATE_DIGEST, createdByRunId: f.run.id,
        }),
      ]);

      await f.dispatch();
      expect(await f.store.getApplyRun(f.run.id)).toEqual(run!);
      expect(f.inspect.mock.calls).toEqual([[f.run.id, "destroy"]]);
      expect(f.adopt.mock.calls).toEqual([[f.run.id, "destroy", { stateScope: {
        workspaceId: f.run.workspaceId,
        subject: { kind: "capsule", id: f.capsule.id },
        environment: f.capsule.environment,
        generation: 2,
        stateRef: (await f.store.getStateVersion(f.stateVersionId))!.stateRef,
        priorState: {
          generation: 1, stateRef: f.priorState.stateRef,
          digest: f.priorState.digest, createdByRunId: f.priorState.createdByRunId,
        },
      } }]]);
      expect(environment.mock.calls.every(([input]) => input.mintCredentials === false)).toBe(true);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(mint).not.toHaveBeenCalled();
      expect(renew).not.toHaveBeenCalled();
    } finally {
      environment.mockRestore();
      mint.mockRestore();
      renew.mockRestore();
      destroy.mockRestore();
    }
  });
}

async function expectHeld(f: Awaited<ReturnType<typeof fixture>>, adoptionReads: number) {
  const before = await f.store.getApplyRun(f.run.id);
  const capsuleBefore = await f.store.getCapsule(f.capsule.id);
  const claim = spyOn(f.store, "transitionRun");
  const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
  const destroy = spyOn(f.runner, "destroy");
  try {
    await f.dispatch();
    expect(await f.store.getApplyRun(f.run.id)).toEqual(before!);
    expect(await f.store.getCapsule(f.capsule.id)).toEqual(capsuleBefore!);
    expect(await f.store.getStateVersion(f.stateVersionId)).toBeUndefined();
    expect((await f.store.getPlanRun(f.planRun.id))?.appliedApplyRunId).toBeUndefined();
    expect(f.inspect.mock.calls).toEqual([[f.run.id, "destroy"]]);
    expect(f.adopt).toHaveBeenCalledTimes(adoptionReads);
    expect(claim).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  } finally {
    claim.mockRestore();
    mint.mockRestore();
    destroy.mockRestore();
  }
}

test("invalid completed Destroy receipts hold without claiming the Run", async () => {
  const changes: ReadonlyArray<(receipt: Record<string, unknown>) => void> = [
    receipt => { delete receipt.executionEvidence; },
    receipt => { receipt.executionEvidence = { ...receipt.executionEvidence as object, planRunId: "different-plan" }; },
    receipt => { receipt.executionEvidence = { ...receipt.executionEvidence as object, action: "apply" }; },
    receipt => { receipt.executionEvidence = { ...receipt.executionEvidence as object, committedAt: "2026-06-06T00:00:00.000Z" }; },
    receipt => { receipt.state = { ...receipt.state as object, generation: 3 }; },
    receipt => { receipt.rawOutputRef = "unexpected-output"; },
    receipt => { receipt.outputs = {}; },
  ];
  for (const changeReceipt of changes) await expectHeld(await fixture({ changeReceipt }), 1);
  await expectHeld(await fixture({ persistedFailure: true, responseStatus: 503 }), 1);
  await expectHeld(await fixture({ persistedFailure: true, changeReceipt: receipt => {
    receipt.providerExecutionFailure = { kind: "provider_execution_failed", statePersistence: "unavailable" };
    delete receipt.state;
  } }), 1);
});

test("completed Destroy settles against its admitted artifacts across a Worker update", async () => {
  for (const persistedFailure of [false, true]) {
    const f = await fixture({
      afterWorkerUpdate: true, persistedFailure,
      admittedExecutionAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    });
    const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
    const destroy = spyOn(f.runner, "destroy");
    try {
      await f.dispatch();
      expect(await f.store.getApplyRun(f.run.id)).toMatchObject({
        id: f.run.id, status: persistedFailure ? "failed" : "succeeded",
        stateVersionId: f.stateVersionId,
        executionEvidence: { authority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY },
      });
      expect(f.adopt).toHaveBeenCalledTimes(1);
      expect(mint).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
      destroy.mockRestore();
    }
  }
});

test("an older Destroy receipt stays fenced if the original authority or matching completion is missing", async () => {
  await expectHeld(await fixture({ afterWorkerUpdate: true }), 1);
  await expectHeld(await fixture({
    afterWorkerUpdate: true,
    admittedExecutionAuthority: UPDATED_WORKER_AUTHORITY,
  }), 1);
  await expectHeld(await fixture({
    afterWorkerUpdate: true,
    admittedExecutionAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    changeReceipt: (receipt) => {
      const evidence = receipt.executionEvidence as ReturnType<typeof fixtureExecutionEvidence>;
      receipt.executionEvidence = { ...evidence, receipt: { ...evidence.receipt, fence: 2 } };
    },
  }), 1);
});

test("completed ordinary Destroy holds when prepared inputs cannot be read", async () => {
  const f = await fixture();
  await f.store.deletePlanRunInputs(f.planRun.id);
  await expectHeld(f, 0);
});

test("fresh and queued Destroy skip observation, and preparing takes ordinary dispatch", async () => {
  for (const phase of ["fresh", "queued", "preparing"] as const) {
    const f = await fixture({ phase });
    const destroy = spyOn(f.runner, "destroy").mockImplementation(async job => ({
      stateDigest: DESTROY_STATE_DIGEST,
      executionEvidence: fixtureExecutionEvidence(job, "destroy"),
    }));
    try {
      await f.dispatch();
      expect(f.inspect.mock.calls).toEqual(phase === "preparing" ? [[f.run.id, "destroy"]] : []);
      expect(f.adopt).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(phase === "fresh" ? 0 : 1);
      expect((await f.store.getApplyRun(f.run.id))?.status).toBe(phase === "fresh" ? "running" : "succeeded");
    } finally {
      destroy.mockRestore();
    }
  }
});

async function expectOrdinaryDestroy(
  f: Awaited<ReturnType<typeof fixture>>,
  status: "failed" | "succeeded",
  probesPrivateFiles = false,
) {
  const destroy = spyOn(f.runner, "destroy").mockImplementation(async job => {
    const executionEvidence = fixtureExecutionEvidence(job, "destroy");
    return {
      stateDigest: DESTROY_STATE_DIGEST,
      executionEvidence,
      providerInstallation: executionEvidence.authority.providerArtifacts.map(item => ({
        provider: item.source, installedDigest: item.digest, attested: true,
        mirrored: false, installationMethod: "unknown",
      })),
    };
  });
  try {
    await f.dispatch();
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.adopt).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(status === "succeeded" ? 1 : 0);
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe(status);
    expect(f.fetch.mock.calls.map(([request]) => [request.method, new URL(request.url).pathname])).toEqual(
      probesPrivateFiles ? [["GET", "/capabilities"]] : [],
    );
  } finally {
    destroy.mockRestore();
  }
}

test("known scheduled, legacy, connection-recovery, lifecycle and private-file paths retain ordinary Destroy handling", async () => {
  const scheduled = await fixture();
  await scheduled.store.putPlanRun({
    ...scheduled.planRun, origin: { kind: "scheduled_uninstall", uninstallId: "uninstall_fixture" },
  });
  await expectOrdinaryDestroy(scheduled, "failed");
  await expectOrdinaryDestroy(await fixture({ legacy: true }), "succeeded");

  const reconnect = await fixture();
  await reconnect.store.putPlanRun({
    ...reconnect.planRun,
    destroyConnectionRecovery: {
      appliedPlanRunId: "fixture-applied-plan",
      appliedProviderBindingsDigest: reconnect.planRun.resolvedProviderBindingsDigest!,
      replacements: [{ connectionId: "fixture-revoked", replacementConnectionId: "fixture-replacement" }],
    },
  });
  await expectOrdinaryDestroy(reconnect, "failed");

  const ineligibleInputs: ReadonlyArray<Partial<PlanRunInputs>> = [
    { lifecycleActions: [{
      apiVersion: "takosumi.dev/v1alpha1", kind: "command", id: "cleanup",
      phase: "pre_destroy", executor: "runner", command: ["bun", "run", "cleanup"],
      runnerCapability: "capsule.lifecycle.command.v1",
    }] },
    { privateRunFileSlots: [{ slot: "fixture-file" }] },
  ];
  for (const fields of ineligibleInputs) {
    const f = await fixture();
    const inputs = { ...(await f.store.getPlanRunInputs(f.planRun.id))!, ...fields };
    await f.store.putPlanRunInputs(inputs);
    await f.store.putPlanRun({
      ...f.planRun, executionInputsDigest: await stableJsonDigest(planRunExecutionInputsDigestMaterial(inputs)),
    });
    await expectOrdinaryDestroy(f, "failed", Boolean(fields.privateRunFileSlots));
  }
});

test("completed Destroy cannot settle after losing the Capsule lease before commit", async () => {
  const capsuleCoordination = new InMemoryCapsuleCoordination();
  const f = await fixture({ capsuleCoordination });
  const renew = capsuleCoordination.renewLease.bind(capsuleCoordination);
  let attempts = 0;
  const renewal = spyOn(capsuleCoordination, "renewLease").mockImplementation(async input => {
    const lease = await renew(input);
    return ++attempts === 2 ? { ...lease, acquired: false } : lease;
  });
  const commit = spyOn(f.store, "commitRunState");
  const destroy = spyOn(f.runner, "destroy");
  try {
    await f.dispatch();
    expect(renewal).toHaveBeenCalledTimes(2);
    expect(f.adopt).toHaveBeenCalledTimes(1);
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("running");
    expect((await f.store.getCapsule(f.capsule.id))?.currentStateVersionId).toBe(f.priorState.id);
    expect((await f.store.getPlanRun(f.planRun.id))?.appliedApplyRunId).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  } finally {
    renewal.mockRestore();
    commit.mockRestore();
    destroy.mockRestore();
  }
});
