import { expect, test } from "bun:test";

import {
  OpenTofuController,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type PlanRunInputs,
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
  private reportReadCount = 0;
  private reportReadPauseAt = 1;
  private reportReadFailure: Error | undefined;
  private readCaptured = deferred<void>();
  private releaseRead = deferred<void>();
  private pausePlanInputsId: string | undefined;
  private pausePlanInputsRead = false;
  private planInputsFailure: Error | undefined;
  private planInputsReadCaptured = deferred<void>();
  private planInputsReleaseGate = deferred<void>();
  readonly planWrites: PlanRun[] = [];
  readonly inputDeletes: string[] = [];
  failInputDeletion = false;
  afterPlanRead: (() => Promise<void>) | undefined;

  override async getPlanRun(id: string): Promise<PlanRun | undefined> {
    const run = await super.getPlanRun(id);
    const afterRead = this.afterPlanRead;
    this.afterPlanRead = undefined;
    await afterRead?.();
    return run;
  }

  override async deletePlanRunInputs(id: string): Promise<void> {
    this.inputDeletes.push(id);
    if (this.failInputDeletion) throw new Error("injected input cleanup failure");
    await super.deletePlanRunInputs(id);
  }

  armCompatibilityReadPause(
    reportId: string,
    options: {
      readonly failure?: "ensure" | "verification";
    } = {},
  ): void {
    this.pauseReportId = reportId;
    this.pauseNextRead = true;
    this.reportReadCount = 0;
    this.reportReadPauseAt = options.failure === "verification" ? 2 : 1;
    this.reportReadFailure = options.failure
      ? new Error(`injected ${options.failure} compatibility report failure`)
      : undefined;
    this.readCaptured = deferred<void>();
    this.releaseRead = deferred<void>();
  }

  waitForCompatibilityRead(): Promise<void> {
    return this.readCaptured.promise;
  }

  releaseCompatibilityRead(): void {
    this.releaseRead.resolve();
  }

  armPlanInputsFailure(planRunId: string): void {
    this.pausePlanInputsId = planRunId;
    this.pausePlanInputsRead = true;
    this.planInputsFailure = new Error("injected prepared-inputs read failure");
    this.planInputsReadCaptured = deferred<void>();
    this.planInputsReleaseGate = deferred<void>();
  }

  waitForPlanInputsRead(): Promise<void> {
    return this.planInputsReadCaptured.promise;
  }

  releasePlanInputsRead(): void {
    this.planInputsReleaseGate.resolve();
  }

  override async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    const inputs = await super.getPlanRunInputs(planRunId);
    if (this.pausePlanInputsRead && planRunId === this.pausePlanInputsId) {
      this.pausePlanInputsRead = false;
      this.planInputsReadCaptured.resolve();
      await this.planInputsReleaseGate.promise;
      throw this.planInputsFailure;
    }
    return inputs;
  }

  override async getCapsuleCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const report = await super.getCapsuleCompatibilityReport(id);
    if (id === this.pauseReportId) this.reportReadCount += 1;
    if (
      this.pauseNextRead &&
      id === this.pauseReportId &&
      this.reportReadCount === this.reportReadPauseAt
    ) {
      this.pauseNextRead = false;
      this.readCaptured.resolve();
      await this.releaseRead.promise;
      if (this.reportReadFailure) throw this.reportReadFailure;
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
  readonly planInputs: PlanRunInputs;
  readonly report: CapsuleCompatibilityReport;
  readonly runner: RecordingRunner;
  readonly controller: OpenTofuController;
  readonly clock: { value: number };
}

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  onPlan?: () => Promise<void>;
}

function recordingRunner(): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const runner: RecordingRunner = {
    planJobs,
    plan: async (job) => {
      planJobs.push(job);
      await runner.onPlan?.();
      return {
        planDigest: PLAN_DIGEST,
        planArtifact: PLAN_ARTIFACT,
        requiredProviders: [],
        providerInstallation: [],
      };
    },
    apply: async () => ({}),
  };
  return runner;
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
  return await duringPreclaimPause(fixture, compete, {
    wait: fixture.store.waitForCompatibilityRead(),
    release: () => fixture.store.releaseCompatibilityRead(),
  });
}

async function duringPreparedInputsFailure(
  fixture: QueuedPlanFixture,
  compete: () => Promise<void>,
): Promise<PlanRun | undefined> {
  fixture.store.armPlanInputsFailure(fixture.planRun.id);
  return await duringPreclaimPause(fixture, compete, {
    wait: fixture.store.waitForPlanInputsRead(),
    release: () => fixture.store.releasePlanInputsRead(),
  });
}

async function duringCompatibilityFailure(
  fixture: QueuedPlanFixture,
  phase: "ensure" | "verification",
  compete: () => Promise<void>,
): Promise<PlanRun | undefined> {
  fixture.store.armCompatibilityReadPause(fixture.report.id, { failure: phase });
  return await duringPreclaimPause(fixture, compete, {
    wait: fixture.store.waitForCompatibilityRead(),
    release: () => fixture.store.releaseCompatibilityRead(),
  });
}

async function claimQueuedSibling(
  fixture: QueuedPlanFixture,
  leaseToken: string,
): Promise<PlanRun> {
  const current = await fixture.store.getPlanRun(fixture.planRun.id);
  if (!current) throw new Error("queued Plan fixture disappeared");
  const heartbeatAt = 2;
  const claimed = await fixture.store.transitionRun({
    id: current.id,
    kind: "plan",
    expectFrom: ["queued"],
    setLeaseToken: leaseToken,
    heartbeatAt,
    run: {
      ...current,
      status: "running",
      startedAt: heartbeatAt,
      heartbeatAt,
      updatedAt: heartbeatAt,
    },
  });
  if (!claimed.won) throw new Error("sibling Plan claim fixture lost");
  const winner = await fixture.store.getPlanRun(current.id);
  if (!winner) throw new Error("sibling Plan claim fixture disappeared");
  return winner;
}

async function renewPlanHeartbeat(
  fixture: QueuedPlanFixture,
  run: PlanRun,
  leaseToken: string,
): Promise<PlanRun> {
  if (run.status !== "running") {
    throw new Error("heartbeat fixture requires a running Plan");
  }
  const heartbeatAt = (run.heartbeatAt ?? 0) + 1;
  const renewed = await fixture.store.transitionRun({
    id: run.id,
    kind: "plan",
    expectFrom: ["running"],
    expectLeaseToken: leaseToken,
    expectHeartbeatAt: run.heartbeatAt ?? null,
    heartbeatAt,
    run: { ...run, heartbeatAt, updatedAt: heartbeatAt },
  });
  if (!renewed.won) throw new Error("sibling Plan heartbeat renewal lost");
  const current = await fixture.store.getPlanRun(run.id);
  if (!current) throw new Error("renewed Plan fixture disappeared");
  return current;
}

async function duringPreclaimPause(
  fixture: QueuedPlanFixture,
  compete: () => Promise<void>,
  gate: { readonly wait: Promise<void>; readonly release: () => void },
): Promise<PlanRun | undefined> {
  const attempt = fixture.controller.runQueuedPlan(fixture.planRun.id);
  try {
    await Promise.race([
      gate.wait,
      attempt.then(() => { throw new Error("consumer completed before report read"); }),
    ]);
    await compete();
  } finally {
    gate.release();
    await attempt;
  }
  return await attempt;
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

type PreclaimFailurePhase =
  | "prepared-inputs"
  | "compatibility-ensure"
  | "compatibility-verification";

async function duringPreclaimFailure(
  fixture: QueuedPlanFixture,
  phase: PreclaimFailurePhase,
  compete: () => Promise<void>,
): Promise<PlanRun | undefined> {
  if (phase === "prepared-inputs") {
    return await duringPreparedInputsFailure(fixture, compete);
  }
  return await duringCompatibilityFailure(
    fixture,
    phase === "compatibility-ensure" ? "ensure" : "verification",
    compete,
  );
}

for (const phase of [
  "prepared-inputs", "compatibility-ensure", "compatibility-verification",
] as const) {
  test(`${phase} error cannot clobber a sibling Plan claim or delete its inputs`, async () => {
    const fixture = await createQueuedPlanFixture();
    let winner: PlanRun | undefined;
    const result = await duringPreclaimFailure(fixture, phase, async () => {
      winner = await claimQueuedSibling(fixture, `sibling-${phase}`);
    });

    expect(winner?.status, phase).toBe("running");
    expect(result, phase).toEqual(winner);
    expect(await fixture.store.getPlanRun(fixture.planRun.id), phase).toEqual(
      winner,
    );
    expect(
      await fixture.store.getPlanRunInputs(fixture.planRun.id),
      phase,
    ).toEqual(fixture.planInputs);
    expect(fixture.runner.planJobs, phase).toHaveLength(0);

    const renewed = await renewPlanHeartbeat(
      fixture,
      winner!,
      `sibling-${phase}`,
    );
    expect(renewed.heartbeatAt, phase).toBe(
      (winner!.heartbeatAt ?? 0) + 1,
    );
  });
}

test("a preclaim error cannot clobber a sibling heartbeat renewal on a stale Plan", async () => {
  const fixture = await createQueuedPlanFixture();
  const claimed = await fixture.store.transitionRun({
    id: fixture.planRun.id,
    kind: "plan",
    expectFrom: ["queued"],
    setLeaseToken: "original-lease",
    heartbeatAt: 1,
    run: {
      ...fixture.planRun,
      status: "running",
      startedAt: 1,
      heartbeatAt: 1,
      updatedAt: 1,
    },
  });
  expect(claimed.won).toBe(true);
  fixture.clock.value = 1_000_000;

  let winner: PlanRun | undefined;
  const result = await duringCompatibilityFailure(
    fixture,
    "ensure",
    async () => {
      const running = await fixture.store.getPlanRun(fixture.planRun.id);
      if (!running) throw new Error("stale Plan fixture disappeared");
      const renewed = await fixture.store.transitionRun({
        id: running.id,
        kind: "plan",
        expectFrom: ["running"],
        expectLeaseToken: "original-lease",
        expectHeartbeatAt: running.heartbeatAt ?? null,
        heartbeatAt: fixture.clock.value,
        run: {
          ...running,
          heartbeatAt: fixture.clock.value,
          updatedAt: fixture.clock.value,
        },
      });
      expect(renewed.won).toBe(true);
      winner = await fixture.store.getPlanRun(running.id);
    },
  );

  expect(winner?.status).toBe("running");
  expect(result).toEqual(winner);
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(winner);
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(
    fixture.planInputs,
  );
  expect(fixture.runner.planJobs).toHaveLength(0);

  const renewed = await renewPlanHeartbeat(
    fixture,
    winner!,
    "original-lease",
  );
  expect(renewed.heartbeatAt).toBe(fixture.clock.value + 1);
});

test("a preclaim error during Workspace drain leaves the queued Plan untouched", async () => {
  const fixture = await createQueuedPlanFixture();
  const result = await duringCompatibilityFailure(
    fixture,
    "ensure",
    async () => {
      const management = await fixture.store.getWorkspaceManagement(
        fixture.planRun.workspaceId,
      );
      if (!management) throw new Error("Workspace management fixture is missing");
      const drained = await fixture.store.beginWorkspaceDraining(
        fixture.planRun.workspaceId,
        {
          workspaceId: fixture.planRun.workspaceId,
          managementState: "active",
          managementEpoch: management.managementEpoch,
        },
      );
      expect(drained.status).toBe("started");
    },
  );

  expect(result?.status).toBe("queued");
  expect(result?.compatibilityReportId).toBeUndefined();
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(
    fixture.planRun,
  );
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(
    fixture.planInputs,
  );
  expect(fixture.runner.planJobs).toHaveLength(0);
});

test("a preclaim error after cancellation keeps the cancelled Plan terminal", async () => {
  const fixture = await createQueuedPlanFixture();
  let cancelled: PlanRun | undefined;
  const result = await duringCompatibilityFailure(
    fixture,
    "ensure",
    async () => {
      await fixture.controller.cancelRun(fixture.planRun.id);
      cancelled = await fixture.store.getPlanRun(fixture.planRun.id);
      expect(cancelled?.status).toBe("cancelled");
    },
  );

  expect(result).toEqual(cancelled);
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(cancelled);
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toBeUndefined();
  expect(fixture.store.inputDeletes).toEqual([fixture.planRun.id]);
  expect(fixture.runner.planJobs).toHaveLength(0);
});

test("a preclaim compatibility failure without a competitor fails and cleans inputs", async () => {
  const fixture = await createQueuedPlanFixture();
  const notifications: string[] = [];
  fixture.controller.setTerminalRunObserver(async (run) => {
    notifications.push(run.status);
  });
  const result = await duringCompatibilityFailure(
    fixture,
    "ensure",
    async () => {},
  );

  expect(result?.status).toBe("failed");
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(result);
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toBeUndefined();
  expect(fixture.runner.planJobs).toHaveLength(0);
  expect(fixture.store.inputDeletes).toEqual([fixture.planRun.id]);
  expect(notifications).toEqual(["failed"]);
});

test("a preclaim error cannot overwrite a started Plan requeued without a heartbeat", async () => {
  const fixture = await createQueuedPlanFixture();
  let winner: PlanRun | undefined;
  const result = await duringCompatibilityFailure(fixture, "ensure", async () => {
    const running = await claimQueuedSibling(fixture, "aba-lease");
    const requeued = await fixture.store.transitionRun({
      id: running.id, kind: "plan", expectFrom: ["running"],
      expectLeaseToken: "aba-lease", clearLeaseToken: true, clearHeartbeat: true,
      run: { ...running, status: "queued", heartbeatAt: undefined, updatedAt: 3 },
    });
    expect(requeued.won).toBe(true);
    winner = await fixture.store.getPlanRun(running.id);
  });
  expect(winner?.startedAt).toBe(2);
  expect(winner?.heartbeatAt).toBeUndefined();
  expect(result).toEqual(winner);
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(winner);
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(fixture.planInputs);
  expect(fixture.store.inputDeletes).toHaveLength(0);
  expect(fixture.runner.planJobs).toHaveLength(0);
});

test("Plan dead-letter failure returns false when a sibling claim wins", async () => {
  const fixture = await createQueuedPlanFixture();
  let winner: PlanRun | undefined;
  const notifications: string[] = [];
  fixture.controller.setTerminalRunObserver(async (run) => {
    notifications.push(run.status);
  });
  fixture.store.afterPlanRead = async () => {
    winner = await claimQueuedSibling(fixture, "dlq-sibling");
  };
  const won = await fixture.controller.markRunFailed("plan", fixture.planRun.id, "delivery_exhausted");
  expect(won).toBe(false);
  expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(winner);
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(fixture.planInputs);
  expect(fixture.store.inputDeletes).toHaveLength(0);
  expect(notifications).toHaveLength(0);
  await renewPlanHeartbeat(fixture, winner!, "dlq-sibling");
});

test("Plan dead-letter failure reports its won transition and deletes inputs once", async () => {
  const fixture = await createQueuedPlanFixture();
  expect(await fixture.controller.markRunFailed("plan", fixture.planRun.id, "delivery_exhausted")).toBe(true);
  expect((await fixture.store.getPlanRun(fixture.planRun.id))?.status).toBe("failed");
  expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toBeUndefined();
  expect(fixture.store.inputDeletes).toEqual([fixture.planRun.id]);
  expect(await fixture.controller.markRunFailed("plan", fixture.planRun.id, "delivery_exhausted")).toBe(false);
  expect(fixture.store.inputDeletes).toEqual([fixture.planRun.id]);
});

for (const outcome of ["success", "failure"] as const) {
  test(`a leased Plan ${outcome} that loses its terminal CAS retains the successor's inputs`, async () => {
    const fixture = await createQueuedPlanFixture();
    let winner: PlanRun | undefined;
    const notifications: string[] = [];
    fixture.controller.setTerminalRunObserver(async (run) => {
      notifications.push(run.status);
    });
    fixture.runner.onPlan = async () => {
      const running = await fixture.store.getPlanRun(fixture.planRun.id);
      if (!running || running.status !== "running") throw new Error("Plan did not claim before dispatch");
      const takeover = await fixture.store.transitionRun({
        id: running.id, kind: "plan", expectFrom: ["running"],
        expectHeartbeatAt: running.heartbeatAt ?? null,
        setLeaseToken: "successor-lease", heartbeatAt: 2,
        run: { ...running, heartbeatAt: 2, updatedAt: 2 },
      });
      expect(takeover.won).toBe(true);
      winner = await fixture.store.getPlanRun(running.id);
      if (outcome === "failure") throw new Error("injected runner failure after lease loss");
    };
    const result = await fixture.controller.runQueuedPlan(fixture.planRun.id);
    expect(winner?.status).toBe("running");
    expect(result).toEqual(winner);
    expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(winner);
    expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(fixture.planInputs);
    expect(fixture.store.inputDeletes).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(fixture.runner.planJobs).toHaveLength(1);
    await renewPlanHeartbeat(fixture, winner!, "successor-lease");
  });
}

test("a won leased Plan failure deletes inputs before notifying, once", async () => {
  const fixture = await createQueuedPlanFixture();
  const notifications: string[] = [];
  fixture.controller.setTerminalRunObserver(async (run) => {
    notifications.push(`${run.status}:${(await fixture.store.getPlanRunInputs(run.id)) === undefined}`);
  });
  fixture.runner.onPlan = async () => { throw new Error("injected runner failure"); };
  const result = await fixture.controller.runQueuedPlan(fixture.planRun.id);
  expect(result?.status).toBe("failed");
  expect(fixture.store.inputDeletes).toEqual([fixture.planRun.id]);
  expect(notifications).toEqual(["failed:true"]);
});

for (const phase of ["preclaim", "leased"] as const) {
  test(`${phase} input cleanup failure does not undo a won Plan failure or suppress notification`, async () => {
    const fixture = await createQueuedPlanFixture();
    fixture.store.failInputDeletion = true;
    const notifications: string[] = [];
    fixture.controller.setTerminalRunObserver(async (run) => { notifications.push(run.status); });
    fixture.runner.onPlan = async () => { throw new Error("injected runner failure"); };
    const result = phase === "preclaim"
      ? await duringCompatibilityFailure(fixture, "ensure", async () => {})
      : await fixture.controller.runQueuedPlan(fixture.planRun.id);
    expect(result?.status).toBe("failed");
    expect(await fixture.store.getPlanRun(fixture.planRun.id)).toEqual(result);
    expect(await fixture.store.getPlanRunInputs(fixture.planRun.id)).toEqual(fixture.planInputs);
    expect(fixture.store.inputDeletes).toEqual([fixture.planRun.id]);
    expect(notifications).toEqual(["failed"]);
  });
}
