import { expect, test } from "bun:test";

import {
  applyExpectedGuardFromPlanRun,
  OpenTofuControllerError,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}

function succeedingRunner() {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local" as const,
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: () => Promise.resolve({}),
  };
}

/**
 * Seeds the Workspace-direct Capsule model (spec §5) and returns a plan-run
 * request for an UPDATE against the seeded Capsule. The Capsule is
 * seeded WITH a current StateVersion pointer so the apply-expected guard is well-formed
 * (an `update` PlanRun carries `capsuleCurrentStateVersionId`).
 */
async function seedUpdatableCapsule(
  store: InMemoryOpenTofuControlStore,
  ids: { capsuleId: string },
) {
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "ws_test001",
    capsuleId: ids.capsuleId,
  });
  await seedProviderConnections(store, capsule);
  // A current StateVersion pointer so the update plan carries a defined guard
  // (a fresh Capsule has no prior StateVersion to guard against).
  await store.putCapsule({
    ...capsule,
    currentStateVersionId: `state_seed_${ids.capsuleId}`,
    status: "active",
  });
  return {
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "update" as const,
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  };
}

test("getRun projects a queued plan run as the unified Run", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    now: () => 1,
    newId: deterministicIds(),
  });
  const request = await seedUpdatableCapsule(store, {
    capsuleId: "cap_queued01",
  });
  const { planRun } = await controller.createPlanRun(request);
  const run = await controller.getRun(planRun.id);
  expect(run.id).toBe(planRun.id);
  expect(run.type).toBe("plan");
  expect(run.status).toBe("queued");
  expect(run.policyStatus).toBe("pass");
  expect(run.createdBy).toBe("system");
});

test("createPlanRun rejects a create operation against a Capsule that already has state", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    now: () => 1,
    newId: deterministicIds(),
  });
  const request = await seedUpdatableCapsule(store, {
    capsuleId: "cap_mislabel",
  });

  // The apply authorization re-reads the STORED operation, so a `create` label
  // on a deployed Capsule would let a principal scoped to `create` alone plan
  // and apply a new StateVersion over it.
  await expect(
    controller.createPlanRun({ ...request, operation: "create" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("getRun projects a succeeded plan + its apply run", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: succeedingRunner(),
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const request = await seedUpdatableCapsule(store, {
    capsuleId: "cap_applied1",
  });
  const { planRun } = await controller.createPlanRun(request);
  const planView = await controller.getRun(planRun.id);
  expect(planView.status).toBe("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const applyView = await controller.getRun(applyRun.id);
  expect(applyView.type).toBe("apply");
  expect(applyView.status).toBe("succeeded");
});

test("listRuns returns unified Workspace Runs newest first", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    now: sequenceNow(1000),
    newId: deterministicIds(),
    runner: succeedingRunner(),
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const request = await seedUpdatableCapsule(store, {
    capsuleId: "cap_list0001",
  });
  const { planRun } = await controller.createPlanRun(request);
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  await store.putCompatibilityCheckRun({
    id: "ccr_list",
    workspaceId: request.workspaceId,
    sourceId: "src_list",
    type: "compatibility_check",
    status: "succeeded",
    createdBy: "system",
    createdAt: "2026-06-07T00:00:00.000Z",
  });

  const runs = await controller.listRuns(request.workspaceId);
  expect(runs.map((run) => run.id)).toEqual([
    "ccr_list",
    applyRun.id,
    planRun.id,
  ]);
  expect(runs.map((run) => run.type)).toEqual([
    "compatibility_check",
    "apply",
    "plan",
  ]);
  expect(runs.every((run) => run.workspaceId === request.workspaceId)).toBe(
    true,
  );
});

test("getRun returns a source-scoped compatibility_check run", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putCompatibilityCheckRun({
    id: "ccr_1",
    workspaceId: "ws_source1",
    sourceId: "src_1",
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: "snap_1",
    compatibilityReportId: "caprep_1",
    errorCode: "capsule_compatibility_check_failed",
    createdBy: "system",
    createdAt: "2026-06-07T00:00:00.000Z",
    startedAt: "2026-06-07T00:00:00.000Z",
    finishedAt: "2026-06-07T00:00:01.000Z",
  });
  const controller = new OpenTofuController({ store });

  expect(await controller.getRun("ccr_1")).toMatchObject({
    id: "ccr_1",
    workspaceId: "ws_source1",
    sourceId: "src_1",
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: "snap_1",
    compatibilityReportId: "caprep_1",
  });
  await expect(controller.getRunLogs("ccr_1")).resolves.toEqual({
    diagnostics: [
      {
        severity: "error",
        code: "capsule_compatibility_check_failed",
        message: "capsule_compatibility_check_failed",
      },
    ],
    auditEvents: [],
  });
});

test("getRun throws not_found for an unknown id", async () => {
  const controller = new OpenTofuController({ now: () => 1 });
  await expect(controller.getRun("plan_missing")).rejects.toBeInstanceOf(
    OpenTofuControllerError,
  );
});

test("cancelRun cancels a queued plan run and is rejected once running/terminal", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = new OpenTofuController({
    store,
    now: () => 1,
    newId: deterministicIds(),
  });
  const request = await seedUpdatableCapsule(store, {
    capsuleId: "cap_cancel01",
  });
  const { planRun } = await controller.createPlanRun(request);
  const cancelled = await controller.cancelRun(planRun.id);
  expect(cancelled.status).toBe("cancelled");

  // A second cancel of the now-terminal run is rejected.
  await expect(controller.cancelRun(planRun.id)).rejects.toMatchObject({
    code: "failed_precondition",
  });
});
