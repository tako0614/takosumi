/**
 * SECURITY S5 — create-plan apply-once is atomic across isolates.
 *
 * A `create` apply has no prior StateVersion to guard against, so the
 * apply-once invariant (a succeeded plan applies AT MOST once) is the only
 * thing standing between two concurrent create-applies and a real duplicate
 * Capsule + StateVersion (duplicate cloud resources). The up-front
 * `appliedApplyRunId` check in `createApplyRun` is non-atomic: two cross-isolate
 * applies of the same plan both observe it undefined before either marks the
 * plan applied. The cross-isolate guard is the coordination lease:
 * A Capsule-first `create` plan is covered by the `capsule:{id}:{env}` lease
 * (one write run per environment at a time).
 *
 * In both cases the inner `#executeApply` re-reads the persisted PlanRun under
 * the lease and folds a sibling that already marked it applied into an
 * idempotent replay, so only ONE StateVersion is ever recorded and the duplicate
 * apply does not poison the Capsule status.
 */

import { expect, test } from "bun:test";

import {
  applyExpectedGuardFromPlanRun,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryCapsuleCoordination } from "../../../../core/domains/deploy-control/capsule_lease.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";

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
 * Builds a controller over a freshly-seeded Capsule (generation 0, NO
 * current StateVersion) plus a succeeded `create` PlanRun ready to apply. The
 * coordination seam is wired so the apply consumer takes the lease.
 */
async function seedCreatePlan(): Promise<{
  store: InMemoryOpenTofuControlStore;
  coordination: InMemoryCapsuleCoordination;
  controller: OpenTofuController;
  planRun: PlanRun;
  capsuleId: string;
}> {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "ws_test001",
    capsuleId: "cap_create01",
  });
  // A fresh Capsule: pending, no current StateVersion, generation 0 — the
  // shape a `create` apply lands its FIRST StateVersion on.
  await store.putCapsule({ ...capsule, status: "pending" });
  await seedProviderConnections(store, capsule);
  const coordination = new InMemoryCapsuleCoordination();
  const controller = new OpenTofuController({
    store,
    capsuleCoordination: coordination,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: succeedingRunner(),
    vault: fakeProviderVault() as never,
  });
  const { planRun } = await controller.createCapsulePlan(capsule.id);
  expect(planRun.status).toBe("succeeded");
  expect(planRun.operation).toBe("create");
  return {
    store,
    coordination,
    controller,
    planRun,
    capsuleId: capsule.id,
  };
}

/** Seeds a queued ApplyRun against a succeeded PlanRun, bypassing the up-front
 *  `createApplyRun` apply-once check (to simulate the second isolate that
 *  already passed the non-atomic check before the first marked the plan
 *  applied). */
async function seedQueuedApply(
  store: InMemoryOpenTofuControlStore,
  planRun: PlanRun,
  applyRunId: string,
): Promise<void> {
  const apply: ApplyRun = {
    id: applyRunId,
    planRunId: planRun.id,
    workspaceId: planRun.workspaceId,
    ...(planRun.capsuleId ? { capsuleId: planRun.capsuleId } : {}),
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

test("two applies of the same create plan: exactly one materializes, the other replays, only ONE StateVersion", async () => {
  const { store, controller, planRun, capsuleId } = await seedCreatePlan();

  // Two ApplyRuns both pass the non-atomic up-front check (modeled by seeding
  // them directly), as two cross-isolate consumers would.
  await seedQueuedApply(store, planRun, "apply_first");
  await seedQueuedApply(store, planRun, "apply_second");

  // First consumer acquires the lease, completes, marks the plan applied, and
  // records exactly one StateVersion.
  const first = await controller.runQueuedApply("apply_first");
  expect(first.applyRun.status).toBe("succeeded");
  expect((await store.getPlanRun(planRun.id))?.appliedApplyRunId).toBe(
    "apply_first",
  );

  // Second consumer (redelivered after the first released the lease) re-reads
  // the now-applied plan under the lease and is folded into an idempotent
  // replay — it never allocates a second StateVersion and it is not a failed run.
  const second = await controller.runQueuedApply("apply_second");
  expect(second.applyRun.status).toBe("succeeded");
  expect(second.applyRun.stateVersionId).toBe(first.applyRun.stateVersionId);
  expect(second.applyRun.auditEvents.map((event) => event.type)).toContain(
    "apply.idempotent_replay",
  );

  const stateVersions = await store.listStateVersions(capsuleId, "production");
  expect(stateVersions.length).toBe(1);
});

test("createApplyRun returns the existing apply response after a plan has already applied", async () => {
  const { store, controller, planRun, capsuleId } = await seedCreatePlan();

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
  expect(replay.applyRun.stateVersionId).toBe(first.applyRun.stateVersionId);

  const stateVersions = await store.listStateVersions(capsuleId, "production");
  expect(stateVersions.length).toBe(1);
});
