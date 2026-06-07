import { expect, test } from "bun:test";

import { OpenTofuDeploymentController } from "./mod.ts";
import {
  InstallationLeaseBusyError,
  type InstallationCoordination,
  InMemoryInstallationCoordination,
  installationLeaseScope,
} from "./installation_lease.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import { seedInstallationModel } from "./test_model_fixture.ts";
import type {
  ApplyRun,
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
 * Seeds the Space-direct Installation model (spec §5) plus a succeeded PlanRun
 * and a queued ApplyRun, all bound to the same Installation (= one
 * `installation:{installationId}:{environment}` lease lane), so the apply
 * consumer takes that lease. The Installation is seeded WITH a current
 * deployment so the update plan's current-deployment guard is well-formed and
 * the state generation (0) matches the plan's base generation.
 */
async function seedApply(
  store: InMemoryOpenTofuDeploymentStore,
  ids: {
    installationId: string;
    planRunId: string;
    applyRunId: string;
    environment?: string;
  },
): Promise<{ environment: string }> {
  const environment = ids.environment ?? "production";
  const seedDeploymentId = `dep_seed_${ids.installationId}`;
  const { installation, source, snapshot } = await seedInstallationModel(store, {
    installationId: ids.installationId,
    spaceId: `space_${ids.installationId}`,
    sourceId: `src_${ids.installationId}`,
    snapshotId: `snap_${ids.installationId}`,
    installConfigId: `cfg_${ids.installationId}`,
    environment,
  });
  await store.putInstallation({
    ...installation,
    currentDeploymentId: seedDeploymentId,
    currentStateGeneration: 0,
    status: "active",
  });
  const moduleSource = {
    kind: "git" as const,
    url: source.url,
    commit: "abcdef0123456789abcdef0123456789abcdef01",
  };
  const planRun: PlanRun = {
    id: ids.planRunId,
    spaceId: installation.spaceId,
    installationId: ids.installationId,
    installationCurrentDeploymentId: seedDeploymentId,
    source: moduleSource,
    sourceSnapshotId: snapshot.id,
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
    spaceId: installation.spaceId,
    installationId: ids.installationId,
    operation: "update",
    runnerProfileId: "cloudflare-default",
    status: "queued",
    expected: {
      planRunId: ids.planRunId,
      installationId: ids.installationId,
      currentDeploymentId: seedDeploymentId,
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
  return { environment };
}

function controllerWith(
  store: InMemoryOpenTofuDeploymentStore,
  coordination: InstallationCoordination,
  runner: { apply: () => Promise<unknown> },
) {
  return new OpenTofuDeploymentController({
    store,
    installationCoordination: coordination,
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
  const { environment } = await seedApply(store, {
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

  const coordination = new InMemoryInstallationCoordination();
  // Pre-hold the installation lease as if a sibling consumer were running.
  const held = await coordination.acquireLease({
    scope: installationLeaseScope("ins_shared", environment),
    holderId: "other-run",
    ttlMs: 60_000,
  });
  expect(held.acquired).toBe(true);

  const controller = controllerWith(store, coordination, {
    apply: () => Promise.resolve({}),
  });

  // The consumer cannot acquire the busy lease -> rethrows for redelivery.
  await expect(controller.runQueuedApply("apply_b")).rejects.toBeInstanceOf(
    InstallationLeaseBusyError,
  );
  // The apply did not run; the run stays queued for the redelivery.
  expect((await store.getApplyRun("apply_b"))?.status).toBe("queued");
});

test("write runs for DIFFERENT environments are not blocked by each other's lease", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { environment: envOne } = await seedApply(store, {
    installationId: "ins_one",
    planRunId: "plan_one",
    applyRunId: "apply_one",
  });
  const coordination = new InMemoryInstallationCoordination();
  // Hold a DIFFERENT installation/environment's lease.
  await coordination.acquireLease({
    scope: installationLeaseScope("ins_two", envOne),
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
  const { environment } = await seedApply(store, {
    installationId: "ins_seq",
    planRunId: "plan_seq",
    applyRunId: "apply_seq",
  });
  const coordination = new InMemoryInstallationCoordination();
  const controller = controllerWith(store, coordination, {
    apply: () => Promise.resolve({}),
  });

  const response = await controller.runQueuedApply("apply_seq");
  expect(response.applyRun.status).toBe("succeeded");

  // The lease was released in finally; a fresh holder can take it.
  const after = await coordination.acquireLease({
    scope: installationLeaseScope("ins_seq", environment),
    holderId: "next-run",
    ttlMs: 60_000,
  });
  expect(after.acquired).toBe(true);
});
