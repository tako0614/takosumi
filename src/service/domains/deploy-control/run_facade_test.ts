import { expect, test } from "bun:test";

import {
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import { seedInstallationModel } from "./test_model_fixture.ts";

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
  });
  const request = await seedUpdatableInstallation(store, {
    installationId: "inst_applied",
  });
  const { planRun } = await controller.createPlanRun(request);
  const planView = await controller.getRun(planRun.id);
  expect(planView.status).toBe("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedFrom(planRun),
  });
  const applyView = await controller.getRun(applyRun.id);
  expect(applyView.type).toBe("apply");
  expect(applyView.status).toBe("succeeded");
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

// Reconstruct the expected guard the apply needs from the reviewed plan.
function applyExpectedFrom(planRun: {
  readonly id: string;
  readonly installationId?: string;
  readonly installationCurrentDeploymentId?: string | null;
  readonly runnerProfileId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest?: string;
}) {
  return {
    planRunId: planRun.id,
    ...(planRun.installationId
      ? { installationId: planRun.installationId }
      : {}),
    ...(planRun.installationId
      ? { currentDeploymentId: planRun.installationCurrentDeploymentId ?? null }
      : {}),
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest!,
    planArtifactDigest: PLAN_DIGEST,
  };
}
