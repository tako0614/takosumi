import { expect, test } from "bun:test";
import {
  applyExpectedGuardFromPlanRun,
  type EnqueueRun,
  type OpenTofuApplyJob,
  type OpenTofuDestroyJob,
  type OpenTofuPlanJob,
  OpenTofuController,
  type OpenTofuRunner,
  OpenTofuRunnerExecutionError,
  OpenTofuRunnerInfrastructureError,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  type BeginApplyRunResult,
  InMemoryOpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  fixtureStateCommit,
  providerRequirementsForFixture,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";
import {
  type ConnectionVault,
  CredentialBundle,
  PhaseMintBundle,
  type CapsuleProviderBindingMintEntry,
  type RegisterConnectionInput,
  type TestConnectionResult,
} from "../../../../core/adapters/vault/mod.ts";
import type {
  ApplyRun,
  ProviderConnection,
  CreatePlanRunRequest,
} from "@takosumi/internal/deploy-control-api";

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
const SECRET_TOKEN = "cf-token-super-secret-value";
const CLOUDFLARE_MIRROR_EVIDENCE = {
  provider: CLOUDFLARE,
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
} as const;
const RUNNER_CONTAINER_CAPACITY_EXCEEDED =
  "OpenTofu runner rejected destroy-plan run plan_live: 500 (Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances)";

/**
 * Seeds the Workspace-direct Capsule model (spec §5) and returns an UPDATE
 * plan-run request bound to the seeded Capsule (raw `createPlanRun` now
 * requires an existing capsuleId). The Capsule is seeded WITH a
 * current StateVersion + state generation `gen` so the apply-expected guard is
 * well-formed and the plan's base generation matches.
 */
async function seedUpdatable(
  store: InMemoryOpenTofuControlStore,
  options: { capsuleId: string; generation?: number },
): Promise<CreatePlanRunRequest> {
  const generation = options.generation ?? 0;
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "ws_lifecycle",
    capsuleId: options.capsuleId,
  });
  await store.putConnection({
    id: `conn_${options.capsuleId}`,
    scope: "workspace",
    workspaceId: capsule.workspaceId,
    provider: CLOUDFLARE,
    providerSource: CLOUDFLARE,
    kind: "cloudflare_api_token",
    displayName: "Lifecycle Cloudflare",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    verifiedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putProviderBindingSet({
    id: `profile_${options.capsuleId}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "cloudflare",
        rootAlias: "main",
        connectionId: `conn_${options.capsuleId}`,
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    ...capsule,
    currentStateVersionId: `state_seed_${options.capsuleId}`,
    currentStateGeneration: generation,
    status: "active",
  });
  return {
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "update",
    source: SOURCE,
    requiredProviderRequirements:
      providerRequirementsForFixture([CLOUDFLARE]),
    requiredProviders: [CLOUDFLARE],
  };
}

class LostFirstBeginApplyRunAcknowledgementStore extends InMemoryOpenTofuControlStore {
  #loseAcknowledgement = true;

  override async beginApplyRun(run: ApplyRun): Promise<BeginApplyRunResult> {
    const result = await super.beginApplyRun(run);
    if (this.#loseAcknowledgement && result.status === "created") {
      this.#loseAcknowledgement = false;
      throw new Error("simulated lost beginApplyRun acknowledgement");
    }
    return result;
  }
}

class HiddenExactApplyRunReadStore extends InMemoryOpenTofuControlStore {
  #hiddenApplyRunId: string | undefined;

  hideNextApplyRunRead(id: string): void {
    this.#hiddenApplyRunId = id;
  }

  override getApplyRun(id: string): Promise<ApplyRun | undefined> {
    if (this.#hiddenApplyRunId === id) {
      this.#hiddenApplyRunId = undefined;
      return Promise.resolve(undefined);
    }
    return super.getApplyRun(id);
  }
}

// --- happy-path plan + apply: credentials reach the dispatch, never the store ---

test("consumer plan + apply: credentials reach the dispatch payload but never the store or logs", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const captured: { plan?: OpenTofuPlanJob; apply?: OpenTofuApplyJob } = {};
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1000),
    newId: deterministicIds(),
    runner: capturingRunner(captured),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, { capsuleId: "cap_happy" });

  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("succeeded");

  // The plan job saw the minted credential...
  expect(captured.plan?.credentials?.env).toEqual({
    CLOUDFLARE_API_TOKEN: SECRET_TOKEN,
  });
  // ...but the persisted PlanRun never carries it.
  const persistedPlan = await store.getPlanRun(planRun.id);
  expect(JSON.stringify(persistedPlan)).not.toContain(SECRET_TOKEN);

  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applied.applyRun.status).toEqual("succeeded");
  expect(captured.apply?.credentials?.env).toEqual({
    CLOUDFLARE_API_TOKEN: SECRET_TOKEN,
  });

  // Neither the apply run, StateVersion, nor the Capsule leaks the secret.
  const dump = JSON.stringify({
    applyRun: await store.getApplyRun(applied.applyRun.id),
    stateVersion: applied.applyRun.stateVersionId
      ? await store.getStateVersion(applied.applyRun.stateVersionId)
      : undefined,
    capsule: applied.capsule,
  });
  expect(dump).not.toContain(SECRET_TOKEN);

  // The plan inputs sidecar is cleared after the run completes.
  expect(await store.getPlanRunInputs(planRun.id)).toBeUndefined();
});

test("secret-bearing mint evidence fails without leaking into the Run or audit error surface", async () => {
  const rawToken = "raw-driver-token-that-must-never-reach-run-logs";
  const store = new InMemoryOpenTofuControlStore();
  const vault = {
    ...fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: rawToken } }),
    mintForCapsuleProviderBindings: (
      _workspaceId: string,
      entries: readonly CapsuleProviderBindingMintEntry[],
    ) =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: rawToken } },
          [],
          entries.map((entry) => ({
            provider: CLOUDFLARE,
            connectionId: entry.connectionId,
            temporary: true,
            ttlEnforced: true,
            issuer: `driver:${rawToken}`,
            secretValueStored: false as const,
          })),
        ),
      ),
  } satisfies ConnectionVault;
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1100),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_secret_evidence",
  });

  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toBe("failed");
  const persisted = await store.getPlanRun(planRun.id);
  const mintEvents = await store.listCredentialMintEventsForRun(planRun.id);
  expect(JSON.stringify({ planRun, persisted, mintEvents })).not.toContain(
    rawToken,
  );
  expect(mintEvents).toEqual([]);
  expect(
    planRun.auditEvents.find((event) => event.type === "plan.failed")?.data
      ?.message,
  ).toMatch(/credential/);
});

test("ApplyRun preparation checkpoint runs before durable put and provider dispatch", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let providerApplyCalls = 0;
  let checkpointedApplyRunId: string | undefined;
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1400),
    newId: deterministicIds(),
    runner: {
      ...stubRunner(),
      apply: () => {
        providerApplyCalls += 1;
        return Promise.resolve(fixtureStateCommit());
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_apply_checkpoint",
  });
  const { planRun } = await controller.createPlanRun(request);

  await expect(
    controller.createApplyRun(
      {
        planRunId: planRun.id,
        expected: applyExpectedGuardFromPlanRun(planRun),
      },
      {},
      {
        onPrepared: async (applyRun) => {
          checkpointedApplyRunId = applyRun.id;
          expect(await store.getApplyRun(applyRun.id)).toBeUndefined();
          throw new Error("checkpoint unavailable");
        },
      },
    ),
  ).rejects.toThrow("checkpoint unavailable");

  expect(checkpointedApplyRunId).toBeDefined();
  expect(providerApplyCalls).toBe(0);
  expect(await store.getApplyRun(checkpointedApplyRunId!)).toBeUndefined();
});

test("exact queued ApplyRun recovery repairs a lost insert acknowledgement without duplicate provider execution", async () => {
  const store = new LostFirstBeginApplyRunAcknowledgementStore();
  const dispatches: Parameters<EnqueueRun>[0][] = [];
  let providerApplyCalls = 0;
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1425),
    newId: deterministicIds(),
    runner: {
      ...stubRunner(),
      apply: (job) => {
        providerApplyCalls += 1;
        return Promise.resolve(
          fixtureStateCommit({ rawOutputRef: job.rawOutputRef }),
        );
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: (dispatch) => {
      dispatches.push(dispatch);
      return Promise.resolve();
    },
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_exact_lost_begin_ack",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;
  dispatches.length = 0;
  const exactId = "apply_exact_lost_begin_ack";
  const create = () =>
    controller.createApplyRun(
      {
        planRunId: planRun.id,
        expected: applyExpectedGuardFromPlanRun(planRun),
      },
      {},
      { applyRunId: exactId },
    );

  await expect(create()).rejects.toThrow(
    "simulated lost beginApplyRun acknowledgement",
  );
  expect((await store.getApplyRun(exactId))?.status).toBe("queued");
  expect(dispatches.filter((dispatch) => dispatch.action === "apply")).toEqual(
    [],
  );

  expect((await create()).applyRun.id).toBe(exactId);
  expect((await create()).applyRun.id).toBe(exactId);
  const repairedDispatches = dispatches.filter(
    (dispatch) => dispatch.action === "apply",
  );
  expect(repairedDispatches).toHaveLength(2);

  for (const dispatch of repairedDispatches) {
    await controller.dispatchQueuedRun(dispatch);
  }
  expect(providerApplyCalls).toBe(1);
  expect((await store.getApplyRun(exactId))?.status).toBe("succeeded");
});

test("beginApplyRun adoption repairs the exact queued row when the optimistic read loses an insert race", async () => {
  const store = new HiddenExactApplyRunReadStore();
  const dispatches: Parameters<EnqueueRun>[0][] = [];
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1440),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: (dispatch) => {
      dispatches.push(dispatch);
      return Promise.resolve();
    },
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_exact_begin_race",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;
  const exactId = "apply_exact_begin_race";
  await controller.createApplyRun(
    {
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    },
    {},
    { applyRunId: exactId },
  );
  dispatches.length = 0;
  store.hideNextApplyRunRead(exactId);

  const recovered = await controller.createApplyRun(
    {
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    },
    {},
    { applyRunId: exactId },
  );

  expect(recovered.applyRun.id).toBe(exactId);
  expect(recovered.applyRun.status).toBe("queued");
  expect(dispatches).toEqual([
    {
      action: "apply",
      runId: exactId,
      workspaceId: planRun.workspaceId,
    },
  ]);
});

test("exact ApplyRun recovery adopts running and succeeded rows without queued reset or redispatch", async () => {
  for (const status of ["running", "succeeded"] as const) {
    const store = new InMemoryOpenTofuControlStore();
    const dispatches: Parameters<EnqueueRun>[0][] = [];
    const controller = new OpenTofuController({
      store,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      now: monotonicNow(status === "running" ? 1450 : 1475),
      newId: deterministicIds(),
      runner: stubRunner(),
      vault: fakeVault({
        [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN },
      }),
      enqueueRun: (dispatch) => {
        dispatches.push(dispatch);
        return Promise.resolve();
      },
    });
    const request = await seedUpdatable(store, {
      capsuleId: `cap_exact_${status}`,
    });
    const { planRun: queuedPlan } = await controller.createPlanRun(request);
    await controller.dispatchQueuedRun({
      action: "plan",
      runId: queuedPlan.id,
      workspaceId: queuedPlan.workspaceId,
    });
    const planRun = (await store.getPlanRun(queuedPlan.id))!;
    const exactId = `apply_exact_${status}`;
    const created = await controller.createApplyRun(
      {
        planRunId: planRun.id,
        expected: applyExpectedGuardFromPlanRun(planRun),
      },
      {},
      { applyRunId: exactId },
    );
    const advanced = {
      ...created.applyRun,
      status,
      startedAt: 1500,
      updatedAt: 1501,
      ...(status === "succeeded" ? { finishedAt: 1502 } : {}),
    } as typeof created.applyRun;
    await store.putApplyRun(advanced);
    const dispatchCount = dispatches.length;

    const recovered = await controller.createApplyRun(
      {
        planRunId: planRun.id,
        expected: applyExpectedGuardFromPlanRun(planRun),
      },
      {},
      { applyRunId: exactId },
    );

    expect(recovered.applyRun).toEqual(advanced);
    expect(dispatches).toHaveLength(dispatchCount);
    expect(await store.getApplyRun(exactId)).toEqual(advanced);
  }
});

test("exact ApplyRun recovery rejects an immutable authority mismatch", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1490),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: () => Promise.resolve(),
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_exact_mismatch",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;
  const exactId = "apply_exact_mismatch";
  const created = await controller.createApplyRun(
    {
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    },
    {},
    { applyRunId: exactId },
  );
  await store.putApplyRun({
    ...created.applyRun,
    runnerProfileId: "different-profile",
  });

  await expect(
    controller.createApplyRun(
      {
        planRunId: planRun.id,
        expected: applyExpectedGuardFromPlanRun(planRun),
      },
      {},
      { applyRunId: exactId },
    ),
  ).rejects.toThrow("different run authority");
});

test("successful apply observer sees the atomically committed terminal run and Capsule pointers", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1500),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_terminal_commit",
  });
  const { planRun } = await controller.createPlanRun(request);
  const observed: Array<{
    status: string;
    persistedStatus?: string;
    currentStateVersionId?: string;
  }> = [];
  controller.setTerminalRunObserver(async (run) => {
    if (!("planRunId" in run)) return;
    const persisted = await store.getApplyRun(run.id);
    const capsule = run.capsuleId
      ? await store.getCapsule(run.capsuleId)
      : undefined;
    observed.push({
      status: run.status,
      ...(persisted ? { persistedStatus: persisted.status } : {}),
      ...(capsule?.currentStateVersionId
        ? { currentStateVersionId: capsule.currentStateVersionId }
        : {}),
    });
  });

  await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const committedCapsule = await store.getCapsule(request.capsuleId!);

  expect(observed).toEqual([
    {
      status: "succeeded",
      persistedStatus: "succeeded",
      currentStateVersionId: committedCapsule?.currentStateVersionId,
    },
  ]);
});

test("failed apply observer fires once after provider dispatch and terminal persistence", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1750),
    newId: deterministicIds(),
    runner: {
      ...stubRunner(),
      apply: () => Promise.reject(new Error("provider apply failed")),
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_terminal_failure",
  });
  const { planRun } = await controller.createPlanRun(request);
  const observed: string[] = [];
  controller.setTerminalRunObserver(async (run) => {
    if (!("planRunId" in run)) return;
    observed.push(`${run.status}:${(await store.getApplyRun(run.id))?.status}`);
  });

  const failed = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(failed.applyRun.status).toBe("failed");
  expect(
    failed.applyRun.auditEvents.some(
      (event) => event.data?.providerDispatched === true,
    ),
  ).toBe(true);
  expect(observed).toEqual(["failed:failed"]);
});

test("raw-output durability ambiguity replays the same ApplyRun before publishing StateVersion or Output", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const retryDispatches: Parameters<EnqueueRun>[0][] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  const enqueueRun: EnqueueRun = (dispatch) => {
    retryDispatches.push(dispatch);
    return Promise.resolve();
  };
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1800),
    newId: deterministicIds(),
    runner: {
      ...stubRunner(),
      apply: (job) => {
        applyJobs.push(job);
        if (applyJobs.length === 1) {
          return Promise.reject(
            new OpenTofuRunnerInfrastructureError(
              "raw output durability acknowledgement is ambiguous",
              { reason: "runner_artifact_relay_ambiguous" },
            ),
          );
        }
        if (!job.rawOutputRef) {
          throw new Error("consumer omitted the allocated rawOutputRef");
        }
        return Promise.resolve(
          fixtureStateCommit({
            rawOutputRef: job.rawOutputRef,
            outputs: {
              launch_url: {
                sensitive: false,
                value: "https://app.example.test",
              },
            },
          }),
        );
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_raw_output_durability_failure",
  });
  const before = await store.getCapsule(request.capsuleId!);
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  retryDispatches.length = 0;

  await expect(
    controller.dispatchQueuedRun({
      action: "apply",
      runId: applyRun.id,
      workspaceId: applyRun.workspaceId,
    }),
  ).rejects.toThrow(/retryable_runner_infrastructure_error/);

  const requeued = (await store.getApplyRun(applyRun.id))!;
  expect(requeued.status).toBe("queued");
  expect(requeued.stateVersionId).toBeUndefined();
  expect(requeued.outputId).toBeUndefined();
  expect(
    await store.listStateVersions(request.capsuleId!, "production"),
  ).toEqual([]);
  expect(await store.getLatestOutput(request.capsuleId!)).toBeUndefined();
  const afterFailure = await store.getCapsule(request.capsuleId!);
  expect(afterFailure?.currentStateVersionId).toBe(
    before?.currentStateVersionId,
  );
  expect(afterFailure?.currentStateGeneration).toBe(
    before?.currentStateGeneration,
  );
  expect(afterFailure?.currentOutputId).toBe(before?.currentOutputId);
  expect(retryDispatches).toEqual([
    {
      action: "apply",
      runId: applyRun.id,
      workspaceId: applyRun.workspaceId,
      cause: "controller_retry",
    },
  ]);

  await controller.dispatchQueuedRun({
    action: "apply",
    runId: applyRun.id,
    workspaceId: applyRun.workspaceId,
  });

  const completed = (await store.getApplyRun(applyRun.id))!;
  const output = await store.getLatestOutput(request.capsuleId!);
  expect(completed.status).toBe("succeeded");
  expect(applyJobs.map((job) => job.applyRun.id)).toEqual([
    applyRun.id,
    applyRun.id,
  ]);
  expect(applyJobs[1]?.rawOutputRef).toBe(applyJobs[0]?.rawOutputRef);
  expect(output?.rawArtifactRef).toBe(applyJobs[1]?.rawOutputRef);
  expect(
    await store.listStateVersions(request.capsuleId!, "production"),
  ).toHaveLength(1);
});

test("apply publishes the exact confirmed raw-output ref even when outputs are empty", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let confirmedRawOutputRef: string | undefined;
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1850),
    newId: deterministicIds(),
    runner: {
      ...stubRunner(),
      apply: (job) => {
        confirmedRawOutputRef = job.rawOutputRef;
        return Promise.resolve(
          fixtureStateCommit({ outputs: {}, rawOutputRef: job.rawOutputRef }),
        );
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_empty_raw_output",
  });
  const { planRun } = await controller.createPlanRun(request);

  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const output = await store.getLatestOutput(request.capsuleId!);
  expect(applied.applyRun.status).toBe("succeeded");
  expect(confirmedRawOutputRef).toBeDefined();
  expect(output?.rawArtifactRef).toBe(confirmedRawOutputRef);
  expect(output?.workspaceOutputs).toEqual({});
  expect(output?.publicOutputs).toEqual({});
});

test("apply missing its confirmed raw-output ref fails before ledger pointers publish", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1900),
    newId: deterministicIds(),
    runner: {
      ...stubRunner(),
      apply: () => Promise.resolve(fixtureStateCommit({ outputs: {} })),
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_missing_raw_output_ref",
  });
  const before = await store.getCapsule(request.capsuleId!);
  const { planRun } = await controller.createPlanRun(request);

  const failed = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(failed.applyRun.status).toBe("failed");
  expect(failed.applyRun.stateVersionId).toBeUndefined();
  expect(failed.applyRun.outputId).toBeUndefined();
  expect(
    await store.listStateVersions(request.capsuleId!, "production"),
  ).toEqual([]);
  expect(await store.getLatestOutput(request.capsuleId!)).toBeUndefined();
  const after = await store.getCapsule(request.capsuleId!);
  expect(after?.currentStateVersionId).toBe(before?.currentStateVersionId);
  expect(after?.currentStateGeneration).toBe(before?.currentStateGeneration);
  expect(after?.currentOutputId).toBe(before?.currentOutputId);
});

test("queued destroy cancellation emits one terminal callback after its early lifecycle callback", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(1850),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: noopEnqueue,
  });
  const update = await seedUpdatable(store, {
    capsuleId: "cap_destroy_cancel",
  });
  const queuedEvents: string[] = [];
  const terminalEvents: string[] = [];
  controller.setApplyRunQueuedObserver((run) => {
    queuedEvents.push(`${run.operation}:${run.status}`);
    return Promise.resolve();
  });
  controller.setTerminalRunObserver(async (run) => {
    if (!("planRunId" in run)) return;
    terminalEvents.push(
      `${run.operation}:${run.status}:${(await store.getApplyRun(run.id))?.status}`,
    );
  });
  const { planRun: queuedPlan } = await controller.createPlanRun({
    ...update,
    operation: "destroy",
  });
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planned = (await store.getPlanRun(queuedPlan.id))!;
  expect(planned.status).toBe("waiting_approval");
  await controller.approveRun(planned.id, { approvedBy: "ops" });
  const approved = (await store.getPlanRun(planned.id))!;
  const { applyRun } = await controller.createApplyRun({
    planRunId: approved.id,
    expected: applyExpectedGuardFromPlanRun(approved),
  });
  expect(applyRun.status).toBe("queued");

  const cancelled = await controller.cancelRun(applyRun.id);

  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.startedAt).toBeUndefined();
  expect(queuedEvents).toEqual(["destroy:queued"]);
  expect(terminalEvents).toEqual(["destroy:cancelled:cancelled"]);
});

test("a minted CredentialBundle never serializes its values", () => {
  const bundle = new CredentialBundle({ CLOUDFLARE_API_TOKEN: SECRET_TOKEN });
  expect(JSON.stringify({ bundle })).not.toContain(SECRET_TOKEN);
  expect(`${bundle}`).toEqual("[credential-bundle]");
  expect(bundle.env.CLOUDFLARE_API_TOKEN).toEqual(SECRET_TOKEN);
});

// --- idempotency ---

test("idempotency: dispatching a terminal run no-ops", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let planCalls = 0;
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(2000),
    newId: deterministicIds(),
    runner: countingRunner(() => planCalls++),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, { capsuleId: "cap_idem" });
  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("succeeded");
  expect(planCalls).toEqual(1);

  // Re-dispatch the same (now terminal) run: must not re-run the plan.
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: planRun.id,
    workspaceId: planRun.workspaceId,
  });
  expect(planCalls).toEqual(1);
});

test("idempotency: a fresh-heartbeat running run is not taken over", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const clock = controllableClock(3000);
  let planCalls = 0;
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: clock.now,
    newId: deterministicIds(),
    runner: countingRunner(() => planCalls++),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    // Hold dispatch so the run stays queued; we drive the consumer by hand.
    enqueueRun: noopEnqueue,
  });
  const request = await seedUpdatable(store, { capsuleId: "cap_fresh" });
  const { planRun } = await controller.createPlanRun(request);
  // Simulate a sibling consumer that marked it running with a fresh heartbeat.
  await store.putPlanRun({
    ...(await store.getPlanRun(planRun.id))!,
    status: "running",
    heartbeatAt: clock.value(),
  });
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: planRun.id,
    workspaceId: planRun.workspaceId,
  });
  expect(planCalls).toEqual(0); // fresh heartbeat -> sibling owns it
});

test("stale-heartbeat running run is taken over by the consumer", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const clock = controllableClock(4000);
  let planCalls = 0;
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: clock.now,
    newId: deterministicIds(),
    runner: countingRunner(() => planCalls++),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: noopEnqueue,
  });
  const request = await seedUpdatable(store, { capsuleId: "cap_stale" });
  const { planRun } = await controller.createPlanRun(request);
  // Marked running by a consumer that then crashed; heartbeat is far in the past.
  await store.putPlanRun({
    ...(await store.getPlanRun(planRun.id))!,
    status: "running",
    heartbeatAt: clock.value() - 11 * 60 * 1000,
  });
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: planRun.id,
    workspaceId: planRun.workspaceId,
  });
  expect(planCalls).toEqual(1); // stale heartbeat -> taken over
});

// --- retry semantics + DLQ ---

test("a runner failure records the run failed and never persists the minted credential", async () => {
  // The plan/apply consumers convert runner failures into a recorded `failed`
  // run (they do not rethrow infrastructure errors into the store path; the
  // queue-level retry-on-rethrow is exercised in the worker test). The minted
  // credential is on the dispatch job only, so it must not appear on the
  // persisted (failed) run.
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(5000),
    newId: deterministicIds(),
    runner: {
      plan: () => Promise.reject(new Error("opentofu init failed: exit 1")),
      apply: () => Promise.resolve({}),
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, { capsuleId: "cap_fail" });
  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("failed");
  expect(planRun.diagnostics?.[0]?.severity).toEqual("error");
  const dump = JSON.stringify(await store.getPlanRun(planRun.id));
  expect(dump).not.toContain(SECRET_TOKEN);
});

test("a retryable runner infrastructure reset requeues plan without dropping inputs", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let planCalls = 0;
  const retryDispatches: Parameters<EnqueueRun>[0][] = [];
  const enqueueRun: EnqueueRun = (dispatch) => {
    retryDispatches.push(dispatch);
    return Promise.resolve();
  };
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(5250),
    newId: deterministicIds(),
    runner: {
      plan: () => {
        planCalls++;
        if (planCalls === 1) {
          return Promise.reject(
            new OpenTofuRunnerInfrastructureError(
              "runner substrate reset during plan",
              { reason: "substrate_reset" },
            ),
          );
        }
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [CLOUDFLARE],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        });
      },
      apply: () => Promise.resolve({}),
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_plan_retry",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  expect(queuedPlan.status).toEqual("queued");
  expect(await store.getPlanRunInputs(queuedPlan.id)).toBeDefined();
  retryDispatches.length = 0;

  await expect(
    controller.dispatchQueuedRun({
      action: "plan",
      runId: queuedPlan.id,
      workspaceId: queuedPlan.workspaceId,
    }),
  ).rejects.toThrow(/retryable_runner_infrastructure_error/);

  const requeued = (await store.getPlanRun(queuedPlan.id))!;
  expect(requeued.status).toEqual("queued");
  expect(requeued.diagnostics).toBeUndefined();
  expect(await store.getPlanRunInputs(queuedPlan.id)).toBeDefined();
  expect(
    requeued.auditEvents.some((event) => event.type === "plan.retry_scheduled"),
  ).toEqual(true);
  expect(planCalls).toEqual(1);
  expect(retryDispatches).toEqual([
    {
      action: "plan",
      runId: queuedPlan.id,
      workspaceId: queuedPlan.workspaceId,
      cause: "controller_retry",
    },
  ]);

  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const completed = (await store.getPlanRun(queuedPlan.id))!;
  expect(completed.status).toEqual("succeeded");
  expect(planCalls).toEqual(2);
});

test("runner container capacity exhaustion requeues destroy plan without failing terminally", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let planCalls = 0;
  const retryDispatches: Parameters<EnqueueRun>[0][] = [];
  const enqueueRun: EnqueueRun = (dispatch) => {
    retryDispatches.push(dispatch);
    return Promise.resolve();
  };
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(5375),
    newId: deterministicIds(),
    runner: {
      plan: () => {
        planCalls++;
        if (planCalls === 1) {
          return Promise.reject(
            new OpenTofuRunnerInfrastructureError(
              RUNNER_CONTAINER_CAPACITY_EXCEEDED,
              { reason: "capacity_exhausted" },
            ),
          );
        }
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [CLOUDFLARE],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        });
      },
      apply: () => Promise.resolve({}),
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_destroy_plan_retry",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun({
    ...request,
    operation: "destroy",
  });
  expect(queuedPlan.status).toEqual("queued");
  retryDispatches.length = 0;

  await expect(
    controller.dispatchQueuedRun({
      action: "plan",
      runId: queuedPlan.id,
      workspaceId: queuedPlan.workspaceId,
    }),
  ).rejects.toThrow(/retryable_runner_infrastructure_error/);

  const requeued = (await store.getPlanRun(queuedPlan.id))!;
  expect(requeued.status).toEqual("queued");
  expect(requeued.diagnostics).toBeUndefined();
  expect(await store.getPlanRunInputs(queuedPlan.id)).toBeDefined();
  expect(
    requeued.auditEvents.some(
      (event) => event.type === "destroy_plan.retry_scheduled",
    ),
  ).toEqual(true);
  expect(planCalls).toEqual(1);
  expect(retryDispatches).toEqual([
    {
      action: "plan",
      runId: queuedPlan.id,
      workspaceId: queuedPlan.workspaceId,
      cause: "controller_retry",
    },
  ]);

  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const completed = (await store.getPlanRun(queuedPlan.id))!;
  expect(completed.status).toEqual("waiting_approval");
  expect(planCalls).toEqual(2);
});

test("runner infrastructure errors fail a plan after the retry budget is exhausted", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let planCalls = 0;
  const retryDispatches: Parameters<EnqueueRun>[0][] = [];
  const enqueueRun: EnqueueRun = (dispatch) => {
    retryDispatches.push(dispatch);
    return Promise.resolve();
  };
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(5450),
    newId: deterministicIds(),
    runner: {
      plan: () => {
        planCalls++;
        return Promise.reject(
          new OpenTofuRunnerInfrastructureError(
            RUNNER_CONTAINER_CAPACITY_EXCEEDED,
            { reason: "capacity_exhausted" },
          ),
        );
      },
      apply: () => Promise.resolve({}),
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_plan_retry_exhausted",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  retryDispatches.length = 0;

  await expect(
    controller.dispatchQueuedRun({
      action: "plan",
      runId: queuedPlan.id,
      workspaceId: queuedPlan.workspaceId,
    }),
  ).rejects.toThrow(/retryable_runner_infrastructure_error/);

  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });

  const failed = (await store.getPlanRun(queuedPlan.id))!;
  expect(failed.status).toEqual("failed");
  expect(failed.diagnostics?.[0]?.message).toContain(
    "runner_infrastructure_retry_exhausted",
  );
  expect(planCalls).toEqual(2);
  expect(retryDispatches).toEqual([
    {
      action: "plan",
      runId: queuedPlan.id,
      workspaceId: queuedPlan.workspaceId,
      cause: "controller_retry",
    },
  ]);
});

test("a typed indeterminate runner mutation terminally fails apply without retry classification", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let applyCalls = 0;
  const retryDispatches: Parameters<EnqueueRun>[0][] = [];
  const enqueueRun: EnqueueRun = (dispatch) => {
    retryDispatches.push(dispatch);
    return Promise.resolve();
  };
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(5500),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [CLOUDFLARE],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        }),
      apply: (job) => {
        applyCalls++;
        if (applyCalls === 1) {
          return Promise.reject(
            new OpenTofuRunnerExecutionError(
              "runner mutation outcome is indeterminate arbitrary-marker-run-diagnostic Authorization: Bearer run-diagnostic-token cookie=run-diagnostic-session body={raw:true}",
              { reason: "runner_mutation_indeterminate" },
            ),
          );
        }
        return Promise.resolve(
          fixtureStateCommit({
            outputs: {
              launch_url: {
                sensitive: false,
                value: "https://app.example.test",
              },
            },
            rawOutputRef: job.rawOutputRef,
          }),
        );
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun,
  });
  const request = await seedUpdatable(store, { capsuleId: "cap_retry" });
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  expect(queuedPlan.status).toEqual("queued");

  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;
  expect(planRun.status).toEqual("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("queued");
  retryDispatches.length = 0;

  await controller.dispatchQueuedRun({
    action: "apply",
    runId: applyRun.id,
    workspaceId: applyRun.workspaceId,
  });

  const failed = (await store.getApplyRun(applyRun.id))!;
  expect(failed.status).toEqual("failed");
  expect(failed.diagnostics?.[0]?.code).toEqual(
    "runner_mutation_indeterminate",
  );
  expect(failed.diagnostics?.[0]).toEqual({
    severity: "error",
    code: "runner_mutation_indeterminate",
    message: "runner failure (runner_mutation_indeterminate)",
  });
  const persistedFailure = JSON.stringify(failed);
  for (const forbidden of [
    "arbitrary-marker-run-diagnostic",
    "Bearer",
    "run-diagnostic-token",
    "run-diagnostic-session",
    "body",
    "raw:true",
  ]) {
    expect(persistedFailure).not.toContain(forbidden);
  }
  expect(
    failed.auditEvents.some(
      (event) => event.type === "apply.retry_scheduled",
    ),
  ).toEqual(false);
  expect(applyCalls).toEqual(1);
  expect(retryDispatches).toEqual([]);
});

test("runner infrastructure errors fail apply after the retry budget is exhausted", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let applyCalls = 0;
  const retryDispatches: Parameters<EnqueueRun>[0][] = [];
  const enqueueRun: EnqueueRun = (dispatch) => {
    retryDispatches.push(dispatch);
    return Promise.resolve();
  };
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(5650),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [CLOUDFLARE],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        }),
      apply: () => {
        applyCalls++;
        return Promise.reject(
          new OpenTofuRunnerInfrastructureError(
            RUNNER_CONTAINER_CAPACITY_EXCEEDED,
            { reason: "capacity_exhausted" },
          ),
        );
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_apply_retry_exhausted",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  retryDispatches.length = 0;

  await expect(
    controller.dispatchQueuedRun({
      action: "apply",
      runId: applyRun.id,
      workspaceId: applyRun.workspaceId,
    }),
  ).rejects.toThrow(/retryable_runner_infrastructure_error/);

  await controller.dispatchQueuedRun({
    action: "apply",
    runId: applyRun.id,
    workspaceId: applyRun.workspaceId,
  });

  const failed = (await store.getApplyRun(applyRun.id))!;
  expect(failed.status).toEqual("failed");
  expect(failed.diagnostics?.[0]?.message).toContain(
    "runner_infrastructure_retry_exhausted",
  );
  expect(applyCalls).toEqual(2);
  expect(retryDispatches).toEqual([
    {
      action: "apply",
      runId: applyRun.id,
      workspaceId: applyRun.workspaceId,
      cause: "controller_retry",
    },
  ]);
});

test("an ambiguous runner substrate reset terminally fails destroy without replaying provider mutations", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let destroyCalls = 0;
  const retryDispatches: Parameters<EnqueueRun>[0][] = [];
  const enqueueRun: EnqueueRun = (dispatch) => {
    retryDispatches.push(dispatch);
    return Promise.resolve();
  };
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(5750),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [CLOUDFLARE],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        }),
      apply: () =>
        Promise.resolve({
          outputs: {
            launch_url: {
              sensitive: false,
              value: "https://app.example.test",
            },
          },
        }),
      destroy: () => {
        destroyCalls++;
        if (destroyCalls === 1) {
          return Promise.reject(
            new OpenTofuRunnerInfrastructureError(
              "runner substrate reset during destroy",
              { reason: "substrate_reset" },
            ),
          );
        }
        return Promise.resolve(fixtureStateCommit());
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_destroy",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun({
    ...request,
    operation: "destroy",
  });
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;
  expect(planRun.status).toEqual("waiting_approval");
  await controller.approveRun(planRun.id, { approvedBy: "ops" });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("queued");
  retryDispatches.length = 0;

  await controller.dispatchQueuedRun({
    action: "apply",
    runId: applyRun.id,
    workspaceId: applyRun.workspaceId,
  });

  const failed = (await store.getApplyRun(applyRun.id))!;
  expect(failed.status).toEqual("failed");
  expect(failed.operation).toEqual("destroy");
  expect(failed.diagnostics?.[0]).toEqual({
    severity: "error",
    code: "substrate_reset",
    message: "runner failure (substrate_reset)",
  });
  expect(
    failed.auditEvents.some(
      (event) => event.type === "destroy.retry_scheduled",
    ),
  ).toEqual(false);
  expect(destroyCalls).toEqual(1);
  expect(retryDispatches).toEqual([]);
});

test("runner infrastructure errors fail destroy apply after the retry budget is exhausted", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let destroyCalls = 0;
  const retryDispatches: Parameters<EnqueueRun>[0][] = [];
  const enqueueRun: EnqueueRun = (dispatch) => {
    retryDispatches.push(dispatch);
    return Promise.resolve();
  };
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(5900),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [CLOUDFLARE],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        }),
      apply: () =>
        Promise.resolve({
          outputs: {
            launch_url: {
              sensitive: false,
              value: "https://app.example.test",
            },
          },
        }),
      destroy: () => {
        destroyCalls++;
        return Promise.reject(
          new OpenTofuRunnerInfrastructureError(
            RUNNER_CONTAINER_CAPACITY_EXCEEDED,
            { reason: "capacity_exhausted" },
          ),
        );
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_destroy_retry_exhausted",
  });
  const { planRun: queuedPlan } = await controller.createPlanRun({
    ...request,
    operation: "destroy",
  });
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    workspaceId: queuedPlan.workspaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;
  await controller.approveRun(planRun.id, { approvedBy: "ops" });
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  retryDispatches.length = 0;

  await controller.dispatchQueuedRun({
    action: "apply",
    runId: applyRun.id,
    workspaceId: applyRun.workspaceId,
  });

  await controller.dispatchQueuedRun({
    action: "apply",
    runId: applyRun.id,
    workspaceId: applyRun.workspaceId,
  });

  const failed = (await store.getApplyRun(applyRun.id))!;
  expect(failed.status).toEqual("failed");
  expect(failed.operation).toEqual("destroy");
  expect(failed.diagnostics?.[0]?.message).toContain(
    "runner_infrastructure_retry_exhausted",
  );
  expect(destroyCalls).toEqual(2);
  expect(retryDispatches).toEqual([
    {
      action: "apply",
      runId: applyRun.id,
      workspaceId: applyRun.workspaceId,
      cause: "controller_retry",
    },
  ]);
  const runnerUsage = (
    await store.listUsageEvents(applyRun.workspaceId)
  ).filter(
    (event) => event.runId === applyRun.id && event.kind === "runner_minute",
  );
  expect(runnerUsage).toHaveLength(0);
});

test("DLQ backstop marks a non-terminal run failed (retries-exhausted)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(6000),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: noopEnqueue, // leave the run queued
  });
  const request = await seedUpdatable(store, { capsuleId: "cap_dlq" });
  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("queued");

  const transitioned = await controller.markRunFailed(
    "plan",
    planRun.id,
    "retries-exhausted",
  );
  expect(transitioned).toEqual(true);
  const failed = await store.getPlanRun(planRun.id);
  expect(failed?.status).toEqual("failed");

  // Idempotent: a terminal run is not re-failed.
  expect(
    await controller.markRunFailed("plan", planRun.id, "retries-exhausted"),
  ).toEqual(false);
});

test("DLQ backstop does not clobber a running run with a fresh owner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(6500),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: noopEnqueue,
  });
  const request = await seedUpdatable(store, {
    capsuleId: "cap_dlq_live",
  });
  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("queued");

  const claimed = await store.transitionRun({
    id: planRun.id,
    kind: "plan",
    expectFrom: ["queued"],
    setLeaseToken: "lease_live",
    heartbeatAt: 6501,
    run: {
      ...planRun,
      status: "running",
      heartbeatAt: 6501,
      updatedAt: 6501,
      startedAt: 6501,
    },
  });
  expect(claimed.won).toEqual(true);

  const transitioned = await controller.markRunFailed(
    "plan",
    planRun.id,
    "retries-exhausted",
  );

  expect(transitioned).toEqual(false);
  expect((await store.getPlanRun(planRun.id))?.status).toEqual("running");
});

// --- state generation guard ---

test("state generation: a successful apply increments the capsule generation", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(7000),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, { capsuleId: "cap_gen" });
  const { planRun } = await controller.createPlanRun(request);
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applied.capsule?.currentStateGeneration).toEqual(1);
});

test("state generation: a stale plan is rejected at apply (state_generation_mismatch)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: monotonicNow(8000),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  // Capsule seeded at generation 0 with a current StateVersion.
  const request = await seedUpdatable(store, {
    capsuleId: "cap_stale_gen",
  });
  const capsuleId = request.capsuleId!;

  // First update against generation 0 -> apply advances to generation 1.
  const updateA = (await controller.createPlanRun(request)).planRun;
  expect(updateA.baseStateGeneration).toEqual(0);
  await controller.createApplyRun({
    planRunId: updateA.id,
    expected: applyExpectedGuardFromPlanRun(updateA),
  });
  const afterA = await store.getCapsule(capsuleId);
  expect(afterA?.currentStateGeneration).toEqual(1);

  // Second update created against generation 1.
  const updateB = (
    await controller.createPlanRun({
      workspaceId: request.workspaceId,
      capsuleId,
      operation: "update",
      source: { ...SOURCE, ref: "release-2" },
      requiredProviderRequirements:
        providerRequirementsForFixture([CLOUDFLARE]),
      requiredProviders: [CLOUDFLARE],
    })
  ).planRun;
  expect(updateB.baseStateGeneration).toEqual(1);

  // Apply updateB -> generation advances to 2.
  await controller.createApplyRun({
    planRunId: updateB.id,
    expected: applyExpectedGuardFromPlanRun(updateB),
  });
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule?.currentStateGeneration).toEqual(2);

  // Forge a stale plan that still claims generation 1, bypassing the
  // currentStateVersion guard, to prove the generation guard fires inside execute.
  const stalePlan = (await store.getPlanRun(updateB.id))!;
  const forgedId = "plan_forged_stale";
  await store.putPlanRun({
    ...stalePlan,
    id: forgedId,
    baseStateGeneration: 1,
    capsuleCurrentStateVersionId: capsule!.currentStateVersionId,
    appliedApplyRunId: undefined,
    status: "succeeded",
  });
  const staleApply = await controller.createApplyRun({
    planRunId: forgedId,
    expected: applyExpectedGuardFromPlanRun(
      (await store.getPlanRun(forgedId))!,
    ),
  });
  expect(staleApply.applyRun.status).toBe("failed");
  expect(staleApply.applyRun.diagnostics?.[0]?.message).toContain(
    "state_generation_mismatch",
  );
});

// --- fakes / helpers ---

function capturingRunner(captured: {
  plan?: OpenTofuPlanJob;
  apply?: OpenTofuApplyJob;
  destroy?: OpenTofuDestroyJob;
}): OpenTofuRunner {
  return {
    plan: (job) => {
      captured.plan = job;
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
      });
    },
    apply: (job) => {
      captured.apply = job;
      return Promise.resolve(fixtureStateCommit({
        outputs: {
          launch_url: { sensitive: false, value: "https://app.example.test" },
        },
        rawOutputRef: job.rawOutputRef,
      }));
    },
    destroy: (job) => {
      captured.destroy = job;
      return Promise.resolve(fixtureStateCommit());
    },
  };
}

function countingRunner(onPlan: () => void): OpenTofuRunner {
  return {
    plan: () => {
      onPlan();
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
      });
    },
    apply: () => Promise.resolve({}),
  };
}

function stubRunner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: (job) =>
      Promise.resolve(fixtureStateCommit({
        outputs: {
          launch_url: { sensitive: false, value: "https://app.example.test" },
        },
        rawOutputRef: job.rawOutputRef,
      })),
    destroy: () => Promise.resolve(fixtureStateCommit()),
  };
}

function planArtifact() {
  return {
    kind: "runner-local",
    ref: "runner-local://plan_async/tfplan",
    digest: PLAN_DIGEST,
    contentType: "application/vnd.opentofu.plan",
  } as const;
}

/** Minimal Vault fake: mint returns the configured env per provider. */
function fakeVault(
  byProvider: Readonly<Record<string, Readonly<Record<string, string>>>>,
): ConnectionVault {
  return {
    register: (
      _input: RegisterConnectionInput,
    ): Promise<ProviderConnection> => {
      throw new Error("not used");
    },
    test: (): Promise<TestConnectionResult> => {
      throw new Error("not used");
    },
    revoke: () => Promise.resolve(false),
    mint: (_spaceId, providers) => {
      const env: Record<string, string> = {};
      const evidence = [];
      for (const provider of providers) {
        Object.assign(env, byProvider[provider] ?? {});
        evidence.push({
          provider,
          connectionId: "conn_shared",
          temporary: true,
          ttlEnforced: true,
        });
      }
      return Promise.resolve(new PhaseMintBundle({ env }, [], evidence));
    },
    mintForPhase: () =>
      Promise.resolve(new PhaseMintBundle({ env: {} }, [], [])),
    mintForCapsuleProviderBindings: (
      _spaceId: string,
      entries: readonly CapsuleProviderBindingMintEntry[],
    ) => {
      const env: Record<string, string> = {};
      const evidence = [];
      for (const entry of entries) {
        env.CLOUDFLARE_API_TOKEN = SECRET_TOKEN;
        evidence.push({
          provider: CLOUDFLARE,
          connectionId: entry.connectionId,
          temporary: true,
          ttlEnforced: true,
        });
      }
      return Promise.resolve(new PhaseMintBundle({ env }, [], evidence));
    },
  };
}

const noopEnqueue: EnqueueRun = () => Promise.resolve();

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

// A clock that advances by 1 per call; good enough for ordering audit events.
function monotonicNow(start: number): () => number {
  let value = start;
  return () => value++;
}

// A clock the test can read without advancing it, for heartbeat-window math.
function controllableClock(start: number): {
  now: () => number;
  value: () => number;
} {
  let value = start;
  return {
    now: () => value++,
    value: () => value,
  };
}
