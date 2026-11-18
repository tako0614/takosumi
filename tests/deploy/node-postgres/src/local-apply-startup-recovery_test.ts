import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRunnerProfiles } from "../../../../core/domains/deploy-control/runner_profiles.ts";
import { OpenTofuController, RUN_HEARTBEAT_STALE_MS, applyExpectedGuardFromPlanRun, type OpenTofuApplyJob } from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { stableJsonDigest, sha256Digest } from "../../../../core/adapters/source/digest.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { seedCapsuleModel, FIXTURE_EXECUTION_EVIDENCE_AUTHORITY, fixtureExecutionEvidence } from "../../../helpers/deploy-control/model_fixture.ts";
import { createFileOpenTofuStateArtifactStore, createHttpOpenTofuRunner, createLocalOpenTofuRunner, withCommittedLocalApplyRecovery } from "../../../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { recoverLocalAppliesAtStartup, startLocalApplyStartupRecovery } from "../../../../deploy/node-postgres/src/local-apply-startup-recovery.ts";

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
  return { root, store, runner, profile, controller, stateStore, archiveStore, input, run, job, receipt, get dispatches() { return dispatches; } };
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
  let callback: (() => void) | undefined;
  const realSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === RUN_HEARTBEAT_STALE_MS + 1_000) { callback = fn; return { unref() {} } as unknown as ReturnType<typeof setTimeout>; }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  const clock = spyOn(Date, "now");
  try {
    await f.stateStore.commit(f.receipt);
    const boot = Date.now();
    await f.store.putApplyRun({ ...f.run, heartbeatAt: boot - 1 });
    const started = startLocalApplyStartupRecovery({ ...f.input, startedAt: boot, log: () => {} });
    // Flush the actual first query chain; it must skip the still-fresh owner.
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(f.dispatches).toBe(0);
    expect(callback).toBeDefined();
    clock.mockReturnValue(boot + RUN_HEARTBEAT_STALE_MS + 1_001);
    callback!();
    for (let i = 0; i < 100 && (await f.store.getApplyRun(f.run.id))?.status !== "succeeded"; i++) {
      await new Promise<void>(resolve => realSetTimeout(resolve, 1));
    }
    expect((await f.store.getApplyRun(f.run.id))?.status).toBe("succeeded");
    expect(f.dispatches).toBe(1);
    started.stop();
    const server = await readFile(new URL("../../../../deploy/node-postgres/src/server.ts", import.meta.url), "utf8");
    expect(server).toContain("startLocalApplyStartupRecovery({");
    expect(server).not.toContain("runnerProfiles: overrides.runnerProfiles");
    expect(server).toContain("opentofuRunnerExecutors: runnerExecutors");
    expect(server.indexOf("startLocalApplyStartupRecovery({")).toBeLessThan(server.indexOf("await serveOnAnyRuntime("));
  } finally { clock.mockRestore(); timer.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
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
