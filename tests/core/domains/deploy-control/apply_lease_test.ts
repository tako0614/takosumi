import { expect, test } from "bun:test";

import { OpenTofuController } from "../../../../core/domains/deploy-control/mod.ts";
import {
  CapsuleLeaseBusyError,
  type CapsuleCoordination,
  InMemoryCapsuleCoordination,
  capsuleLeaseScope,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";

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
 * Seeds the Workspace-direct Capsule model (spec §5) plus a succeeded PlanRun
 * and a queued ApplyRun, all bound to the same Capsule (= one
 * `capsule:{capsuleId}:{environment}` lease lane), so the apply
 * consumer takes that lease. The Capsule is seeded WITH a current
 * StateVersion so the update plan's current-StateVersion guard is well-formed and
 * the state generation (0) matches the plan's base generation.
 */
async function seedApply(
  store: InMemoryOpenTofuControlStore,
  ids: {
    capsuleId: string;
    planRunId: string;
    applyRunId: string;
    environment?: string;
  },
): Promise<{ environment: string }> {
  const environment = ids.environment ?? "production";
  const seedStateVersionId = `state_seed_${ids.capsuleId}`;
  const { capsule, source, snapshot } = await seedCapsuleModel(store, {
    capsuleId: ids.capsuleId,
    workspaceId: `ws_${ids.capsuleId}`,
    sourceId: `src_${ids.capsuleId}`,
    snapshotId: `snap_${ids.capsuleId}`,
    installConfigId: `cfg_${ids.capsuleId}`,
    environment,
  });
  await store.putCapsule({
    ...capsule,
    currentStateVersionId: seedStateVersionId,
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
    workspaceId: capsule.workspaceId,
    capsuleId: ids.capsuleId,
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: ids.capsuleId,
      environment,
    },
    capsuleCurrentStateVersionId: seedStateVersionId,
    source: moduleSource,
    sourceSnapshotId: snapshot.id,
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "opentofu-default",
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
  await store.putPlanRunInputs({
    planRunId: planRun.id,
    variables: {},
    generatedRoot: {
      files: {
        "main.tf": 'module "child" { source = "./module" }',
      },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  });
  const applyRun: ApplyRun = {
    id: ids.applyRunId,
    planRunId: ids.planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: ids.capsuleId,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "queued",
    expected: {
      planRunId: ids.planRunId,
      capsuleId: ids.capsuleId,
      currentStateVersionId: seedStateVersionId,
      runnerProfileId: "opentofu-default",
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
  store: InMemoryOpenTofuControlStore,
  coordination: CapsuleCoordination,
  runner: { apply: () => Promise<unknown> },
) {
  return new OpenTofuController({
    store,
    capsuleCoordination: coordination,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
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
  const store = new InMemoryOpenTofuControlStore();
  const { environment } = await seedApply(store, {
    capsuleId: "cap_shared01",
    planRunId: "plan_a",
    applyRunId: "apply_a",
  });
  // A second apply targeting the SAME capsule/environment.
  await seedApply(store, {
    capsuleId: "cap_shared01",
    planRunId: "plan_b",
    applyRunId: "apply_b",
  });

  const coordination = new InMemoryCapsuleCoordination();
  // Pre-hold the capsule lease as if a sibling consumer were running.
  const held = await coordination.acquireLease({
    scope: capsuleLeaseScope("cap_shared01", environment),
    holderId: "other-run",
    ttlMs: 60_000,
  });
  expect(held.acquired).toBe(true);

  const controller = controllerWith(store, coordination, {
    apply: () => Promise.resolve({}),
  });

  // The consumer cannot acquire the busy lease -> rethrows for redelivery.
  await expect(controller.runQueuedApply("apply_b")).rejects.toBeInstanceOf(
    CapsuleLeaseBusyError,
  );
  // The apply did not run; the run stays queued for the redelivery.
  expect((await store.getApplyRun("apply_b"))?.status).toBe("queued");
});

test("write runs for DIFFERENT environments are not blocked by each other's lease", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { environment: envOne } = await seedApply(store, {
    capsuleId: "cap_one00001",
    planRunId: "plan_one",
    applyRunId: "apply_one",
  });
  const coordination = new InMemoryCapsuleCoordination();
  // Hold a DIFFERENT capsule/environment's lease.
  await coordination.acquireLease({
    scope: capsuleLeaseScope("cap_two00001", envOne),
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
  const store = new InMemoryOpenTofuControlStore();
  const { environment } = await seedApply(store, {
    capsuleId: "cap_seq00001",
    planRunId: "plan_seq",
    applyRunId: "apply_seq",
  });
  const coordination = new InMemoryCapsuleCoordination();
  const controller = controllerWith(store, coordination, {
    apply: () => Promise.resolve({}),
  });

  const response = await controller.runQueuedApply("apply_seq");
  expect(response.applyRun.status).toBe("succeeded");

  // The lease was released in finally; a fresh holder can take it.
  const after = await coordination.acquireLease({
    scope: capsuleLeaseScope("cap_seq00001", environment),
    holderId: "next-run",
    ttlMs: 60_000,
  });
  expect(after.acquired).toBe(true);
});
