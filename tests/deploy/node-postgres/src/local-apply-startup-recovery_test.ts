import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRunnerProfiles } from "../../../../core/domains/deploy-control/runner_profiles.ts";
import { OpenTofuController, RUN_HEARTBEAT_STALE_MS, applyExpectedGuardFromPlanRun, type OpenTofuApplyJob, type OpenTofuApplyResult, type OpenTofuDestroyJob, type RunDispatchControl } from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { stableJsonDigest, sha256Digest } from "../../../../core/adapters/source/digest.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { seedCapsuleModel, FIXTURE_EXECUTION_EVIDENCE_AUTHORITY, fixtureExecutionEvidence } from "../../../helpers/deploy-control/model_fixture.ts";
import { createFileOpenTofuStateArtifactStore, createHttpOpenTofuRunner, createLocalOpenTofuRunner, type LocalOpenTofuStateArtifact } from "../../../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { withCommittedLocalApplyRecovery } from "../../../../deploy/node-postgres/src/local-apply-recovery-capability.ts";
import { recoverLocalAppliesAtStartup, startLocalApplyStartupRecovery } from "../../../../deploy/node-postgres/src/local-apply-startup-recovery.ts";
import { RunEnvResolver } from "../../../../core/domains/deploy-control/run_env_resolver.ts";
import { RunCredentialBroker } from "../../../../core/domains/deploy-control/run_credential_broker.ts";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const STATE = new TextEncoder().encode('{"version":4,"serial":1,"lineage":"startup-fixture","outputs":{},"resources":[]}');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "takosumi-startup-recovery-"));
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, { requiredProviders: [] });
  const profile = createDefaultRunnerProfiles(1)[0]!;
  const archiveStore = { write: async () => {}, read: async () => { throw new Error("startup must not restore source"); } };
  const stateStore = createFileOpenTofuStateArtifactStore(root, new PartitionedSecretBoundaryCrypto({ globalPassphrase: "startup-recovery-synthetic-passphrase-32-bytes" }));
  const runner = createHttpOpenTofuRunner({ archiveStore, stateStore, baseUrl: "http://127.0.0.1:1/unused" });
  const controller = new OpenTofuController({ store, runner, runnerProfiles: [profile], defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(), executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    enqueueRun: async () => {},
  });
  // Use the normal create/prepare APIs for both identities; only the crashed
  // running liveness is seeded below. No native/provider execution is claimed.
  const planning = new OpenTofuController({ store,
    runner: { apply: async () => { throw new Error("planning fixture cannot Apply"); }, plan: async () => ({ planDigest: DIGEST, planArtifact: { kind: "runner-local", ref: "opaque-fixture-plan", digest: DIGEST }, providerLockArtifact: null }) },
    runnerProfiles: [profile], defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(), executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  });
  const { planRun } = await planning.createCapsulePlan(seeded.capsule.id);
  expect(planRun.status).toBe("succeeded");
  const { applyRun: queued } = await controller.createApplyRun({ planRunId: planRun.id, expected: applyExpectedGuardFromPlanRun(planRun) });
  const heartbeatAt = Date.now() - RUN_HEARTBEAT_STALE_MS - 2_000;
  const run = { ...queued, status: "running" as const, startedAt: heartbeatAt, heartbeatAt };
  await store.putApplyRun(run);
  const stateScope = { workspaceId: run.workspaceId, subject: { kind: "capsule" as const, id: seeded.capsule.id },
    environment: seeded.capsule.environment, generation: 1,
    stateRef: new ObjectKeyArtifactReferenceAllocator().allocate({ kind: "state", workspaceId: run.workspaceId,
      subject: { kind: "capsule", id: seeded.capsule.id }, environment: seeded.capsule.environment, generation: 1,
      storageRoot: await store.getCapsuleStorageRoot(seeded.capsule.id) }) };
  const job: OpenTofuApplyJob = { applyRun: run, planRun, planArtifact: planRun.planArtifact!, runnerProfile: profile, stateScope,
    rawOutputRef: "fixture-raw-output", executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    executionEvidenceCommit: {
      stateVersionId: `state_${(await stableJsonDigest({ kind: "takosumi.state-version-id@v1", applyRunId: run.id })).slice(7)}`,
      outputId: `out_${(await stableJsonDigest({ kind: "takosumi.output-id@v1", applyRunId: run.id })).slice(7)}`,
    } };
  const receipt = { ...stateScope, createdByRunId: run.id, action: "apply" as const,
    stateDigest: await sha256Digest(STATE), stateBytes: STATE,
    result: { stateDigest: await sha256Digest(STATE), outputs: {}, executionEvidence: fixtureExecutionEvidence(job, "apply") } };
  let dispatches = 0;
  const input = { store, runner, profiles: [profile], startedAt: Date.now(), operations: { controller, dispatchQueuedRun: async (...args: Parameters<typeof controller.dispatchQueuedRun>) => {
    dispatches++;
    await controller.dispatchQueuedRun(...args);
  } } };
  return { root, store, runner, profile, controller, planning, stateStore, archiveStore, input, run, job, receipt, get dispatches() { return dispatches; } };
}

test("startup adopts the exact encrypted committed Apply through the existing Core consumer once", async () => {
  const f = await fixture();
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw new Error("no Runner HTTP in receipt recovery"); }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await f.stateStore.commit(f.receipt);
    await recoverLocalAppliesAtStartup(f.input);
    const final = await f.store.getApplyRun(f.run.id);
    expect(final?.status).toBe("succeeded");
    expect(final?.id).toBe(f.run.id);
    expect(final?.planRunId).toBe(f.run.planRunId);
    expect((await f.store.getCapsule(f.run.capsuleId!))?.currentStateGeneration).toBe(1);
    await recoverLocalAppliesAtStartup(f.input);
    expect(f.dispatches).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  } finally { transport.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
});

async function prepareStaleDestroy(f: Awaited<ReturnType<typeof fixture>>) {
  await f.stateStore.commit(f.receipt);
  await recoverLocalAppliesAtStartup(f.input);
  const capsule = (await f.store.getCapsule(f.run.capsuleId!))!;
  expect(capsule).toMatchObject({ status: "active", currentStateGeneration: 1 });
  const { planRun } = await f.planning.createCapsuleDestroyPlan(capsule.id);
  await f.controller.approveRun(planRun.id, { approvedBy: "fixture-owner" });
  const { applyRun } = await f.controller.createApplyRun({
    planRunId: planRun.id, expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const heartbeatAt = f.run.heartbeatAt!;
  const run = { ...applyRun, status: "running" as const, startedAt: heartbeatAt, heartbeatAt };
  await f.store.putApplyRun(run);
  const stateScope = {
    ...f.job.stateScope!, generation: 2,
    stateRef: new ObjectKeyArtifactReferenceAllocator().allocate({
      kind: "state", workspaceId: run.workspaceId, subject: { kind: "capsule", id: capsule.id },
      environment: capsule.environment, generation: 2, storageRoot: await f.store.getCapsuleStorageRoot(capsule.id),
    }),
  };
  const job: OpenTofuDestroyJob = {
    applyRun: run, planRun, planArtifact: planRun.planArtifact!, runnerProfile: f.profile, stateScope,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    executionEvidenceCommit: {
      stateVersionId: `state_${(await stableJsonDigest({ kind: "takosumi.state-version-id@v1", applyRunId: run.id })).slice(7)}`,
      destroyed: true,
    },
  };
  const stateDigest = await sha256Digest(STATE);
  const receipt = {
    ...stateScope, createdByRunId: run.id, action: "destroy" as const, stateDigest, stateBytes: STATE,
    result: {
      stateDigest,
      executionEvidence: { ...fixtureExecutionEvidence(job, "destroy"), committedAt: new Date(heartbeatAt + 1).toISOString() },
    },
  };
  return { capsule, run, receipt };
}

test("startup settles an exact sealed Destroy once without Runner transport or a new output", async () => {
  const f = await fixture();
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => {
    throw new Error("no Runner HTTP in receipt recovery");
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    const { capsule, run, receipt } = await prepareStaleDestroy(f);
    await recoverLocalAppliesAtStartup(f.input);
    expect((await f.store.getApplyRun(run.id))?.status).toBe("running");
    expect(f.dispatches).toBe(1);

    await f.stateStore.commit(receipt);
    await recoverLocalAppliesAtStartup(f.input);
    const final = await f.store.getApplyRun(run.id);
    expect(final).toMatchObject({
      id: run.id, planRunId: run.planRunId, status: "succeeded",
      executionEvidence: { commit: { destroyed: true } },
    });
    expect(final?.outputId).toBeUndefined();
    expect(await f.store.getCapsule(capsule.id)).toMatchObject({ status: "destroyed", currentStateGeneration: 2 });
    expect(await f.store.getStateVersion(capsule.currentStateVersionId!)).toMatchObject({ generation: 1 });
    await recoverLocalAppliesAtStartup(f.input);
    expect(f.dispatches).toBe(2);
    expect(transport).not.toHaveBeenCalled();
  } finally { transport.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
});

test("startup Destroy receipt cannot fall through if the configured executor has changed", async () => {
  const f = await fixture();
  try {
    const { run, receipt } = await prepareStaleDestroy(f);
    await f.stateStore.commit(receipt);
    let ordinaryCalls = 0;
    const different = {
      plan: async () => { throw new Error("unexpected Plan"); },
      apply: async () => { throw new Error("unexpected Apply"); },
      destroy: async () => { ordinaryCalls++; throw new Error("unexpected ordinary Destroy"); },
    };
    const controller = new OpenTofuController({
      store: f.store, runner: different, runnerProfiles: [f.profile], defaultRunnerProfileId: f.profile.id,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    });
    let received = 0;
    await recoverLocalAppliesAtStartup({ ...f.input, operations: {
      controller,
      dispatchQueuedRun: async (...args: Parameters<typeof controller.dispatchQueuedRun>) => {
        received++;
        await controller.dispatchQueuedRun(...args);
      },
    } });
    expect(received).toBe(1);
    expect(ordinaryCalls).toBe(0);
    expect((await f.store.getApplyRun(run.id))?.status).toBe("running");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("startup leaves fresh, absent, foreign, private-file and unconfigured work untouched", async () => {
  const f = await fixture();
  try {
    await recoverLocalAppliesAtStartup(f.input);
    expect(f.dispatches).toBe(0);
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("running");
    await f.stateStore.commit(f.receipt);
    await f.store.putApplyRun({ ...f.run, heartbeatAt: Date.now() });
    await recoverLocalAppliesAtStartup(f.input);
    expect(f.dispatches).toBe(0);
    await f.store.putApplyRun(f.run);
    const inputs = await f.store.getPlanRunInputs(f.run.planRunId);
    if (!inputs) throw new Error("missing prepared fixture");
    const read = spyOn(f.store, "getPlanRunInputs").mockResolvedValue({ ...inputs, privateRunFileSlots: [{ slot: "sensitive-fixture" }] });
    await recoverLocalAppliesAtStartup(f.input);
    read.mockRestore();
    await recoverLocalAppliesAtStartup({ ...f.input, runner: undefined });
    await recoverLocalAppliesAtStartup({ ...f.input, runner: { plan: async () => { throw new Error("unselected Runner"); }, apply: async () => { throw new Error("unselected Runner"); } } });
    const foreign = spyOn(f.stateStore, "read").mockResolvedValue({ ...f.receipt, workspaceId: "foreign-workspace" });
    await recoverLocalAppliesAtStartup(f.input);
    foreign.mockRestore();
    expect(f.dispatches).toBe(0);
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("running");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("receipt-only capability retains custody across deletion and never falls through on scope drift", async () => {
  const f = await fixture();
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw new Error("normal transport sentinel"); }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await f.stateStore.commit(f.receipt);
    for (const runner of [f.runner, createLocalOpenTofuRunner({ archiveStore: f.archiveStore, stateStore: f.stateStore })]) {
      await expect(withCommittedLocalApplyRecovery(runner, { runId: f.run.id, stateScope: f.job.stateScope! }, async () => {
        const read = spyOn(f.stateStore, "read").mockResolvedValue(undefined);
        try {
          const result = await runner.apply!(f.job);
          expect(result.stateDigest).toBe(f.receipt.stateDigest);
          await expect(runner.apply!({ ...f.job, stateScope: { ...f.job.stateScope!, generation: 2 } })).rejects.toThrow();
          await expect(runner.apply!({ ...f.job, applyRun: { ...f.run, id: "different-run" } })).rejects.toThrow();
        } finally { read.mockRestore(); }
      })).resolves.toBe(true);
    }
    expect(transport).not.toHaveBeenCalled();
    // Other mutation actions are not accepted by this Apply-only capability.
    await withCommittedLocalApplyRecovery(f.runner, { runId: f.run.id, stateScope: f.job.stateScope! }, async () => {
      await expect(f.runner.destroy!({ ...f.job, applyRun: { ...f.run, operation: "destroy" } })).rejects.toThrow();
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = withCommittedLocalApplyRecovery(f.runner, { runId: f.run.id, stateScope: f.job.stateScope! }, async () => {
      entered();
      await gate;
      expect((await f.runner.apply!(f.job)).stateDigest).toBe(f.receipt.stateDigest);
    });
    await ready;
    // A different async call on the SAME adapter retains its ordinary path.
    const read = spyOn(f.stateStore, "read").mockResolvedValue(undefined);
    try {
      await expect(f.runner.apply!({ ...f.job, applyRun: { ...f.run, id: "normal-concurrent-run" } })).rejects.toThrow("local runner mutation custody mode mismatch");
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); release(); await held; }
  } finally { transport.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
});

test("ordinary Node startup wires a nonblocking second pass after the unchanged heartbeat window", async () => {
  const f = await fixture();
  const listRecoverable = f.controller.listRecoverableOpenTofuRuns.bind(f.controller);
  let firstQueryFinished!: () => void;
  const firstQuery = new Promise<void>(resolve => { firstQueryFinished = resolve; });
  let queries = 0;
  const query = spyOn(f.controller, "listRecoverableOpenTofuRuns").mockImplementation(async (options) => {
    const rows = await listRecoverable(options);
    if (++queries === 1) firstQueryFinished();
    return rows;
  });
  let dispatchFinished!: () => void;
  const dispatched = new Promise<void>(resolve => { dispatchFinished = resolve; });
  const dispatchQueuedRun = f.input.operations.dispatchQueuedRun;
  let callback: (() => void) | undefined;
  const realSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === RUN_HEARTBEAT_STALE_MS + 1_000) { callback = fn; return { unref() {} } as unknown as ReturnType<typeof setTimeout>; }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  const clock = spyOn(Date, "now");
  let started: ReturnType<typeof startLocalApplyStartupRecovery> | undefined;
  let signalDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.stateStore.commit(f.receipt);
    const boot = Date.now();
    await f.store.putApplyRun({ ...f.run, heartbeatAt: boot - 1 });
    started = startLocalApplyStartupRecovery({ ...f.input, startedAt: boot, log: () => {}, operations: {
      ...f.input.operations,
      dispatchQueuedRun: async (...args) => {
        try { await dispatchQueuedRun(...args); }
        finally { dispatchFinished(); }
      },
    } });
    // Fail within Bun's existing 5 s test budget if either observation never
    // arrives, so finally can restore the global clock and timer spies.
    const missingSignal = new Promise<never>((_, reject) => {
      signalDeadline = realSetTimeout(() => reject(new Error("startup recovery signal did not complete")), 3_000);
    });
    // Observe the first real sweep before the event-loop turn that clears its
    // active guard. The fresh owner must still be untouched at that point.
    await Promise.race([firstQuery, missingSignal]);
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(f.dispatches).toBe(0);
    expect(callback).toBeDefined();
    clock.mockReturnValue(boot + RUN_HEARTBEAT_STALE_MS + 1_001);
    callback!();
    await Promise.race([dispatched, missingSignal]);
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("succeeded");
    expect(f.dispatches).toBe(1);
    const server = await readFile(new URL("../../../../deploy/node-postgres/src/server.ts", import.meta.url), "utf8");
    expect(server).toContain("startLocalApplyStartupRecovery({");
    expect(server).not.toContain("runnerProfiles: overrides.runnerProfiles");
    expect(server).toContain("opentofuRunnerExecutors: runnerExecutors");
    expect(server.indexOf("startLocalApplyStartupRecovery({")).toBeLessThan(server.indexOf("await serveOnAnyRuntime("));
  } finally { if (signalDeadline) clearTimeout(signalDeadline); started?.stop(); clock.mockRestore(); timer.mockRestore(); query.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
});

test("startup advances the existing sweep cursor past non-Apply work without dispatching it", async () => {
  const f = await fixture();
  try {
    await f.stateStore.commit(f.receipt);
    const plan = await f.store.getPlanRun(f.run.planRunId);
    if (!plan) throw new Error("missing fixture Plan");
    for (let i = 0; i < 25; i++) {
      await f.store.putPlanRun({ ...plan, id: `plan_other_${i}`, status: "running", createdAt: 1, heartbeatAt: f.run.heartbeatAt });
      await f.store.putApplyRun({ ...f.run, id: `apply_queued_${i}`, status: "queued", createdAt: 1 });
    }
    await recoverLocalAppliesAtStartup(f.input);
    expect(f.dispatches).toBe(0);
    await recoverLocalAppliesAtStartup(f.input);
    expect(f.dispatches).toBe(1);
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("succeeded");
    expect((await f.store.getPlanRun("plan_other_0"))?.status).toBe("running");
    expect((await f.store.getApplyRun("apply_queued_0"))?.status).toBe("queued");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("startup never protects one adapter while Core selects a different configured executor", async () => {
  const f = await fixture();
  try {
    await f.stateStore.commit(f.receipt);
    let ordinaryApplyCalls = 0;
    const ordinary = {
      plan: async () => { throw new Error("not a planning case"); },
      apply: async () => { ordinaryApplyCalls++; throw new Error("unprotected normal Apply sentinel"); },
    };
    const executors = new Map([["persisted-shadow", f.runner]]);
    const controller = new OpenTofuController({ store: f.store, runner: ordinary,
      runnerExecutors: executors, runnerProfiles: [f.profile], defaultRunnerProfileId: f.profile.id,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(), executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    });
    await controller.listRunnerProfiles();
    await f.store.putRunnerProfile({ ...f.profile, executorId: "persisted-shadow" });
    let dispatches = 0;
    const input = { ...f.input, runner: ordinary, executors, profiles: [f.profile],
      operations: { controller, dispatchQueuedRun: async (...args: Parameters<typeof controller.dispatchQueuedRun>) => {
        dispatches++;
        await controller.dispatchQueuedRun(...args);
      } } };
    await recoverLocalAppliesAtStartup(input);
    expect(dispatches).toBe(0);
    expect(ordinaryApplyCalls).toBe(0);
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("running");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("startup adopts persisted provider failure without credential or Runner dispatch", async () => {
  const f = await fixture();
  const receipt = { ...f.receipt, result: {
    stateDigest: f.receipt.stateDigest,
    providerExecutionFailure: { kind: "provider_execution_failed" as const, statePersistence: "persisted" as const, errorCode: "provider_fixture_failed" },
    executionEvidence: fixtureExecutionEvidence(f.job, "apply", { outcome: "provider_failed_state_persisted" }),
  } };
  await f.stateStore.commit(receipt);
  const environment = spyOn(RunEnvResolver.prototype, "resolveRunEnvironment");
  const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
  const renew = spyOn(RunCredentialBroker.prototype, "renewRunCredential");
  const apply = spyOn(f.runner, "apply");
  const rawOutput = spyOn(f.stateStore, "commitRawOutput");
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw new Error("no Runner HTTP for persisted failure"); }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await recoverLocalAppliesAtStartup(f.input);
    const failed = await f.store.getApplyRun(f.run.id);
    const capsule = await f.store.getCapsule(f.run.capsuleId!);
    expect(failed?.status).toBe("failed");
    expect(failed?.id).toBe(f.run.id);
    expect(failed?.planRunId).toBe(f.run.planRunId);
    expect(failed?.executionEvidence?.outcome).toBe("provider_failed_state_persisted");
    expect(failed?.diagnostics?.some(d => d.code === "provider_fixture_failed")).toBe(true);
    expect(failed?.outputId).toBeUndefined();
    expect(capsule?.status).toBe("error");
    expect(capsule?.currentStateGeneration).toBe(1);
    expect(capsule?.currentStateVersionId).toBe(failed?.stateVersionId);
    expect(capsule?.currentOutputId).toBeUndefined();
    expect((await f.store.getPlanRun(f.run.planRunId))?.appliedApplyRunId).toBe(f.run.id);
    const terminal = JSON.stringify(failed);
    await recoverLocalAppliesAtStartup(f.input);
    expect(JSON.stringify(await f.store.getApplyRun(f.run.id))).toBe(terminal);
    expect(await f.stateStore.read(receipt.stateRef)).toEqual(receipt);
    expect(f.dispatches).toBe(1);
    expect(environment.mock.calls.length).toBeGreaterThan(0);
    expect(environment.mock.calls.every(([input]) => input.mintCredentials === false)).toBe(true);
    for (const call of [mint, renew, apply, rawOutput, transport]) expect(call).not.toHaveBeenCalled();
  } finally {
    for (const call of [environment, mint, renew, apply, rawOutput, transport]) call.mockRestore();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("startup success receipt still confirms raw output without credential or Runner dispatch", async () => {
  const f = await fixture();
  await f.stateStore.commit(f.receipt);
  const environment = spyOn(RunEnvResolver.prototype, "resolveRunEnvironment");
  const apply = spyOn(f.runner, "apply");
  const rawOutput = spyOn(f.stateStore, "commitRawOutput");
  try {
    await recoverLocalAppliesAtStartup(f.input);
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("succeeded");
    expect(rawOutput).toHaveBeenCalledTimes(1);
    expect(environment.mock.calls.length).toBeGreaterThan(0);
    expect(environment.mock.calls.every(([input]) => input.mintCredentials === false)).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  } finally { environment.mockRestore(); apply.mockRestore(); rawOutput.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
});


test("startup mismatched receipts stay running without claiming or minting", async () => {
  const cases = ["run", "workspace", "capsule", "environment", "generation", "plan", "profile", "authority", "outcome", "persistence", "missing-evidence", "commit"] as const;
  for (const kind of cases) {
    const f = await fixture();
    const evidence = fixtureExecutionEvidence(f.job, "apply", { outcome: "provider_failed_state_persisted" });
    let result: OpenTofuApplyResult = { stateDigest: f.receipt.stateDigest,
      providerExecutionFailure: { kind: "provider_execution_failed", statePersistence: "persisted" }, executionEvidence: evidence };
    if (kind === "plan") result = { ...result, executionEvidence: { ...evidence, planRunId: "foreign-plan" } };
    if (kind === "profile") result = { ...result, executionEvidence: { ...evidence, authority: { ...evidence.authority, runnerProfileId: "foreign-profile" } } };
    if (kind === "authority") result = { ...result, executionEvidence: { ...evidence, authority: { ...evidence.authority, controllerArtifact: { ...evidence.authority.controllerArtifact, digest: `sha256:${"b".repeat(64)}` } } } };
    if (kind === "outcome") result = { ...result, executionEvidence: { ...evidence, outcome: "committed" } };
    if (kind === "persistence") result = { ...result, providerExecutionFailure: { kind: "provider_execution_failed", statePersistence: "unavailable" } };
    if (kind === "missing-evidence") result = { ...result, executionEvidence: undefined };
    if (kind === "commit") result = { ...result, executionEvidence: { ...evidence, commit: { stateVersionId: "foreign-state" } } };
    const receipt: LocalOpenTofuStateArtifact = { ...f.receipt, result,
      ...(kind === "run" ? { createdByRunId: "foreign-run" } : {}),
      ...(kind === "workspace" ? { workspaceId: "foreign-workspace" } : {}),
      ...(kind === "capsule" ? { subject: { kind: "capsule" as const, id: "foreign-capsule" } } : {}),
      ...(kind === "environment" ? { environment: "foreign-environment" } : {}),
      ...(kind === "generation" ? { generation: 2 } : {}),
    };
    await f.stateStore.commit(receipt);
    const before = JSON.stringify([await f.store.getApplyRun(f.run.id), await f.store.getCapsule(f.run.capsuleId!), await f.store.getPlanRun(f.run.planRunId), await f.store.getPlanRunInputs(f.run.planRunId)]);
    const claim = spyOn(f.store, "transitionRun");
    const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
    const renew = spyOn(RunCredentialBroker.prototype, "renewRunCredential");
    const apply = spyOn(f.runner, "apply");
    try {
      await recoverLocalAppliesAtStartup(f.input);
      expect(JSON.stringify([await f.store.getApplyRun(f.run.id), await f.store.getCapsule(f.run.capsuleId!), await f.store.getPlanRun(f.run.planRunId), await f.store.getPlanRunInputs(f.run.planRunId)])).toBe(before);
      for (const call of [claim, mint, renew, apply]) expect(call).not.toHaveBeenCalled();
    } finally {
      for (const call of [claim, mint, renew, apply]) call.mockRestore();
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("receipt commands cannot authorize another action, target or changed admission", async () => {
  const f = await fixture();
  await f.stateStore.commit(f.receipt);
  const claim = spyOn(f.store, "transitionRun");
  const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
  const apply = spyOn(f.runner, "apply");
  try {
    await withCommittedLocalApplyRecovery(f.runner, { runId: f.run.id, stateScope: f.job.stateScope! }, async (committedApplyReceipt) => {
      const control = { committedApplyReceipt };
      for (const action of ["plan", "source_sync", "restore"] as const) {
        await expect(f.controller.dispatchQueuedRun({ action, runId: f.run.planRunId, workspaceId: f.run.workspaceId }, control)).rejects.toThrow();
      }
      await expect(f.controller.dispatchQueuedRun({ action: "apply", runId: f.run.id, workspaceId: "foreign-workspace" }, control)).rejects.toThrow();
      await expect(f.controller.dispatchQueuedRun({ action: "apply", runId: f.run.id, workspaceId: f.run.workspaceId }, { committedApplyReceipt: {} } as RunDispatchControl)).rejects.toThrow();
      const inputs = await f.store.getPlanRunInputs(f.run.planRunId);
      if (!inputs) throw new Error("missing fixture inputs");
      const missing = spyOn(f.store, "getPlanRunInputs").mockResolvedValue(undefined);
      await expect(f.controller.dispatchQueuedRun({ action: "apply", runId: f.run.id, workspaceId: f.run.workspaceId }, control)).rejects.toThrow();
      missing.mockRestore();
      const epoch = spyOn(f.store, "getCapsuleExecutionAuthorityEpoch").mockResolvedValue(2);
      await expect(f.controller.dispatchQueuedRun({ action: "apply", runId: f.run.id, workspaceId: f.run.workspaceId }, control)).rejects.toThrow();
      epoch.mockRestore();
      const management = spyOn(f.store, "getRunManagementAuthority").mockResolvedValue(undefined);
      await expect(f.controller.dispatchQueuedRun({ action: "apply", runId: f.run.id, workspaceId: f.run.workspaceId }, control)).rejects.toThrow();
      management.mockRestore();
    });
    expect(await f.store.getApplyRun(f.run.id)).toEqual(f.run);
    for (const call of [claim, mint, apply]) expect(call).not.toHaveBeenCalled();
  } finally { claim.mockRestore(); mint.mockRestore(); apply.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
});


test("startup preserves successful update receipts with the verified prior state", async () => {
  const f = await fixture();
  try {
    await f.stateStore.commit(f.receipt);
    await recoverLocalAppliesAtStartup(f.input);
    const { planRun } = await f.planning.createCapsulePlan(f.run.capsuleId!);
    expect(planRun.operation).toBe("update");
    expect(planRun.baseStateGeneration).toBe(1);
    const { applyRun: queued } = await f.controller.createApplyRun({ planRunId: planRun.id, expected: applyExpectedGuardFromPlanRun(planRun) });
    const heartbeatAt = Date.now() - RUN_HEARTBEAT_STALE_MS - 2_000;
    const run = { ...queued, status: "running" as const, startedAt: heartbeatAt, heartbeatAt };
    await f.store.putApplyRun(run);
    const stateScope = { ...f.receipt, generation: 2, stateRef: new ObjectKeyArtifactReferenceAllocator().allocate({
      kind: "state", workspaceId: run.workspaceId, subject: f.receipt.subject,
      environment: f.receipt.environment, generation: 2, storageRoot: await f.store.getCapsuleStorageRoot(run.capsuleId!),
    }) };
    const job: OpenTofuApplyJob = { ...f.job, applyRun: run, planRun, planArtifact: planRun.planArtifact!, stateScope,
      executionEvidenceCommit: {
        stateVersionId: `state_${(await stableJsonDigest({ kind: "takosumi.state-version-id@v1", applyRunId: run.id })).slice(7)}`,
        outputId: `out_${(await stableJsonDigest({ kind: "takosumi.output-id@v1", applyRunId: run.id })).slice(7)}`,
      } };
    await f.stateStore.commit({ ...f.receipt, stateRef: stateScope.stateRef, generation: 2, createdByRunId: run.id,
      result: { stateDigest: f.receipt.stateDigest, outputs: {}, executionEvidence: fixtureExecutionEvidence(job, "apply") } });
    const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
    const apply = spyOn(f.runner, "apply");
    try {
      await recoverLocalAppliesAtStartup({ ...f.input, startedAt: Date.now() });
      expect((await f.store.getApplyRun(run.id))?.status).toBe("succeeded");
      expect((await f.store.getCapsule(run.capsuleId!))?.currentStateGeneration).toBe(2);
      expect((await f.store.getApplyRun(run.id))?.startedAt).toBe(heartbeatAt);
      expect(mint).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    } finally { mint.mockRestore(); apply.mockRestore(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("receipt recovery preserves the original evidence and respects a competing winner or lost commit ACK", async () => {
  for (const mode of ["winner", "ack-lost", "late-read"] as const) {
    const f = await fixture();
    const original = { ...f.run, runEnvironmentEvidenceDigest: DIGEST };
    await f.store.putApplyRun(original);
    await f.stateStore.commit({ ...f.receipt, result: { stateDigest: f.receipt.stateDigest,
      providerExecutionFailure: { kind: "provider_execution_failed", statePersistence: "persisted" },
      executionEvidence: fixtureExecutionEvidence(f.job, "apply", { outcome: "provider_failed_state_persisted" }) } });
    const transition = f.store.transitionRun.bind(f.store);
    const commit = f.store.commitRunState.bind(f.store);
    const resolve = RunEnvResolver.prototype.resolveRunEnvironment;
    let observations = 0;
    const claim = spyOn(f.store, "transitionRun").mockImplementation(async input => {
      if (mode === "winner" && input.setLeaseToken) {
        await f.store.putApplyRun({ ...original, status: "cancelled", finishedAt: Date.now() });
      }
      return await transition(input);
    });
    const tail = spyOn(f.store, "commitRunState").mockImplementation(async input => {
      const result = await commit(input);
      if (mode === "ack-lost") throw new Error("synthetic committed ACK loss");
      return result;
    });
    const read = spyOn(RunEnvResolver.prototype, "resolveRunEnvironment").mockImplementation(async function(this: RunEnvResolver, input) {
      observations++;
      if (mode === "late-read" && observations === 2) throw new Error("synthetic post-claim read refusal");
      return await resolve.call(this, input);
    });
    const mint = spyOn(RunCredentialBroker.prototype, "mintRunCredentials");
    const apply = spyOn(f.runner, "apply");
    try {
      await recoverLocalAppliesAtStartup(f.input);
      const run = await f.store.getApplyRun(f.run.id);
      const capsule = await f.store.getCapsule(f.run.capsuleId!);
      expect(run?.status).toBe(mode === "winner" ? "cancelled" : mode === "late-read" ? "running" : "failed");
      expect(run?.runEnvironmentEvidenceDigest).toBe(DIGEST);
      expect(run?.startedAt).toBe(original.startedAt);
      expect(capsule?.currentStateGeneration).toBe(mode === "ack-lost" ? 1 : 0);
      expect(capsule?.currentOutputId).toBeUndefined();
      expect(run?.outputId).toBeUndefined();
      expect(run?.auditEvents.filter(e => e.type === "apply.started").length).toBe(original.auditEvents.filter(e => e.type === "apply.started").length);
      if (mode === "ack-lost") expect(run?.executionEvidence?.outcome).toBe("provider_failed_state_persisted");
      else expect(tail).not.toHaveBeenCalled();
      expect(read.mock.calls.every(([input]) => input.mintCredentials === false)).toBe(true);
      expect(mint).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    } finally {
      for (const call of [claim, tail, read, mint, apply]) call.mockRestore();
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
