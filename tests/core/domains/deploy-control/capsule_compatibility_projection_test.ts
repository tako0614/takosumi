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
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fakeProviderVault,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const PLAN_ARTIFACT = {
  kind: "runner-local" as const,
  ref: "runner-local://plan/capsule-compatibility-projection",
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

/** Pauses after the preflight row has been read, before the caller projects it. */
class CompatibilityPreflightPauseStore extends InMemoryOpenTofuControlStore {
  private pauseNextRead = false;
  private pauseHintRead = false;
  private readCaptured = deferred<void>();
  private releaseRead = deferred<void>();

  armPreflightReadPause(): void {
    this.pauseNextRead = true;
    this.readCaptured = deferred<void>();
    this.releaseRead = deferred<void>();
  }

  armHintReadPause(): void {
    this.pauseHintRead = true;
    this.readCaptured = deferred<void>();
    this.releaseRead = deferred<void>();
  }

  override async getCapsuleCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const report = await super.getCapsuleCompatibilityReport(id);
    if (this.pauseHintRead) {
      this.pauseHintRead = false;
      this.readCaptured.resolve();
      await this.releaseRead.promise;
    }
    return report;
  }

  waitForPreflightRead(): Promise<void> {
    return this.readCaptured.promise;
  }

  releasePreflightRead(): void {
    this.releaseRead.resolve();
  }

  override async getLatestCapsuleCompatibilityReportForSourceSnapshot(
    sourceSnapshotId: string,
    options: {
      readonly sourceId?: string;
      readonly capsuleId?: string;
    } = {},
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const report =
      await super.getLatestCapsuleCompatibilityReportForSourceSnapshot(
        sourceSnapshotId,
        options,
      );
    if (this.pauseNextRead) {
      this.pauseNextRead = false;
      this.readCaptured.resolve();
      await this.releaseRead.promise;
    }
    return report;
  }
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

function controllerFor(
  store: CompatibilityPreflightPauseStore,
  runner: RecordingRunner,
): OpenTofuController {
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-09-14T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_capsule_compatibility_projection`,
    readCapsuleSourceFiles: () => Promise.resolve([]),
  });
  return new OpenTofuController({
    store,
    runner,
    sourcesService,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    now: () => 1,
    newId: (prefix) => `${prefix}_capsule_compatibility_projection`,
    enqueueRun: () => Promise.resolve(),
  });
}

function readyCompatibilityReport(
  seeded: Awaited<ReturnType<typeof seedCapsuleModel>>,
): CapsuleCompatibilityReport {
  return {
    id: "caprep_capsule_compatibility_projection",
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

async function createFixture(store: CompatibilityPreflightPauseStore) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_capsule_compatibility_projection",
    sourceId: "src_capsule_compatibility_projection",
    snapshotId: "snap_capsule_compatibility_projection",
    installConfigId: "cfg_capsule_compatibility_projection",
    capsuleId: "cap_capsule_compatibility_projection",
    environment: "preview",
    installConfig: { modulePath: "." },
  });
  const report = readyCompatibilityReport(seeded);
  await store.putCapsuleCompatibilityReport(report);
  const capsule = await store.getCapsule(seeded.capsule.id);
  if (!capsule) throw new Error("compatibility projection Capsule is missing");
  if (capsule.compatibilityReportId !== undefined) {
    throw new Error("compatibility projection fixture unexpectedly has reportId");
  }
  return { seeded, report };
}

async function rebindToDifferentModule(
  store: CompatibilityPreflightPauseStore,
  capsuleId: string,
) {
  const capsule = await store.getCapsule(capsuleId);
  if (!capsule) throw new Error("compatibility projection Capsule is missing");
  const previous = await store.getInstallConfig(capsule.installConfigId);
  if (!previous) throw new Error("compatibility projection InstallConfig is missing");
  const executionAuthorityEpoch =
    await store.getCapsuleExecutionAuthorityEpoch(capsule.id);
  if (executionAuthorityEpoch === undefined) {
    throw new Error("compatibility projection Capsule epoch is missing");
  }
  const target = {
    ...previous,
    id: "cfg_capsule_compatibility_projection_rebound",
    name: "capsule-compatibility-projection-rebound",
    modulePath: "modules/rebound",
    createdAt: "2026-09-14T00:00:01.000Z",
    updatedAt: "2026-09-14T00:00:01.000Z",
  };
  await store.putInstallConfig(target);
  const result = await store.rebindCapsuleInstallConfig({
    capsuleId: capsule.id,
    targetInstallConfigId: target.id,
    expected: {
      installConfigId: previous.id,
      installConfigDigest: await stableJsonDigest(previous),
      targetInstallConfigDigest: await stableJsonDigest(target),
      currentStateGeneration: capsule.currentStateGeneration,
      currentStateVersionId: capsule.currentStateVersionId,
      status: capsule.status,
      executionAuthorityEpoch,
    },
    updatedAt: "2026-09-14T00:00:02.000Z",
  });
  if (result.status !== "updated") {
    throw new Error(`compatibility projection rebind failed: ${result.status}`);
  }
  return target;
}

test("createCapsulePlan does not project preflight evidence across an InstallConfig rebind", async () => {
  const store = new CompatibilityPreflightPauseStore();
  const runner = recordingRunner();
  const { seeded, report } = await createFixture(store);
  const controller = controllerFor(store, runner);

  store.armPreflightReadPause();
  const planning = controller.createCapsulePlan(seeded.capsule.id);
  let target: Awaited<ReturnType<typeof rebindToDifferentModule>>;
  try {
    await Promise.race([
      store.waitForPreflightRead(),
      planning.then(() => {
        throw new Error("Plan completed without reaching compatibility preflight");
      }),
    ]);
    target = await rebindToDifferentModule(store, seeded.capsule.id);
  } finally {
    store.releasePreflightRead();
  }

  await expect(planning).rejects.toMatchObject({ code: "failed_precondition" });

  const capsule = await store.getCapsule(seeded.capsule.id);
  expect(capsule?.installConfigId).toBe(target.id);
  expect(capsule?.compatibilityReportId).toBeUndefined();
  expect(capsule?.compatibilityStatus).toBeUndefined();
  expect(await store.getCapsuleCompatibilityReport(report.id)).toEqual(report);
  expect(
    (await store.listRunsByWorkspace(seeded.workspace.id)).filter(
      (run) => run.capsuleId === seeded.capsule.id,
    ),
  ).toHaveLength(0);
  expect(runner.planJobs).toHaveLength(0);
});

test("createCapsulePlan projects matching preflight evidence and leaves one queued Plan", async () => {
  const store = new CompatibilityPreflightPauseStore();
  const runner = recordingRunner();
  const { seeded, report } = await createFixture(store);
  const controller = controllerFor(store, runner);

  const response = await controller.createCapsulePlan(seeded.capsule.id);

  expect(response.planRun.status).toBe("queued");
  expect(response.planRun.compatibilityReportId).toBe(report.id);
  const capsule = await store.getCapsule(seeded.capsule.id);
  expect(capsule?.compatibilityReportId).toBe(report.id);
  expect(capsule?.compatibilityStatus).toBe("ready");
  expect(runner.planJobs).toHaveLength(0);
  expect(
    (await store.listRunsByWorkspace(seeded.workspace.id)).filter(
      (run) => run.capsuleId === seeded.capsule.id,
    ),
  ).toHaveLength(1);
});

for (const selection of ["preflight", "hint"] as const) {
  test(`Capsule lifecycle authority prevents ${selection} compatibility projection during Workspace drain`, async () => {
    const store = new CompatibilityPreflightPauseStore();
    const runner = recordingRunner();
    const { seeded, report } = await createFixture(store);
    const controller = controllerFor(store, runner);
    if (selection === "hint") store.armHintReadPause();
    else store.armPreflightReadPause();
    const planning = controller.createCapsulePlan(
      seeded.capsule.id,
      {},
      selection === "hint" ? { compatibilityReportId: report.id } : {},
    );
    try {
      await Promise.race([
        store.waitForPreflightRead(),
        planning.then(() => {
          throw new Error("Plan completed before the compatibility read");
        }),
      ]);
      expect(await store.beginWorkspaceDraining(seeded.workspace.id, {
        workspaceId: seeded.workspace.id,
        managementState: "active",
        managementEpoch: 1,
      })).toMatchObject({ status: "started" });
    } finally {
      store.releasePreflightRead();
    }
    await expect(planning).rejects.toMatchObject({ code: "failed_precondition" });
    const capsule = await store.getCapsule(seeded.capsule.id);
    expect(capsule?.compatibilityReportId).toBeUndefined();
    expect(capsule?.compatibilityStatus).toBeUndefined();
    // Immutable evidence is independent of the current Capsule pointer.
    expect(await store.getCapsuleCompatibilityReport(report.id)).toEqual(report);
    expect(await store.listRunsByWorkspace(seeded.workspace.id)).toHaveLength(0);
    expect(runner.planJobs).toHaveLength(0);
  });
}
