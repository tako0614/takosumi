import { expect, spyOn, test } from "bun:test";
import { CloudflareContainerOpenTofuRunner } from "../../../worker/src/container_runner.ts";
import { dispatchRunOwnerWithApplyReceipts, registerRunOwnerApplyReceiptReader } from "../../../worker/src/committed_apply_recovery.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { OpenTofuController, RUN_HEARTBEAT_STALE_MS, applyExpectedGuardFromPlanRun, type OpenTofuApplyJob } from "../../../core/domains/deploy-control/mod.ts";
import { RunEnvResolver } from "../../../core/domains/deploy-control/run_env_resolver.ts";
import { RunCredentialBroker } from "../../../core/domains/deploy-control/run_credential_broker.ts";
import { BillingService } from "../../../core/domains/deploy-control/billing_service.ts";
import { createDefaultRunnerProfiles } from "../../../core/domains/deploy-control/runner_profiles.ts";
import { InMemoryOpenTofuControlStore, planRunExecutionInputsDigestMaterial } from "../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { stableJsonDigest } from "../../../core/adapters/source/digest.ts";
import { seedCapsuleModel, FIXTURE_EXECUTION_EVIDENCE_AUTHORITY, fixtureExecutionEvidence } from "../../helpers/deploy-control/model_fixture.ts";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
async function fixture(failure = false, afterWorkerUpdate = false, missingOutput = false) {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    requiredProviders: [],
    ...(missingOutput ? {
      installConfig: {
        outputAllowlist: {
          endpoint: { from: "missing_output", type: "url", required: true },
        },
      },
    } : {}),
  });
  const profile = createDefaultRunnerProfiles(1)[0]!;
  let calls = 0, reads = 0, inspections = 0;
  let phase = "completed", status = "valid", malformed = false;
  let responseStatus = failure ? 500 : 200;
  let mutate: ((value: Record<string, unknown>) => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  let job!: OpenTofuApplyJob;
  const runner = new CloudflareContainerOpenTofuRunner({ RUNNER: {
    idFromName: (id: string) => id,
    get: () => ({
      inspectMutationAuthority: async (id: string, action: string) => {
        inspections++;
        return { kind: "takosumi.runner-mutation-inspection@v1", runId: id,
          authority: {
            status, action, phase, version: 1, fence: 1, redispatchBlocked: true,
            completion: phase === "completed" ? {} : undefined,
            ...(afterWorkerUpdate ? { admittedExecutionAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY } : {}),
          },
        };
      },
      adoptDeterminedMutation: async (id: string, action: string, allocation: { stateScope: unknown; rawOutputRef: string }) => {
        reads++; await release?.(); expect(id).toBe(job.applyRun.id); expect(action).toBe("apply");
        const evidence = fixtureExecutionEvidence(job, "apply", failure ? { outcome: "provider_failed_state_persisted" } : {});
        const value = { status: failure ? "failed" : "succeeded", exitCode: failure ? 1 : 0,
          state: { digest: DIGEST, ...allocation.stateScope as object },
          executionEvidence: evidence,
          ...(failure ? { errorCode: "provider_execution_failed", providerExecutionFailure: { kind: "provider_execution_failed", statePersistence: "persisted" } } : { outputs: {}, rawOutputRef: allocation.rawOutputRef }),
        };
        mutate?.(value);
        return Response.json(malformed ? { status: "unknown" } : value, { status: responseStatus });
      },
      fetch: async () => { calls++; throw new Error("unexpected mutation transport"); },
    }),
  } } as unknown as CloudflareWorkerEnv);
  const planning = new OpenTofuController({ store,
    runner: { apply: async () => { throw new Error("planning cannot Apply"); }, plan: async () => ({ planDigest: DIGEST, planArtifact: { kind: "runner-local", ref: "opaque-plan", digest: DIGEST }, providerLockArtifact: null }) },
    runnerProfiles: [profile], defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(), executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  });
  const { planRun } = await planning.createCapsulePlan(seeded.capsule.id);
  expect(planRun.status).toBe("succeeded");
  const controller = new OpenTofuController({ store, runner, runnerProfiles: [profile], defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: afterWorkerUpdate ? {
      ...FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      controllerArtifact: { digest: `sha256:${"1".repeat(64)}`, immutable: true },
      runnerArtifact: { digest: `sha256:${"1".repeat(64)}`, immutable: true },
    } : FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    enqueueRun: async () => {},
  });
  const { applyRun } = await controller.createApplyRun({ planRunId: planRun.id, expected: applyExpectedGuardFromPlanRun(planRun) });
  const heartbeatAt = Date.now() - RUN_HEARTBEAT_STALE_MS - 2_000;
  const run = { ...applyRun, status: "running" as const, startedAt: heartbeatAt, heartbeatAt };
  await store.putApplyRun(run);
  job = { applyRun: run, planRun, planArtifact: planRun.planArtifact!, runnerProfile: profile,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    executionEvidenceCommit: {
      stateVersionId: `state_${(await stableJsonDigest({ kind: "takosumi.state-version-id@v1", applyRunId: run.id })).slice(7)}`,
      outputId: `out_${(await stableJsonDigest({ kind: "takosumi.output-id@v1", applyRunId: run.id })).slice(7)}`,
    },
  };
  const operations = { dispatchQueuedRun: controller.dispatchQueuedRun.bind(controller) };
  registerRunOwnerApplyReceiptReader(operations, runner);
  const dispatch = () => dispatchRunOwnerWithApplyReceipts(operations, { action: "apply", runId: run.id, workspaceId: run.workspaceId }, { deadlineAt: Date.now() + 5_000 });
  return { store, run, runner, controller, operations, job, dispatch,
    setPhase: (value: string) => { phase = value; }, setStatus: (value: string) => { status = value; }, setMalformed: () => { malformed = true; }, setResponseStatus: (value: number) => { responseStatus = value; },
    setMutate: (fn: typeof mutate) => { mutate = fn; }, setRelease: (fn: typeof release) => { release = fn; },
    counts: () => ({ calls, reads, inspections }),
  };
}

for (const failure of [false, true]) test(`RunOwner private route settles exact stale completed receipt without mint or dispatch: failure=${failure}`, async () => {
  const f = await fixture(failure);
  const environment = spyOn(RunEnvResolver.prototype, "resolveRunEnvironment");
  const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials"), renew = spyOn(RunCredentialBroker.prototype, "renewRunCredential");
  const apply = spyOn(f.runner, "apply").mockImplementation(async () => { throw new Error("receipt observation must precede Apply"); });
  try {
    await f.dispatch();
    const run = await f.store.getApplyRun(f.run.id), capsule = await f.store.getCapsule(f.run.capsuleId!);
    expect(run?.id).toBe(f.run.id); expect(run?.status).toBe(failure ? "failed" : "succeeded");
    expect(run?.startedAt).toBe(f.run.startedAt); expect(run?.planRunId).toBe(f.run.planRunId);
    expect(capsule?.currentStateGeneration).toBe(1); expect(capsule?.status).toBe(failure ? "error" : "active");
    if (failure) { expect(run?.outputId).toBeUndefined(); expect(capsule?.currentOutputId).toBeUndefined(); }
    const saved = JSON.stringify(run);
    await f.dispatch(); expect(JSON.stringify(await f.store.getApplyRun(f.run.id))).toBe(saved);
    expect(f.counts()).toEqual({ calls: 0, reads: 1, inspections: 1 });
    expect(environment.mock.calls.length).toBeGreaterThan(0);
    expect(environment.mock.calls.every(([input]) => input.mintCredentials === false)).toBe(true);
    for (const spy of [mint, renew, apply]) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of [environment, mint, renew, apply]) spy.mockRestore(); }
});

test("RunOwner settles a completed Apply from its admitted artifacts across a Worker update", async () => {
  const f = await fixture(false, true);
  const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
  const apply = spyOn(f.runner, "apply");
  try {
    await f.dispatch();
    expect(await f.store.getApplyRun(f.run.id)).toMatchObject({
      id: f.run.id, status: "succeeded",
      executionEvidence: { authority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY },
    });
    expect((await f.store.getCapsule(f.run.capsuleId!))?.currentStateGeneration).toBe(1);
    expect(f.counts()).toEqual({ calls: 0, reads: 1, inspections: 1 });
    expect(mint).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  } finally {
    mint.mockRestore();
    apply.mockRestore();
  }
});

test("RunOwner records output projection failure from a confirmed Apply receipt without redispatch", async () => {
  const f = await fixture(false, true, true);
  const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
  const apply = spyOn(f.runner, "apply");
  const finishedAt = new Date(f.run.startedAt + 600).toISOString();
  f.setMutate((value) => {
    value.executionEvidence = {
      ...fixtureExecutionEvidence(f.job, "apply"),
      committedAt: finishedAt,
    };
  });
  const release = spyOn(BillingService.prototype, "releaseApplyBilling")
    .mockImplementation(async () => {
      expect((await f.store.getApplyRun(f.run.id))?.status).toBe("failed");
      expect((await f.store.getPlanRun(f.run.planRunId))?.appliedApplyRunId).toBe(f.run.id);
      throw new Error("fixture billing reservation release unavailable");
    });
  const rating = spyOn(BillingService.prototype, "rateUsageMeasurement");
  try {
    await f.dispatch();
    const failed = await f.store.getApplyRun(f.run.id);
    expect(failed).toMatchObject({ id: f.run.id, status: "failed" });
    expect(failed?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "apply_output_projection_failed" }),
    );
    expect(failed?.auditEvents.find(({ type }) => type === "apply.failed")?.data)
      .toMatchObject({ providerDispatched: true, providerApplySucceeded: true });
    expect(await f.store.getCapsule(f.run.capsuleId!)).toMatchObject({
      status: "error",
      currentStateGeneration: 0,
    });
    expect((await f.store.getPlanRun(f.run.planRunId))?.appliedApplyRunId).toBe(f.run.id);
    expect(failed?.stateVersionId).toBeUndefined();
    expect(failed?.outputId).toBeUndefined();
    expect(f.counts()).toEqual({ calls: 0, reads: 1, inspections: 1 });
    await f.dispatch();
    expect(release).toHaveBeenCalledTimes(1);
    expect(rating).toHaveBeenCalledTimes(1);
    expect(rating).toHaveBeenCalledWith(expect.objectContaining({
      runId: f.run.id,
      kind: "runner_minute",
      quantity: 600 / 60_000,
      createdAt: finishedAt,
    }));
    expect(mint).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  } finally {
    mint.mockRestore();
    apply.mockRestore();
    release.mockRestore();
    rating.mockRestore();
  }
});

test("completed unreadable/mismatched receipt holds the original Run without claim, mint or dispatch", async () => {
  for (const kind of ["malformed", "foreign", "missing", "evidence", "deadline"] as const) {
    const f = await fixture();
    if (kind === "malformed") f.setStatus("malformed");
    if (kind === "foreign") f.setMutate(value => { value.executionEvidence = fixtureExecutionEvidence({ ...f.job, planRun: { ...f.job.planRun, id: "another-plan" } }, "apply"); });
    if (kind === "missing") f.setMalformed();
    if (kind === "evidence") f.setMutate(value => { delete value.executionEvidence; });
    const deadline = Date.now() + 5_000;
    const clock = kind === "deadline" ? spyOn(Date, "now") : undefined;
    if (clock) f.setRelease(async () => { clock.mockReturnValue(deadline + 1); });
    const saved = JSON.stringify(await f.store.getApplyRun(f.run.id));
    const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
    const apply = spyOn(f.runner, "apply");
    try {
      if (kind === "deadline") await dispatchRunOwnerWithApplyReceipts(f.operations, { action: "apply", runId: f.run.id, workspaceId: f.run.workspaceId }, { deadlineAt: deadline });
      else await f.dispatch();
      expect(JSON.stringify(await f.store.getApplyRun(f.run.id))).toBe(saved);
      expect((await f.store.getCapsule(f.run.capsuleId!))?.currentStateGeneration).toBe(0);
      expect(f.counts().calls).toBe(0); expect(mint).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    } finally { clock?.mockRestore(); mint.mockRestore(); apply.mockRestore(); }
  }
});


test("fresh and queued work skip observation; noncommitted phases keep the original prepare admission", async () => {
  for (const phase of ["fresh", "queued", "absent", "preparing", "not_dispatched", "dispatched", "indeterminate", "orphaned"]) {
    const f = await fixture();
    if (phase === "fresh") await f.store.putApplyRun({ ...f.run, heartbeatAt: Date.now() });
    else if (phase === "queued") await f.store.putApplyRun({ ...f.run, status: "queued" });
    else if (phase === "absent") f.setStatus("absent");
    else f.setPhase(phase);
    const apply = spyOn(f.runner, "apply").mockImplementation(async job => ({ stateDigest: DIGEST, rawOutputRef: job.rawOutputRef, outputs: {}, executionEvidence: fixtureExecutionEvidence(job, "apply") }));
    try {
      await f.dispatch();
      expect(f.counts().reads).toBe(0);
      expect(f.counts().inspections).toBe(phase === "fresh" || phase === "queued" ? 0 : 1);
      expect(apply.mock.calls.length).toBe(phase === "fresh" ? 0 : 1);
      expect((await f.store.getApplyRun(f.run.id))?.status).toBe(phase === "fresh" ? "running" : "succeeded");
    } finally { apply.mockRestore(); }
  }
});

test("prepared lifecycle and private-file work do not select the receipt observer", async () => {
  for (const privateFile of [false, true]) {
    const f = await fixture();
    const inputs = await f.store.getPlanRunInputs(f.run.planRunId);
    expect(inputs).toBeDefined();
    const changed = { ...inputs!,
      ...(privateFile ? { privateRunFileSlots: [{ slot: "synthetic-private" }] } : { lifecycleActions: [{ apiVersion: "takosumi.dev/v1alpha1", kind: "command", id: "activate", phase: "post_apply", executor: "runner", command: ["bun", "run", "activate"], runnerCapability: "capsule.lifecycle.command.v1" }] }),
    } as typeof inputs;
    await f.store.putPlanRunInputs(changed!);
    const plan = (await f.store.getPlanRun(f.run.planRunId))!;
    await f.store.putPlanRun({ ...plan, executionInputsDigest: await stableJsonDigest(planRunExecutionInputsDigestMaterial(changed!)) });
    // The canonical preparation matches: capability/lifecycle admission now
    // follows its existing ordinary path, never this receipt-only observer.
    await f.dispatch().catch(() => {});
    expect(f.counts().inspections).toBe(0); expect(f.counts().reads).toBe(0);
  }
});


test("unreadable prepared inputs inspect once and preserve completed/unknown Runs", async () => {
  for (const phase of ["completed", "malformed", "preparing", "not_dispatched", "dispatched", "indeterminate", "orphaned"]) {
    const f = await fixture();
    if (phase === "malformed") f.setStatus("malformed"); else f.setPhase(phase);
    const saved = JSON.stringify(await f.store.getApplyRun(f.run.id));
    const read = spyOn(f.store, "getPlanRunInputs").mockResolvedValue(undefined);
    const claim = spyOn(f.store, "transitionRun"), apply = spyOn(f.runner, "apply");
    try {
      await f.dispatch();
      expect(f.counts()).toEqual({ calls: 0, reads: 0, inspections: 1 });
      if (phase === "preparing" || phase === "not_dispatched") {
        expect((await f.store.getApplyRun(f.run.id))?.status).toBe("failed");
      } else {
        expect(JSON.stringify(await f.store.getApplyRun(f.run.id))).toBe(saved);
        expect(claim).not.toHaveBeenCalled();
      }
      expect(apply).not.toHaveBeenCalled();
    } finally { read.mockRestore(); claim.mockRestore(); apply.mockRestore(); }
  }
});


test("only the determined persisted provider failure HTTP 500 settles; other errors hold", async () => {
  for (const [failure, status] of [[true, 503], [true, 409], [true, 200], [false, 500]] as const) {
    const f = await fixture(failure); f.setResponseStatus(status);
    const saved = JSON.stringify(await f.store.getApplyRun(f.run.id));
    const claim = spyOn(f.store, "transitionRun"), mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
    try {
      await f.dispatch(); expect(JSON.stringify(await f.store.getApplyRun(f.run.id))).toBe(saved);
      expect(f.counts()).toEqual({ calls: 0, reads: 1, inspections: 1 });
      expect(claim).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled();
    } finally { claim.mockRestore(); mint.mockRestore(); }
  }
});


test("Core selects the configured executor, never a persisted/default observer's adapter", async () => {
  const f = await fixture(); const profile = { ...f.job.runnerProfile!, executorId: "configured-worker-fixture" };
  const apply = async (job: OpenTofuApplyJob) => ({ stateDigest: DIGEST, rawOutputRef: job.rawOutputRef, outputs: {}, executionEvidence: fixtureExecutionEvidence(job, "apply") });
  const other = { apply, plan: async () => { throw new Error("not planning"); } };
  const call = spyOn(other, "apply");
  const controller = new OpenTofuController({ store: f.store, runner: f.runner,
    runnerExecutors: new Map([[profile.executorId, other]]), runnerProfiles: [profile], defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(), executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  });
  const operations = { dispatchQueuedRun: controller.dispatchQueuedRun.bind(controller) };
  registerRunOwnerApplyReceiptReader(operations, f.runner);
  try {
    await dispatchRunOwnerWithApplyReceipts(operations, { action: "apply", runId: f.run.id, workspaceId: f.run.workspaceId });
    expect(call).toHaveBeenCalledTimes(1); expect(f.counts()).toEqual({ calls: 0, reads: 0, inspections: 0 });
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("succeeded");
  } finally { call.mockRestore(); }
});

test("opaque probe cannot authorize another action, Run or Workspace", async () => {
  const f = await fixture(); const control = { committedApplyReceiptProbe: f.runner.committedApplyReceiptProbe(f.run.id) };
  for (const action of ["plan", "source_sync", "restore"] as const) await expect(f.controller.dispatchQueuedRun({ action, runId: f.run.id, workspaceId: f.run.workspaceId }, control)).rejects.toThrow();
  await expect(f.controller.dispatchQueuedRun({ action: "apply", runId: f.run.id, workspaceId: "other" }, control)).rejects.toThrow();
  await expect(f.controller.dispatchQueuedRun({ action: "apply", runId: f.run.id, workspaceId: f.run.workspaceId }, { committedApplyReceiptProbe: f.runner.committedApplyReceiptProbe("another") })).rejects.toThrow();
  expect(f.counts()).toEqual({ calls: 0, reads: 0, inspections: 0 });
  expect((await f.store.getApplyRun(f.run.id))?.status).toBe("running");
});
