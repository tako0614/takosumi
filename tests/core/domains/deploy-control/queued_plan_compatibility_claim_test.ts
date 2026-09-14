import { expect, test } from "bun:test";

import {
  OpenTofuController,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryOpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { OpenTofuPlanArtifact, PlanRun } from "@takosumi/internal/deploy-control-api";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fakeProviderVault,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const PLAN_ARTIFACT: OpenTofuPlanArtifact = {
  kind: "runner-local",
  ref: "runner-local://plan/queued-compatibility-claim",
  digest: PLAN_DIGEST,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve(value: T) {
      resolve(value);
    },
  };
}

/**
 * Pauses exactly the existing report read used by the queued-plan preclaim.
 * This creates a deterministic window for a competing durable transition.
 */
class CompatibilityReadPauseStore extends InMemoryOpenTofuControlStore {
  private pauseReportId: string | undefined;
  private pauseNextRead = false;
  private readCaptured = deferred<void>();
  private releaseRead = deferred<void>();
  readonly planWrites: PlanRun[] = [];

  armCompatibilityReadPause(reportId: string): void {
    this.pauseReportId = reportId;
    this.pauseNextRead = true;
    this.readCaptured = deferred<void>();
    this.releaseRead = deferred<void>();
  }

  waitForCompatibilityRead(): Promise<void> {
    return this.readCaptured.promise;
  }

  releaseCompatibilityRead(): void {
    this.releaseRead.resolve();
  }

  override async getCapsuleCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const report = await super.getCapsuleCompatibilityReport(id);
    if (this.pauseNextRead && id === this.pauseReportId) {
      this.pauseNextRead = false;
      this.readCaptured.resolve();
      await this.releaseRead.promise;
    }
    return report;
  }

  override async putPlanRun(run: PlanRun): Promise<PlanRun> {
    this.planWrites.push(run);
    return await super.putPlanRun(run);
  }
}

interface QueuedPlanFixture {
  readonly store: CompatibilityReadPauseStore;
  readonly planRun: PlanRun;
  readonly planInputs: Awaited<
    ReturnType<CompatibilityReadPauseStore["getPlanRunInputs"]>
  >;
  readonly report: CapsuleCompatibilityReport;
  readonly runner: RecordingRunner;
  readonly controller: OpenTofuController;
  readonly clock: { value: number };
}

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
}

function recordingRunner(): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  return {
    planJobs,
    plan: async (job) => {
      planJobs.push(job);
      return {
        planDigest: PLAN_DIGEST,
        planArtifact: PLAN_ARTIFACT,
        requiredProviders: [],
        providerInstallation: [],
      };
    },
    apply: async () => ({}),
  };
}

function newIdFactory(): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}_${String(++next).padStart(4, "0")}`;
}

function controllerFor(
  store: CompatibilityReadPauseStore,
  runner: RecordingRunner,
  clock: { value: number },
  sourcesService?: SourcesService,
): OpenTofuController {
  return new OpenTofuController({
    store,
    runner,
    ...(sourcesService ? { sourcesService } : {}),
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    now: () => clock.value,
    newId: newIdFactory(),
    enqueueRun: () => Promise.resolve(),
  });
}

function readyCompatibilityReport(
  seeded: Awaited<ReturnType<typeof seedCapsuleModel>>,
): CapsuleCompatibilityReport {
  return {
    id: "caprep_queued_plan_claim",
    sourceId: seeded.source.id,
    capsuleId: seeded.capsule.id,
    sourceSnapshotId: seeded.snapshot.id,
    modulePath: ".",
    level: "ready",
    findings: [],
    providerPackages: [],
    rootProviderRequirements: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-09-14T00:00:00.000Z",
  };
}

async function createQueuedPlanFixture(): Promise<QueuedPlanFixture> {
  const store = new CompatibilityReadPauseStore();
  const runner = recordingRunner();
  const clock = { value: 1 };
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_queued_plan_claim",
    sourceId: "src_queued_plan_claim",
    snapshotId: "snap_queued_plan_claim",
    installConfigId: "cfg_queued_plan_claim",
    capsuleId: "cap_queued_plan_claim",
    environment: "preview",
    requiredProviders: [],
  });

  // Create the admitted queued Plan before a compatibility pointer exists.
  // The persisted row is therefore valid but intentionally has no reportId.
  const creatingController = controllerFor(store, runner, clock);
  const created = await creatingController.createCapsulePlan(
    seeded.capsule.id,
  );
  const planRun = await store.getPlanRun(created.planRun.id);
  if (!planRun) throw new Error("queued Plan fixture was not persisted");
  if (planRun.compatibilityReportId !== undefined) {
    throw new Error("queued Plan fixture unexpectedly already has reportId");
  }
  const planInputs = await store.getPlanRunInputs(planRun.id);
  if (!planInputs) throw new Error("queued Plan fixture inputs are missing");

  const report = readyCompatibilityReport(seeded);
  await store.putCapsuleCompatibilityReport(report);
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: report.id,
    compatibilityStatus: "ready",
  });

  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-09-14T00:00:00.000Z"),
    newId: newIdFactory(),
    readCapsuleSourceFiles: () => {
      throw new Error("matching CompatibilityReport should avoid source reads");
    },
  });
  const controller = controllerFor(store, runner, clock, sourcesService);

  return {
    store,
    planRun,
    planInputs,
    report,
    runner,
    controller,
    clock,
  };
}

async function duringCompatibilityRead(
  fixture: QueuedPlanFixture,
  compete: () => Promise<void>,
): Promise<PlanRun | undefined> {
  fixture.store.armCompatibilityReadPause(fixture.report.id);
  const attempt = fixture.controller.runQueuedPlan(fixture.planRun.id);
  try {
    await Promise.race([
      fixture.store.waitForCompatibilityRead(),
      attempt.then(() => { throw new Error("consumer completed before report read"); }),
    ]);
    await compete();
  } finally {
    fixture.store.releaseCompatibilityRead();
    await attempt;
  }
  return attempt;
}

test("queued Plan compatibility preclaim cannot overwrite a draining Workspace row", async () => {
  const fixture = await createQueuedPlanFixture();
  const result = await duringCompatibilityRead(fixture, async () => {
    const management = await fixture.store.getWorkspaceManagement(fixture.planRun.workspaceId);
    if (!management) throw new Error("Workspace management fixture is missing");
    const drained = await fixture.store.beginWorkspaceDraining(fixture.planRun.workspaceId, {
      workspaceId: fixture.planRun.workspaceId,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    });
    expect(drained.status).toBe("started");
  });

  expect(result?.status).toBe("queued");
  expect(result?.compatibilityReportId).toBeUndefined();
  expect(fixture.runner.planJobs).toHaveLength(0);
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(
    fixture.planRun,
  );
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(
    fixture.planInputs,
  );
});

test("queued Plan compatibility preclaim cannot resurrect a cancelled Plan", async () => {
  const fixture = await createQueuedPlanFixture();
  let winner: PlanRun | undefined;
  const result = await duringCompatibilityRead(fixture, async () => {
    await fixture.controller.cancelRun(fixture.planRun.id);
    winner = await fixture.store.getPlanRun(fixture.planRun.id);
    expect(winner?.status).toBe("cancelled");
  });
  expect(result).toEqual(winner);
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(winner);
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toBeUndefined();
  expect(fixture.runner.planJobs).toHaveLength(0);
});

test("queued Plan compatibility preclaim preserves a sibling running claim", async () => {
  const fixture = await createQueuedPlanFixture();
  let winner: PlanRun | undefined;
  const result = await duringCompatibilityRead(fixture, async () => {
    const claimed = await fixture.store.transitionRun({
      id: fixture.planRun.id, kind: "plan", expectFrom: ["queued"],
      setLeaseToken: "sibling-lease",
      run: { ...fixture.planRun, status: "running", startedAt: 2, heartbeatAt: 2, updatedAt: 2 },
    });
    expect(claimed.won).toBe(true);
    winner = await fixture.store.getPlanRun(fixture.planRun.id);
  });
  expect(result).toEqual(winner);
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(winner);
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(fixture.planInputs);
  expect(fixture.runner.planJobs).toHaveLength(0);
});

test("stale Plan compatibility preclaim cannot erase a renewed heartbeat", async () => {
  const fixture = await createQueuedPlanFixture();
  const claimed = await fixture.store.transitionRun({
    id: fixture.planRun.id, kind: "plan", expectFrom: ["queued"],
    setLeaseToken: "original-lease",
    run: { ...fixture.planRun, status: "running", startedAt: 1, heartbeatAt: 1, updatedAt: 1 },
  });
  expect(claimed.won).toBe(true);
  fixture.clock.value = 1_000_000;
  let winner: PlanRun | undefined;
  const result = await duringCompatibilityRead(fixture, async () => {
    const running = await fixture.store.getPlanRun(fixture.planRun.id);
    if (!running) throw new Error("running Plan fixture is missing");
    const renewed = await fixture.store.transitionRun({
      id: running.id, kind: "plan", expectFrom: ["running"],
      expectLeaseToken: "original-lease",
      run: { ...running, heartbeatAt: fixture.clock.value, updatedAt: fixture.clock.value },
    });
    expect(renewed.won).toBe(true);
    winner = await fixture.store.getPlanRun(running.id);
  });
  expect(result).toEqual(winner);
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(winner);
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(fixture.planInputs);
  expect(fixture.runner.planJobs).toHaveLength(0);
});

test("active queued Plan compatibility preclaim persists its report through the running claim", async () => {
  const fixture = await createQueuedPlanFixture();
  fixture.store.planWrites.length = 0;

  const result = await fixture.controller.runQueuedPlan(fixture.planRun.id);

  expect(result?.status).toBe("succeeded");
  expect(result?.compatibilityReportId).toBe(fixture.report.id);
  expect(
    (await fixture.store.getPlanRun(fixture.planRun.id))?.compatibilityReportId,
  ).toBe(fixture.report.id);
  expect(fixture.runner.planJobs).toHaveLength(1);
  expect(
    fixture.store.planWrites.filter(
      (run) => run.status === "queued" && run.compatibilityReportId,
    ),
  ).toHaveLength(0);
});
