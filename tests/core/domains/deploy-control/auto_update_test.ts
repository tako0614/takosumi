/**
 * Auto-update pipeline tests (consumer "app feel").
 *
 * A Capsule that opted in (`autoUpdate: true`) and goes `stale` because its
 * Source resolved a new commit gets an update plan created by the control
 * plane itself, flagged `autoApplyRequested`; the RunOwner then applies
 * it server-side — but ONLY when the completed plan is CLEAN (`succeeded`).
 * A destructive update (delete/replace → `waiting_approval`) always stops and
 * waits for the user; a Capsule without the opt-in only goes 更新があります.
 * One automatic attempt per snapshot is recorded on
 * `autoUpdateAttemptSourceSnapshotId`.
 */

import { expect, test } from "bun:test";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuController,
  type OpenTofuApplyJob,
  type OpenTofuPlanJob,
  type OpenTofuPlanResult,
  type OpenTofuRunner,
  type OpenTofuSourceSyncJob,
  type OpenTofuSourceSyncResult,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type CapsulePatch,
  type CapsuleStateVersionGuard,
  type UpdateCapsuleLifecycleCommand,
  type UpdateCapsuleLifecycleResult,
} from "../../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type { PlanResourceChange } from "@takosumi/internal/deploy-control-api";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const TEST_TIME = "2026-06-06T00:00:00.000Z";
const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

/** plan + apply + sourceSync stub; plan changes are configurable per test. */
class FullStubRunner implements OpenTofuRunner {
  planResourceChanges: readonly PlanResourceChange[] = [];
  sourceSyncResult: OpenTofuSourceSyncResult = {
    resolvedCommit: "def456abc7890123def456abc7890123def456ab",
    archiveDigest: "sha256:" + "c".repeat(64),
    archiveSizeBytes: 2048,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [
        {
          path: ".",
          providerPackages: [
            { source: FIXTURE_CLOUDFLARE_PROVIDER },
          ],
          rootProviderRequirements: [
            {
              source: FIXTURE_CLOUDFLARE_PROVIDER,
              moduleLocalName: "cloudflare",
            },
          ],
        },
      ],
    },
  };
  planCalls = 0;

  plan(_job: OpenTofuPlanJob): Promise<OpenTofuPlanResult> {
    this.planCalls += 1;
    return Promise.resolve({
      planDigest: PLAN_DIGEST,
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan/tfplan",
        digest: PLAN_DIGEST,
        contentType: "application/vnd.opentofu.plan",
      },
      providerLockDigest: LOCK_DIGEST,
      requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
      providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      ...(this.planResourceChanges.length > 0
        ? { planResourceChanges: this.planResourceChanges }
        : {}),
    });
  }
  apply(job: OpenTofuApplyJob) {
    return Promise.resolve({
      outputs: {
        launch_url: { sensitive: false, value: "https://app.example.com" },
      } as never,
      stateDigest:
        "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      rawOutputRef: job.rawOutputRef,
    });
  }
  destroy() {
    return Promise.resolve({});
  }
  sourceSync(_job: OpenTofuSourceSyncJob): Promise<OpenTofuSourceSyncResult> {
    return Promise.resolve(this.sourceSyncResult);
  }
}

class AutoUpdateClaimBarrierStore extends InMemoryOpenTofuControlStore {
  claimAttempts = 0;
  readonly #firstClaimReached: Promise<void>;
  readonly #releaseClaims: Promise<void>;
  #resolveFirstClaim!: () => void;
  #resolveClaims!: () => void;

  constructor() {
    super();
    this.#firstClaimReached = new Promise((resolve) => {
      this.#resolveFirstClaim = resolve;
    });
    this.#releaseClaims = new Promise((resolve) => {
      this.#resolveClaims = resolve;
    });
  }

  waitForFirstClaim(): Promise<void> {
    return this.#firstClaimReached;
  }

  override async patchCapsule(
    id: string,
    patch: CapsulePatch,
    guard?: CapsuleStateVersionGuard,
  ) {
    if (patch.autoUpdateAttemptSourceSnapshotId !== undefined) {
      await this.#claimBarrier();
    }
    return await super.patchCapsule(id, patch, guard);
  }

  override async updateCapsuleLifecycle(
    input: UpdateCapsuleLifecycleCommand,
  ): Promise<UpdateCapsuleLifecycleResult> {
    if ((input.mutation as { readonly kind: string }).kind === "auto-update-claim") {
      await this.#claimBarrier();
    }
    return await super.updateCapsuleLifecycle(input);
  }

  async #claimBarrier(): Promise<void> {
    this.claimAttempts += 1;
    if (this.claimAttempts === 1) this.#resolveFirstClaim();
    if (this.claimAttempts === 2) this.#resolveClaims();
    await this.#releaseClaims;
  }
}

async function buildActiveCapsule(options: {
  readonly autoUpdate: boolean;
  readonly store?: InMemoryOpenTofuControlStore;
}) {
  const store = options.store ?? new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_test001",
    capsuleId: "cap_auto0001",
    sourceId: "src_a",
    snapshotId: "snap_a",
    installConfigId: "cfg_a",
    name: "app",
  });
  await seedProviderConnections(store, seeded.capsule);
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_t${(counter += 1).toString().padStart(8, "0")}`;
  const sourcesService = new SourcesService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => new Date(TEST_TIME),
    newId,
    newHookSecret: () => "whk_secret",
    // A minimal clean module so the compatibility gate reports `ready` (the
    // in-memory store has no real source archive to expand).
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

output "launch_url" {
  value = "https://app.example.com"
}
`,
        },
      ]),
  });
  const runner = new FullStubRunner();
  const controller = new OpenTofuController({
    store,
    vault: fakeProviderVault() as never,
    sourcesService,
    runner: runner as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: (() => {
      let v = 1;
      return () => v++;
    })(),
    newId,
  });
  // First apply: plan + manual apply → active at generation 1.
  const first = await controller.createCapsulePlan("cap_auto0001");
  await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });
  expect((await controller.getCapsule("cap_auto0001")).capsule.status).toBe(
    "active",
  );
  if (options.autoUpdate) {
    await store.patchCapsule("cap_auto0001", {
      autoUpdate: true,
      updatedAt: TEST_TIME,
    });
  }
  const initialPlanCalls = runner.planCalls;
  return { store, controller, runner, initialPlanCalls };
}

async function syncNewCommit(controller: OpenTofuController): Promise<void> {
  const { run } = await controller.createSourceSync("src_a");
  await controller.runQueuedSourceSync(run.id);
}

/** Internal PlanRun records for the Workspace (via the public run projection ids). */
async function planRunsOf(
  controller: OpenTofuController,
  store: InMemoryOpenTofuControlStore,
) {
  const runs = await controller.listRuns("ws_test001", { limit: 50 });
  const planIds = runs
    .filter((run) => run.type === "plan")
    .map((run) => run.id);
  const records = await Promise.all(planIds.map((id) => store.getPlanRun(id)));
  return records.filter((record) => record !== undefined);
}

test("an opted-in stale capsule auto-updates: plan + clean auto-apply, no client", async () => {
  const { store, controller, runner, initialPlanCalls } =
    await buildActiveCapsule({ autoUpdate: true });

  await syncNewCommit(controller);

  // The whole update ran server-side: stale → auto plan → clean auto-apply.
  const capsule = await store.getCapsule("cap_auto0001");
  expect(capsule?.status).toBe("active");
  expect(capsule?.currentStateGeneration).toBe(2);
  expect(runner.planCalls).toBe(initialPlanCalls + 1);
  // One attempt recorded against the new snapshot (backoff marker).
  expect(capsule?.autoUpdateAttemptSourceSnapshotId).toBeTruthy();
  const snapshots = await store.listSourceSnapshots("src_a");
  const newSnapshot = snapshots.find(
    (snapshot) =>
      snapshot.resolvedCommit === "def456abc7890123def456abc7890123def456ab",
  );
  expect(capsule?.autoUpdateAttemptSourceSnapshotId).toBe(newSnapshot?.id);
  // The auto plan carries the flag and was applied exactly once.
  const planRuns = await planRunsOf(controller, store);
  const autoPlan = planRuns.find((run) => run.autoApplyRequested === true);
  expect(autoPlan?.status).toBe("succeeded");
  expect(autoPlan?.appliedApplyRunId).toBeTruthy();
});

test("a destructive update stops at waiting_approval and is never auto-applied", async () => {
  const { store, controller, runner } = await buildActiveCapsule({
    autoUpdate: true,
  });
  runner.planResourceChanges = [
    {
      address: "cloudflare_workers_script.app",
      type: "cloudflare_workers_script",
      actions: ["delete", "create"],
    },
  ];

  await syncNewCommit(controller);

  // The update plan flags requiresApproval (persisted status stays
  // `succeeded`; the §19 projection parks it waiting_approval at read time) —
  // the auto-apply hook must NOT continue. Nothing applied; the capsule stays
  // 更新があります (stale) until the user reviews.
  const capsule = await store.getCapsule("cap_auto0001");
  expect(capsule?.status).toBe("stale");
  expect(capsule?.currentStateGeneration).toBe(1);
  const planRuns = await planRunsOf(controller, store);
  const autoPlan = planRuns.find((run) => run.autoApplyRequested === true);
  expect(autoPlan?.status).toBe("succeeded");
  expect(autoPlan?.requiresApproval).toBe(true);
  expect(autoPlan?.appliedApplyRunId).toBeUndefined();
});

test("without the opt-in a stale capsule stays stale and no auto plan is created", async () => {
  const { store, controller, runner, initialPlanCalls } =
    await buildActiveCapsule({ autoUpdate: false });

  await syncNewCommit(controller);

  const capsule = await store.getCapsule("cap_auto0001");
  expect(capsule?.status).toBe("stale");
  expect(capsule?.autoUpdateAttemptSourceSnapshotId).toBeUndefined();
  expect(runner.planCalls).toBe(initialPlanCalls);
  const planRuns = await planRunsOf(controller, store);
  expect(planRuns.some((run) => run.autoApplyRequested === true)).toBe(false);
});

test("manual-plan source sync never races an enabled auto-update policy", async () => {
  const { store, controller, runner, initialPlanCalls } =
    await buildActiveCapsule({ autoUpdate: true });

  const { run } = await controller.createSourceSync("src_a", {
    intent: "manual_plan",
  });
  await controller.runQueuedSourceSync(run.id);

  const capsule = await store.getCapsule("cap_auto0001");
  expect(capsule?.status).toBe("stale");
  expect(capsule?.autoUpdateAttemptSourceSnapshotId).toBeUndefined();
  expect(runner.planCalls).toBe(initialPlanCalls);
  const planRuns = await planRunsOf(controller, store);
  expect(
    planRuns.some((candidate) => candidate.autoApplyRequested === true),
  ).toBe(false);
});

test("two source sync completions create exactly one auto-update claim and Plan", async () => {
  const store = new AutoUpdateClaimBarrierStore();
  const { controller, runner, initialPlanCalls } = await buildActiveCapsule({
    autoUpdate: true,
    store,
  });
  const first = await controller.createSourceSync("src_a");
  const second = await controller.createSourceSync("src_a");

  const firstCompletion = controller.runQueuedSourceSync(first.run.id);
  await store.waitForFirstClaim();
  const secondCompletion = controller.runQueuedSourceSync(second.run.id);
  await Promise.all([firstCompletion, secondCompletion]);

  expect(store.claimAttempts).toBe(2);
  const plans = await planRunsOf(controller, store);
  const autoPlans = plans.filter((run) => run.autoApplyRequested === true);
  expect(autoPlans).toHaveLength(1);
  expect(autoPlans[0]?.sourceSnapshotId).toBe(
    (await store.getCapsule("cap_auto0001"))
      ?.autoUpdateAttemptSourceSnapshotId,
  );
  expect(runner.planCalls).toBe(initialPlanCalls + 1);
});
