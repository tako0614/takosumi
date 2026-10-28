/** Retirement guards for persisted dependency rows and old PlanRun pins. */
import { expect, spyOn, test } from "bun:test";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuController,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fakeProviderVault,
  fixtureExecutionEvidence,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const PLAN_DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function ids() {
  let next = 1;
  return (prefix: string) => `${prefix}_${String(next++).padStart(8, "0")}`;
}

function fixture(legacyDependencyConsumerCapsuleIds: readonly string[] = [], withCompatibilityService = false) {
  const store = new InMemoryOpenTofuControlStore({ legacyDependencyConsumerCapsuleIds });
  const jobs: OpenTofuPlanJob[] = [];
  let compatibilityReads = 0;
  const sourcesService = withCompatibilityService ? new SourcesService({
    store,
    readCapsuleSourceFiles: async () => { compatibilityReads++; return []; },
    newId: ids(),
    now: () => new Date("2026-10-28T00:00:00.000Z"),
  }) : undefined;
  const runner: OpenTofuRunner = {
    plan: async (job) => {
      jobs.push(job);
      return {
        planDigest: PLAN_DIGEST,
        planArtifact: { kind: "runner-local", ref: "runner-local://plan/test", digest: PLAN_DIGEST },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      };
    },
    apply: async (job) => ({
      outputs: { value: { sensitive: false, value: "updated.example.com" } } as never,
      stateDigest: PLAN_DIGEST,
      rawOutputRef: job.rawOutputRef,
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      executionEvidence: fixtureExecutionEvidence(job, "apply"),
    }),
    destroy: async () => ({}),
  };
  const controller = new OpenTofuController({
    store,
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    now: (() => { let t = 1; return () => t++; })(),
    newId: ids(),
  });
  return { store, controller, jobs, compatibilityReads: () => compatibilityReads };
}

async function seed(store: InMemoryOpenTofuControlStore, name: string) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_test001",
    environment: "preview",
    sourceId: `src_${name}`,
    snapshotId: `snap_${name}`,
    installConfigId: `cfg_${name}`,
    capsuleId: `cap_${name}`,
    name,
  });
  await seedProviderConnections(store, seeded.capsule);
  return seeded.capsule;
}

test("a retained consumer dependency refuses both plan and destroy plan", async () => {
  const { store, controller, jobs } = fixture(["cap_consumer"]);
  await seed(store, "producer");
  await seed(store, "consumer");
  for (const destroy of [false, true]) {
    await expect(controller.createCapsulePlan("cap_consumer", {}, { destroy })).rejects.toMatchObject({
      code: "dependency_retired",
      message: expect.stringContaining("operator data maintenance is required"),
      details: { reason: "dependency_retired" },
    });
  }
  expect(jobs).toHaveLength(0);
  const independent = await controller.createCapsulePlan("cap_producer");
  expect(independent.planRun.dependencySnapshotId).toBeUndefined();
  expect(jobs).toHaveLength(1);
});

test("retired consumers refuse before configuration, compatibility checks, or Run creation", async () => {
  const { store, controller, jobs, compatibilityReads } = fixture(["cap_consumer"], true);
  await seed(store, "consumer");
  const configurationRead = spyOn(store, "getInstallConfig");
  const before = await store.listRunsByWorkspace("ws_test001");
  try {
    for (const create of [
      () => controller.createCapsulePlan("cap_consumer"),
      () => controller.createCapsuleDestroyPlan("cap_consumer"),
      () => controller.createCapsuleDriftCheck("cap_consumer"),
    ]) {
      await expect(create()).rejects.toMatchObject({ code: "dependency_retired" });
    }
    expect(configurationRead).not.toHaveBeenCalled();
    expect(compatibilityReads()).toBe(0);
    expect(jobs).toHaveLength(0);
    expect(await store.listRunsByWorkspace("ws_test001")).toEqual(before);
    expect((await store.getCapsule("cap_consumer"))?.compatibilityReportId).toBeUndefined();
  } finally {
    configurationRead.mockRestore();
  }
});

test("historical plan with dependencySnapshotId refuses request-time apply", async () => {
  const { store, controller } = fixture();
  await seed(store, "consumer");
  const plan = await controller.createCapsulePlan("cap_consumer");
  for (const snapshotId of ["depsnap_old", "", null]) {
    // Malformed persisted links must fail closed just like a valid old pin.
    await store.putPlanRun({ ...plan.planRun, dependencySnapshotId: snapshotId as string });
    await expect(controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    })).rejects.toMatchObject({ code: "dependency_retired", details: { reason: "dependency_retired" } });
  }
});

test("queued historical plan with dependencySnapshotId fails before runner dispatch", async () => {
  const { store, jobs } = fixture();
  await seed(store, "consumer");
  const controller = new OpenTofuController({
    store,
    runner: {
      plan: async (job) => { jobs.push(job); throw new Error("must not dispatch"); },
      apply: async () => ({}),
      destroy: async () => ({}),
    },
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    enqueueRun: async () => {},
    now: (() => { let t = 1; return () => t++; })(),
    newId: ids(),
  });
  const plan = await controller.createCapsulePlan("cap_consumer");
  await store.putPlanRun({ ...plan.planRun, dependencySnapshotId: "depsnap_old" });
  const failed = await controller.runQueuedPlan(plan.planRun.id);
  expect(failed.status).toBe("failed");
  expect(failed.diagnostics?.[0]?.message).toContain("dependency_retired");
  expect(jobs).toHaveLength(0);
});

test("producer output change does not mark a legacy consumer stale", async () => {
  const { store, controller } = fixture(["cap_consumer"]);
  await seed(store, "producer");
  const consumer = await seed(store, "consumer");
  await store.putCapsule({ ...consumer, status: "active" });
  const plan = await controller.createCapsulePlan("cap_producer");
  await controller.createApplyRun({
    planRunId: plan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(plan.planRun),
  });
  expect((await store.getCapsule("cap_consumer"))?.status).toBe("active");
});

test("direct createPlanRun also refuses a retained consumer dependency", async () => {
  const { store, controller } = fixture(["cap_consumer"]);
  const capsule = await seed(store, "consumer");
  const source = await store.getSource(capsule.sourceId!);
  expect(source).toBeDefined();
  await expect(controller.createPlanRun({
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "destroy",
    source: {
      kind: "git", url: source!.url, ref: source!.defaultRef,
      modulePath: source!.defaultPath,
    },
    requiredProviders: [],
    requiredProviderRequirements: [],
  })).rejects.toMatchObject({
    code: "dependency_retired",
    details: { reason: "dependency_retired" },
  });
});

test("an independent plan keeps the pre-retirement digest frame", async () => {
  const { store, controller } = fixture();
  await seed(store, "consumer");
  const plan = await controller.createCapsulePlan("cap_consumer");
  const inputs = await store.getPlanRunInputs(plan.planRun.id);
  const stored = await store.getPlanRun(plan.planRun.id);
  expect(inputs).toBeDefined();
  // Golden SHA-256 of the pre-retirement frame for this deterministic fixture:
  // { planRunInputs: inputs, dependencySnapshot: null }. Do not derive the
  // expectation with the production framing helper: dropping that null must fail.
  expect(stored?.executionInputsDigest).toBe("sha256:ecaaf961558c8533d703c1d12b2df7c5a808d59ce6291edbe218b103051cdbd9");
  expect(plan.planRun.status).toBe("succeeded");
  const applied = await controller.createApplyRun({
    planRunId: plan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(plan.planRun),
  });
  expect(applied.applyRun.status).toBe("succeeded");
});

class LateRetiredStore extends InMemoryOpenTofuControlStore {
  retired = false;
  override hasRetiredDependenciesForConsumer(capsuleId: string): Promise<boolean> {
    return this.retired && capsuleId === "cap_consumer"
      ? Promise.resolve(true)
      : super.hasRetiredDependenciesForConsumer(capsuleId);
  }
}

test("a dependency row appearing after planning blocks request-time apply", async () => {
  const store = new LateRetiredStore();
  const runner: OpenTofuRunner = {
    plan: async () => ({
      planDigest: PLAN_DIGEST,
      planArtifact: { kind: "runner-local", ref: "runner-local://plan/test", digest: PLAN_DIGEST },
      providerLockDigest: LOCK_DIGEST,
      requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
    }),
    apply: async () => ({}), destroy: async () => ({}),
  };
  const controller = new OpenTofuController({
    store, runner, vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    now: (() => { let t = 1; return () => t++; })(), newId: ids(),
  });
  await seed(store, "consumer");
  const plan = await controller.createCapsulePlan("cap_consumer");
  store.retired = true;
  await expect(controller.createApplyRun({
    planRunId: plan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(plan.planRun),
  })).rejects.toMatchObject({ code: "dependency_retired" });
});

test("a dependency row appearing after preparation blocks queued plan dispatch", async () => {
  const store = new LateRetiredStore();
  let dispatches = 0;
  const controller = new OpenTofuController({
    store,
    runner: {
      plan: async () => { dispatches++; throw new Error("must not dispatch"); },
      apply: async () => ({}), destroy: async () => ({}),
    },
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    enqueueRun: async () => {},
    now: (() => { let t = 1; return () => t++; })(), newId: ids(),
  });
  await seed(store, "consumer");
  const plan = await controller.createCapsulePlan("cap_consumer");
  store.retired = true;
  const failed = await controller.runQueuedPlan(plan.planRun.id);
  expect(failed.status).toBe("failed");
  expect(failed.diagnostics?.[0]?.message).toContain("dependency_retired");
  expect(dispatches).toBe(0);
});
