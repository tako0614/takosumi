/**
 * SECURITY S5 — create-plan apply-once is atomic across isolates.
 *
 * A `create` apply has no prior Deployment to guard against, so the
 * apply-once invariant (a succeeded plan applies AT MOST once) is the only
 * thing standing between two concurrent create-applies and a real duplicate
 * Installation + Deployment (duplicate cloud resources). The up-front
 * `appliedApplyRunId` check in `createApplyRun` is non-atomic: two cross-isolate
 * applies of the same plan both observe it undefined before either marks the
 * plan applied. The cross-isolate guard is the coordination lease:
 *   - a plan that DOES carry an installationId is covered by the
 *     `installation:{id}:{env}` lease (one write run per env at a time);
 *   - a `create` plan that carries NO installationId yet is covered by the
 *     `plan:{planRunId}` lease added for S5.
 *
 * In both cases the inner `#executeApply` re-reads the persisted PlanRun under
 * the lease and folds a sibling that already marked it applied into an
 * idempotent replay, so only ONE Deployment is ever recorded and the duplicate
 * apply does not poison the Capsule status.
 */

import { expect, test } from "bun:test";

import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InstallationLeaseBusyError,
  InMemoryInstallationCoordination,
  planLeaseScope,
} from "../../../../core/domains/deploy-control/installation_lease.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedInstallationModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";

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
 * Builds a controller over a freshly-seeded Installation (generation 0, NO
 * current deployment) plus a succeeded `create` PlanRun ready to apply. The
 * coordination seam is wired so the apply consumer takes the lease.
 */
async function seedCreatePlan(): Promise<{
  store: InMemoryOpenTofuDeploymentStore;
  coordination: InMemoryInstallationCoordination;
  controller: OpenTofuDeploymentController;
  planRun: PlanRun;
  installationId: string;
}> {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { installation } = await seedInstallationModel(store, {
    installationId: "inst_create",
  });
  // A fresh Installation: pending, no current deployment, generation 0 — the
  // shape a `create` apply lands its FIRST deployment on.
  await store.putInstallation({ ...installation, status: "pending" });
  await seedProviderConnections(store, installation);
  const coordination = new InMemoryInstallationCoordination();
  const controller = new OpenTofuDeploymentController({
    store,
    installationCoordination: coordination,
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: succeedingRunner(),
    vault: fakeProviderVault() as never,
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "create",
    source: SOURCE,
    requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
  });
  expect(planRun.status).toBe("succeeded");
  expect(planRun.operation).toBe("create");
  return {
    store,
    coordination,
    controller,
    planRun,
    installationId: installation.id,
  };
}

/** Seeds a queued ApplyRun against a succeeded PlanRun, bypassing the up-front
 *  `createApplyRun` apply-once check (to simulate the second isolate that
 *  already passed the non-atomic check before the first marked the plan
 *  applied). */
async function seedQueuedApply(
  store: InMemoryOpenTofuDeploymentStore,
  planRun: PlanRun,
  applyRunId: string,
): Promise<void> {
  const apply: ApplyRun = {
    id: applyRunId,
    planRunId: planRun.id,
    spaceId: planRun.spaceId,
    ...(planRun.installationId
      ? { installationId: planRun.installationId }
      : {}),
    operation: planRun.operation,
    runnerProfileId: planRun.runnerProfileId,
    status: "queued",
    expected: applyExpectedGuardFromPlanRun(planRun),
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putApplyRun(apply);
}

test("two applies of the same create plan: exactly one materializes, the other replays, only ONE deployment", async () => {
  const { store, controller, planRun, installationId } = await seedCreatePlan();

  // Two ApplyRuns both pass the non-atomic up-front check (modeled by seeding
  // them directly), as two cross-isolate consumers would.
  await seedQueuedApply(store, planRun, "apply_first");
  await seedQueuedApply(store, planRun, "apply_second");

  // First consumer acquires the lease, completes, marks the plan applied, and
  // records exactly one Deployment.
  const first = await controller.runQueuedApply("apply_first");
  expect(first.applyRun.status).toBe("succeeded");
  expect((await store.getPlanRun(planRun.id))?.appliedApplyRunId).toBe(
    "apply_first",
  );

  // Second consumer (redelivered after the first released the lease) re-reads
  // the now-applied plan under the lease and is folded into an idempotent
  // replay — it never allocates a second Deployment and it is not a failed run.
  const second = await controller.runQueuedApply("apply_second");
  expect(second.applyRun.status).toBe("succeeded");
  expect(second.applyRun.deploymentId).toBe(first.applyRun.deploymentId);
  expect(second.applyRun.auditEvents.map((event) => event.type)).toContain(
    "apply.idempotent_replay",
  );

  const deployments = await store.listDeployments(installationId);
  expect(deployments.length).toBe(1);
});

test("createApplyRun returns the existing apply response after a plan has already applied", async () => {
  const { store, controller, planRun, installationId } = await seedCreatePlan();

  const first = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(first.applyRun.status).toBe("succeeded");

  const replay = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(replay.applyRun.id).toBe(first.applyRun.id);
  expect(replay.applyRun.status).toBe("succeeded");
  expect(replay.deployment?.id).toBe(first.deployment?.id);

  const deployments = await store.listDeployments(installationId);
  expect(deployments.length).toBe(1);
});

test("a create plan with NO installationId is covered by the plan:{planRunId} lease", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  // A `create` PlanRun carrying NO installationId (the S5 case): seed the run
  // ledger rows directly and a SourceSnapshot the apply would dispatch against.
  await seedInstallationModel(store, { installationId: "inst_unused" });
  const planRun: PlanRun = {
    id: "plan_create_noinst",
    spaceId: "space_test",
    source: { kind: "git", url: SOURCE.url, ref: SOURCE.ref },
    sourceDigest: "sha256:src",
    operation: "create",
    runnerProfileId: "cloudflare-default",
    variablesDigest: "sha256:vars",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: PLAN_DIGEST,
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://plan/tfplan",
      digest: PLAN_DIGEST,
    },
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(planRun);
  await store.putPlanRunInputs({
    planRunId: planRun.id,
    variables: {},
    generatedRoot: {
      files: { "main.tf": 'module "app" { source = "./template-module" }' },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  });
  await seedQueuedApply(store, planRun, "apply_noinst");

  const coordination = new InMemoryInstallationCoordination();
  // Pre-hold the create plan's lease as if a sibling isolate were already
  // applying it.
  const held = await coordination.acquireLease({
    scope: planLeaseScope(planRun.id),
    holderId: "sibling-run",
    ttlMs: 60_000,
  });
  expect(held.acquired).toBe(true);

  const controller = new OpenTofuDeploymentController({
    store,
    installationCoordination: coordination,
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: succeedingRunner(),
    vault: fakeProviderVault() as never,
  });

  // The consumer cannot acquire the busy `plan:{planRunId}` lease, so it
  // rethrows for queue redelivery instead of racing into a second Deployment.
  await expect(
    controller.runQueuedApply("apply_noinst"),
  ).rejects.toBeInstanceOf(InstallationLeaseBusyError);
  expect((await store.getApplyRun("apply_noinst"))?.status).toBe("queued");
});
