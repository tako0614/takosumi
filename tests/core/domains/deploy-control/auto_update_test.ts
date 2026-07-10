/**
 * Auto-update pipeline tests (consumer "app feel").
 *
 * A Capsule that opted in (`autoUpdate: true`) and goes `stale` because its
 * Source resolved a new commit gets an update plan created by the control
 * plane itself, flagged `autoApplyRequested`; the queue consumer then applies
 * it server-side — but ONLY when the completed plan is CLEAN (`succeeded`).
 * A destructive update (delete/replace → `waiting_approval`) always stops and
 * waits for the user; a Capsule without the opt-in only goes 更新があります.
 * One automatic attempt per snapshot is recorded on
 * `autoUpdateAttemptSourceSnapshotId`.
 */

import { expect, test } from "bun:test";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
  type OpenTofuApplyJob,
  type OpenTofuPlanJob,
  type OpenTofuPlanResult,
  type OpenTofuRunner,
  type OpenTofuSourceSyncJob,
  type OpenTofuSourceSyncResult,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import type { PlanResourceChange } from "@takosumi/internal/deploy-control-api";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedInstallationModel,
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
  apply(_job: OpenTofuApplyJob) {
    return Promise.resolve({
      outputs: {
        launch_url: { sensitive: false, value: "https://app.example.com" },
      } as never,
      stateDigest:
        "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    });
  }
  destroy() {
    return Promise.resolve({});
  }
  sourceSync(_job: OpenTofuSourceSyncJob): Promise<OpenTofuSourceSyncResult> {
    return Promise.resolve(this.sourceSyncResult);
  }
}

async function buildActiveCapsule(options: { readonly autoUpdate: boolean }) {
  const store = new InMemoryOpenTofuDeploymentStore();
  const seeded = await seedInstallationModel(store, {
    installationId: "inst_a",
    sourceId: "src_a",
    snapshotId: "snap_a",
    installConfigId: "cfg_a",
    name: "app",
  });
  await seedProviderConnections(store, seeded.installation);
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_t${(counter += 1).toString().padStart(8, "0")}`;
  const sourcesService = new SourcesService({
    store,
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
  const controller = new OpenTofuDeploymentController({
    store,
    vault: fakeProviderVault() as never,
    sourcesService,
    runner: runner as never,
    now: (() => {
      let v = 1;
      return () => v++;
    })(),
    newId,
  });
  // First install: plan + manual apply → active at generation 1.
  const first = await controller.createInstallationPlan("inst_a");
  await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });
  expect((await controller.getInstallation("inst_a")).installation.status).toBe(
    "active",
  );
  if (options.autoUpdate) {
    await store.patchInstallation("inst_a", {
      autoUpdate: true,
      updatedAt: TEST_TIME,
    });
  }
  const initialPlanCalls = runner.planCalls;
  return { store, controller, runner, initialPlanCalls };
}

async function syncNewCommit(
  controller: OpenTofuDeploymentController,
): Promise<void> {
  const { run } = await controller.createSourceSync("src_a");
  await controller.runQueuedSourceSync(run.id);
}

/** Internal PlanRun records for the space (via the public run projection ids). */
async function planRunsOf(
  controller: OpenTofuDeploymentController,
  store: InMemoryOpenTofuDeploymentStore,
) {
  const runs = await controller.listRuns("space_test", { limit: 50 });
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
  const capsule = await store.getInstallation("inst_a");
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
  const capsule = await store.getInstallation("inst_a");
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

  const capsule = await store.getInstallation("inst_a");
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

  const capsule = await store.getInstallation("inst_a");
  expect(capsule?.status).toBe("stale");
  expect(capsule?.autoUpdateAttemptSourceSnapshotId).toBeUndefined();
  expect(runner.planCalls).toBe(initialPlanCalls);
  const planRuns = await planRunsOf(controller, store);
  expect(
    planRuns.some((candidate) => candidate.autoApplyRequested === true),
  ).toBe(false);
});
