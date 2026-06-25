import { expect, test } from "bun:test";

import {
  applyExpectedGuardFromPlanRun,
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedInstallationModel,
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
 * Seeds the Space-direct Installation model (spec §5) and returns a plan-run
 * request for an UPDATE against the seeded Installation. The Installation is
 * seeded WITH a current deployment so the apply-expected guard is well-formed
 * (an `update` PlanRun carries `installationCurrentDeploymentId`).
 */
async function seedUpdatableInstallation(
  store: InMemoryOpenTofuDeploymentStore,
  ids: { installationId: string },
) {
  const { installation } = await seedInstallationModel(store, {
    installationId: ids.installationId,
  });
  await seedProviderConnections(store, installation);
  // A current deployment so the update plan carries a defined current-deployment
  // guard (a fresh installation has no prior deployment to guard against).
  await store.putInstallation({
    ...installation,
    currentDeploymentId: `dep_seed_${ids.installationId}`,
    status: "active",
  });
  return {
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update" as const,
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  };
}

test("getRun projects a queued plan run as the unified Run", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: () => 1,
    newId: deterministicIds(),
  });
  const request = await seedUpdatableInstallation(store, {
    installationId: "inst_queued",
  });
  const { planRun } = await controller.createPlanRun(request);
  const run = await controller.getRun(planRun.id);
  expect(run.id).toBe(planRun.id);
  expect(run.type).toBe("plan");
  expect(run.status).toBe("queued");
  expect(run.policyStatus).toBe("pass");
  expect(run.createdBy).toBe("system");
});

test("getRun projects a succeeded plan + its apply run", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: succeedingRunner(),
    vault: fakeProviderVault() as never,
  });
  const request = await seedUpdatableInstallation(store, {
    installationId: "inst_applied",
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
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: sequenceNow(1000),
    newId: deterministicIds(),
    runner: succeedingRunner(),
    vault: fakeProviderVault() as never,
  });
  const request = await seedUpdatableInstallation(store, {
    installationId: "inst_list",
  });
  const { planRun } = await controller.createPlanRun(request);
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  await store.putCompatibilityCheckRun({
    id: "ccr_list",
    spaceId: request.spaceId,
    sourceId: "src_list",
    type: "compatibility_check",
    status: "succeeded",
    createdBy: "system",
    createdAt: "2026-06-07T00:00:00.000Z",
  });

  const runs = await controller.listRuns(request.spaceId);
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
  expect(runs.every((run) => run.spaceId === request.spaceId)).toBe(true);
});

test("getRun returns a source-scoped compatibility_check run", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putCompatibilityCheckRun({
    id: "ccr_1",
    spaceId: "space_1",
    sourceId: "src_1",
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: "snap_1",
    compatibilityReportId: "caprep_1",
    errorCode: "OpenTofu runner rejected compatibility_check run ccr_1",
    createdBy: "system",
    createdAt: "2026-06-07T00:00:00.000Z",
    startedAt: "2026-06-07T00:00:00.000Z",
    finishedAt: "2026-06-07T00:00:01.000Z",
  });
  const controller = new OpenTofuDeploymentController({ store });

  expect(await controller.getRun("ccr_1")).toMatchObject({
    id: "ccr_1",
    spaceId: "space_1",
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
        message: "OpenTofu runner rejected compatibility_check run ccr_1",
      },
    ],
    auditEvents: [],
  });
});

test("getRun throws not_found for an unknown id", async () => {
  const controller = new OpenTofuDeploymentController({ now: () => 1 });
  await expect(controller.getRun("plan_missing")).rejects.toBeInstanceOf(
    OpenTofuControllerError,
  );
});

test("cancelRun cancels a queued plan run and is rejected once running/terminal", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: () => 1,
    newId: deterministicIds(),
  });
  const request = await seedUpdatableInstallation(store, {
    installationId: "inst_cancel",
  });
  const { planRun } = await controller.createPlanRun(request);
  const cancelled = await controller.cancelRun(planRun.id);
  expect(cancelled.status).toBe("cancelled");

  // A second cancel of the now-terminal run is rejected.
  await expect(controller.cancelRun(planRun.id)).rejects.toMatchObject({
    code: "failed_precondition",
  });
});
