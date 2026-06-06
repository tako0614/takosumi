import { expect, test } from "bun:test";

import { OpenTofuDeploymentController } from "./mod.ts";
import {
  EnvironmentLeaseBusyError,
  type EnvironmentCoordination,
  InMemoryEnvironmentCoordination,
} from "./environment_lease.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import type {
  ApplyRun,
  Installation,
  PlanRun,
} from "takosumi-contract/deploy-control-api";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function planArtifact() {
  return {
    kind: "runner-local" as const,
    ref: "runner-local://plan/tfplan",
    digest: PLAN_DIGEST,
  };
}

/**
 * Seeds a store with an installation + a succeeded PlanRun + a queued ApplyRun,
 * all bound to the same installation (= environment lane), so the apply consumer
 * takes the `environment:{installationId}` lease.
 */
async function seedApply(
  store: InMemoryOpenTofuDeploymentStore,
  ids: { installationId: string; planRunId: string; applyRunId: string },
): Promise<void> {
  const source = {
    kind: "git" as const,
    url: "https://github.com/example/app.git",
    ref: "main",
  };
  const installation: Installation = {
    id: ids.installationId,
    spaceId: "space_1",
    appId: "app_1",
    source,
    runnerProfileId: "cloudflare-default",
    currentDeploymentId: null,
    status: "ready",
    stateGeneration: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putInstallation(installation);
  const planRun: PlanRun = {
    id: ids.planRunId,
    spaceId: "space_1",
    installationId: ids.installationId,
    installationCurrentDeploymentId: null,
    source,
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "cloudflare-default",
    variablesDigest: "sha256:vars",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: PLAN_DIGEST,
    planArtifact: planArtifact(),
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(planRun);
  const applyRun: ApplyRun = {
    id: ids.applyRunId,
    planRunId: ids.planRunId,
    spaceId: "space_1",
    installationId: ids.installationId,
    operation: "update",
    runnerProfileId: "cloudflare-default",
    status: "queued",
    expected: {
      planRunId: ids.planRunId,
      installationId: ids.installationId,
      currentDeploymentId: null,
      runnerProfileId: "cloudflare-default",
      sourceDigest: "sha256:src",
      variablesDigest: "sha256:vars",
      policyDecisionDigest: "sha256:policy",
      planDigest: PLAN_DIGEST,
      planArtifactDigest: PLAN_DIGEST,
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putApplyRun(applyRun);
}

function controllerWith(
  store: InMemoryOpenTofuDeploymentStore,
  coordination: EnvironmentCoordination,
  runner: { apply: () => Promise<unknown> },
) {
  return new OpenTofuDeploymentController({
    store,
    environmentCoordination: coordination,
    now: () => 1,
    newId: ((): ((p: string) => string) => {
      let n = 0;
      return (p) => `${p}_${(n += 1).toString().padStart(4, "0")}`;
    })(),
    runner: {
      plan: () => Promise.reject(new Error("not used")),
      apply: runner.apply,
    },
  });
}

test("a second write run for the same environment is blocked while the lease is held", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedApply(store, {
    installationId: "ins_shared",
    planRunId: "plan_a",
    applyRunId: "apply_a",
  });
  // A second apply targeting the SAME installation/environment.
  await seedApply(store, {
    installationId: "ins_shared",
    planRunId: "plan_b",
    applyRunId: "apply_b",
  });

  const coordination = new InMemoryEnvironmentCoordination();
  // Pre-hold the environment lease as if a sibling consumer were running.
  const held = await coordination.acquireLease({
    scope: "environment:ins_shared",
    holderId: "other-run",
    ttlMs: 60_000,
  });
  expect(held.acquired).toBe(true);

  const controller = controllerWith(store, coordination, {
    apply: () => Promise.resolve({}),
  });

  // The consumer cannot acquire the busy lease -> rethrows for redelivery.
  await expect(controller.runQueuedApply("apply_b")).rejects.toBeInstanceOf(
    EnvironmentLeaseBusyError,
  );
  // The apply did not run; the run stays queued for the redelivery.
  expect((await store.getApplyRun("apply_b"))?.status).toBe("queued");
});

test("write runs for DIFFERENT environments are not blocked by each other's lease", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedApply(store, {
    installationId: "ins_one",
    planRunId: "plan_one",
    applyRunId: "apply_one",
  });
  const coordination = new InMemoryEnvironmentCoordination();
  // Hold a DIFFERENT environment's lease.
  await coordination.acquireLease({
    scope: "environment:ins_two",
    holderId: "other-run",
    ttlMs: 60_000,
  });

  let applied = false;
  const controller = controllerWith(store, coordination, {
    apply: () => {
      applied = true;
      return Promise.resolve({});
    },
  });

  const response = await controller.runQueuedApply("apply_one");
  expect(applied).toBe(true);
  expect(response.applyRun.status).toBe("succeeded");
});

test("the lease is released after a successful apply so the next run can acquire it", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedApply(store, {
    installationId: "ins_seq",
    planRunId: "plan_seq",
    applyRunId: "apply_seq",
  });
  const coordination = new InMemoryEnvironmentCoordination();
  const controller = controllerWith(store, coordination, {
    apply: () => Promise.resolve({}),
  });

  const response = await controller.runQueuedApply("apply_seq");
  expect(response.applyRun.status).toBe("succeeded");

  // The lease was released in finally; a fresh holder can take it.
  const after = await coordination.acquireLease({
    scope: "environment:ins_seq",
    holderId: "next-run",
    ttlMs: 60_000,
  });
  expect(after.acquired).toBe(true);
});
