/**
 * Two-stage uninstall end to end on the in-memory ledger with an inline
 * recording runner: grace state, guards, cancel, and the scheduled finalizer
 * (export evidence, delete-only verification, system-approved teardown).
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
  PlanResourceChange,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type RunnerProfile,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import {
  type BackupArtifactStore,
  BackupsService,
  InMemoryBackupArtifactStore,
} from "../../../../core/domains/backups/mod.ts";
import { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import {
  CAPSULE_UNINSTALL_REASONS,
  uninstallGraceSettingFromEnv,
} from "../../../../core/domains/capsules/uninstall.ts";
import {
  finalizeDueCapsuleUninstalls,
  SCHEDULED_UNINSTALL_ACTOR,
  scheduledDestroyRunId,
} from "../../../../core/domains/capsules/uninstall_finalize.ts";
import {
  FIXTURE_CLOUDFLARE_PROVIDER,
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fakeProviderVault,
  fixtureExecutionEvidence,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-13T00:00:00.000Z");
const PLAN_DIGEST = `sha256:${"1".repeat(64)}`;
const LOCK_DIGEST = `sha256:${"2".repeat(64)}`;
const STATE_DIGEST = `sha256:${"3".repeat(64)}`;

function providerInstallation(providers: readonly string[]) {
  return providers.map((provider) => ({
    provider,
    mirrored: true as const,
    installationMethod: "filesystem_mirror" as const,
    attested: true as const,
    attestationMethod: "forced_filesystem_mirror_init" as const,
    mirrorPath: `/opt/opentofu/provider-mirror/${provider}`,
    installedDigest: `sha256:${"e".repeat(64)}` as `sha256:${string}`,
  }));
}

interface Harness {
  readonly store: OpenTofuControlStore;
  readonly controller: OpenTofuController;
  readonly capsules: CapsulesService;
  readonly backups: BackupsService;
  readonly activity: ActivityService;
  readonly clock: { ms: number };
  readonly destroyJobs: OpenTofuDestroyJob[];
  readonly capsuleId: string;
  destroyPlanChanges: readonly PlanResourceChange[] | undefined;
  finalize(
    overrides?: Partial<Parameters<typeof finalizeDueCapsuleUninstalls>[0]>,
  ): ReturnType<typeof finalizeDueCapsuleUninstalls>;
}

async function appliedCapsule(
  options: {
    readonly artifactStore?: BackupArtifactStore;
    readonly store?: OpenTofuControlStore;
  } = {},
): Promise<Harness> {
  const clock = { ms: START };
  const store = options.store ?? new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_uninstall001",
    capsuleId: "cap_uninstall001",
    environment: "preview",
    requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
  });
  await seedProviderConnections(store, seeded.capsule, {
    requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
  });
  const destroyJobs: OpenTofuDestroyJob[] = [];
  const harness = {
    destroyPlanChanges: [
      {
        address: "cloudflare_workers_script.app",
        type: "cloudflare_workers_script",
        actions: ["delete"],
      },
    ] as readonly PlanResourceChange[] | undefined,
  };
  const runner: OpenTofuRunner = {
    plan: (job: OpenTofuPlanJob) =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: providerInstallation(
          job.planRun.requiredProviders,
        ),
        ...(job.planRun.operation === "destroy"
          ? harness.destroyPlanChanges === undefined
            ? {}
            : { planResourceChanges: harness.destroyPlanChanges }
          : {
              planResourceChanges: [
                {
                  address: "cloudflare_workers_script.app",
                  type: "cloudflare_workers_script",
                  actions: ["create"],
                },
              ],
            }),
      }),
    apply: (job: OpenTofuApplyJob) =>
      Promise.resolve({
        outputs: {
          launch_url: { sensitive: false, value: "https://app.example" },
        },
        stateDigest: STATE_DIGEST,
        providerInstallation: providerInstallation(
          job.planRun.requiredProviders,
        ),
        rawOutputRef: job.rawOutputRef,
        executionEvidence: fixtureExecutionEvidence(job, "apply"),
      }),
    destroy: (job: OpenTofuDestroyJob) => {
      destroyJobs.push(job);
      return Promise.resolve({
        stateDigest: STATE_DIGEST,
        providerInstallation: providerInstallation(
          job.planRun.requiredProviders,
        ),
        executionEvidence: fixtureExecutionEvidence(job, "destroy"),
      });
    },
  };
  const profile: RunnerProfile = {
    id: "uninstall-test-runner",
    name: "Uninstall test runner",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    requireProviderBindings: true,
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    networkPolicy: { mode: "operator-managed" },
    secretExposurePolicy: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
    createdAt: 1,
  };
  let nextId = 1;
  const newId = (prefix: string) =>
    `${prefix}_${String(nextId++).padStart(12, "0")}`;
  const activity = new ActivityService({
    store,
    newId,
    now: () => new Date(clock.ms),
  });
  const controller = new OpenTofuController({
    store,
    runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    now: () => clock.ms++,
    newId,
  });
  const capsules = new CapsulesService({
    store,
    activity,
    newId,
    now: () => new Date(clock.ms),
    uninstallGraceDays: 7,
  });
  const backups = new BackupsService({
    store,
    activity,
    newId,
    now: () => new Date(clock.ms),
    artifactStore: options.artifactStore ?? new InMemoryBackupArtifactStore(),
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    stateObjectReader: {
      get: () => Promise.resolve(new TextEncoder().encode("sealed-state")),
    },
  });

  const create = await controller.createCapsulePlan(seeded.capsule.id);
  const applied = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  expect(applied.applyRun.status).toBe("succeeded");
  expect((await store.getCapsule(seeded.capsule.id))?.status).toBe("active");

  return Object.assign(harness, {
    store,
    controller,
    capsules,
    backups,
    activity,
    clock,
    destroyJobs,
    capsuleId: seeded.capsule.id,
    finalize: (
      overrides: Partial<Parameters<typeof finalizeDueCapsuleUninstalls>[0]> =
        {},
    ) =>
      finalizeDueCapsuleUninstalls({
        store,
        capsules,
        controller,
        backups,
        activity,
        now: () => new Date(clock.ms),
        onError: (error) => {
          throw error;
        },
        ...overrides,
      }),
  });
}

async function jumpToDue(harness: Harness, extraMs = 0): Promise<void> {
  const capsule = await harness.store.getCapsule(harness.capsuleId);
  harness.clock.ms =
    Date.parse(capsule!.uninstall!.scheduledDestroyAt) + extraMs;
}

async function activityActions(harness: Harness): Promise<readonly string[]> {
  return (await harness.store.listActivityEvents("ws_uninstall001", {
    limit: 500,
  })).map((event) => event.action);
}

const durableStores: readonly [
  string,
  () => Promise<{ store: OpenTofuControlStore; close(): Promise<void> }>,
][] = [
  [
    "memory",
    async () => ({
      store: new InMemoryOpenTofuControlStore(),
      close: async () => {},
    }),
  ],
  [
    "postgres",
    async () => {
      const client = await PGliteSqlClient.create();
      return {
        store: new SqlOpenTofuControlStore({ client }),
        close: () => client.close(),
      };
    },
  ],
  [
    "d1",
    async () => ({
      store: new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()),
      close: async () => {},
    }),
  ],
];

for (const [label, open] of durableStores) {
  test(`${label}: a scheduled uninstall survives the grace period, then exports and destroys`, async () => {
    const { store, close } = await open();
    try {
      await scheduledUninstallRunsToCompletion(await appliedCapsule({ store }));
    } finally {
      await close();
    }
  });
}

async function scheduledUninstallRunsToCompletion(h: Harness): Promise<void> {
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
    actor: "user_test",
  });
  expect(scheduled.status).toBe("uninstalled");
  expect(scheduled.uninstall).toMatchObject({
    revision: 1,
    phase: "scheduled",
    previousStatus: "active",
  });
  expect(
    Date.parse(scheduled.uninstall!.scheduledDestroyAt) -
      Date.parse(scheduled.uninstall!.requestedAt),
  ).toBe(7 * DAY_MS);
  // Replaying the request keeps the original schedule.
  h.clock.ms += DAY_MS;
  expect(
    (await h.capsules.scheduleCapsuleUninstall(h.capsuleId)).uninstall,
  ).toEqual(scheduled.uninstall);

  // In grace: nothing is due and nothing was torn down.
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  expect(h.destroyJobs).toHaveLength(0);

  await jumpToDue(h, -1);
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  await jumpToDue(h);
  const result = await h.finalize();
  expect(result).toMatchObject({
    scanned: 1,
    exportsRecorded: 1,
    destroyPlansCreated: 1,
    destroysStarted: 1,
    blocked: 0,
    failures: 0,
  });
  expect(h.destroyJobs).toHaveLength(1);

  const destroyed = (await h.store.getCapsule(h.capsuleId))!;
  expect(destroyed.status).toBe("destroyed");
  const uninstall = destroyed.uninstall!;
  expect(uninstall.phase).toBe("destroying");
  expect(uninstall.preDestroyExport?.status).toBe("exported");
  expect(uninstall.destroyPlanRunId).toBe(
    scheduledDestroyRunId("plan", uninstall.id, 1),
  );

  // The export is a Capsule-scoped record in the ordinary backups lane.
  const backups = await h.store.listBackupRecords("ws_uninstall001");
  expect(backups.map((backup) => backup.id)).toEqual([
    uninstall.preDestroyExport!.backupId!,
  ]);
  expect(backups[0]).toMatchObject({ capsuleId: h.capsuleId });
  expect(backups[0]?.stateArchive).toBeDefined();

  // The teardown went through the ordinary approval gate, named for the request.
  const plan = (await h.store.getPlanRun(uninstall.destroyPlanRunId!))!;
  expect(plan.operation).toBe("destroy");
  expect(plan.createdBy).toBe(SCHEDULED_UNINSTALL_ACTOR);
  expect(plan.approval?.approvedBy).toBe(SCHEDULED_UNINSTALL_ACTOR);
  expect(plan.approval?.reason).toBe(`scheduled uninstall ${uninstall.id}`);
  expect(plan.appliedApplyRunId).toBe(
    scheduledDestroyRunId("apply", uninstall.id, 1),
  );

  expect(await activityActions(h)).toEqual(
    expect.arrayContaining([
      "capsule.uninstall_scheduled",
      "capsule.pre_destroy_export_exported",
      "capsule.uninstall_destroy_started",
    ]),
  );
  // A destroyed Capsule is no longer due; later ticks do nothing.
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  expect(h.destroyJobs).toHaveLength(1);
}

test("a failed export is recorded and the teardown still proceeds", async () => {
  const failing: BackupArtifactStore = {
    put: () => Promise.reject(new Error("bucket unavailable")),
  };
  const h = await appliedCapsule({ artifactStore: failing });
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId);
  await jumpToDue(h, 1);
  expect(await h.finalize()).toMatchObject({ destroysStarted: 1, failures: 0 });
  const capsule = (await h.store.getCapsule(h.capsuleId))!;
  expect(capsule.status).toBe("destroyed");
  expect(capsule.uninstall?.preDestroyExport).toMatchObject({
    status: "failed",
    reason: "backup_failed",
  });
  expect(capsule.uninstall?.preDestroyExport?.backupId).toBeUndefined();
  expect(await activityActions(h)).toContain(
    "capsule.pre_destroy_export_failed",
  );
});

test("a host without backup storage records a skipped export and proceeds", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId);
  await jumpToDue(h);
  expect(await h.finalize({ backups: undefined })).toMatchObject({
    destroysStarted: 1,
  });
  const capsule = (await h.store.getCapsule(h.capsuleId))!;
  expect(capsule.status).toBe("destroyed");
  expect(capsule.uninstall?.preDestroyExport).toMatchObject({
    status: "skipped",
    reason: "backups_unavailable",
  });
});

test("cancelling during the grace period restores the Capsule and nothing is destroyed", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId);
  const cancelled = await h.capsules.cancelCapsuleUninstall(h.capsuleId, {
    actor: "user_test",
  });
  expect(cancelled.status).toBe("active");
  expect(cancelled.uninstall).toMatchObject({ phase: "cancelled", revision: 2 });
  // Replay is harmless; a Capsule that is not uninstalled cannot be cancelled.
  expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId)).status).toBe(
    "active",
  );

  h.clock.ms = START + 30 * DAY_MS;
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  expect(h.destroyJobs).toHaveLength(0);
  // Ordinary lifecycle resumes.
  const plan = await h.controller.createCapsulePlan(h.capsuleId);
  expect(plan.planRun.operation).toBe("update");

  // A new request starts a fresh record without the old evidence.
  const again = await h.capsules.scheduleCapsuleUninstall(h.capsuleId);
  expect(again.uninstall).toMatchObject({ phase: "scheduled", revision: 3 });
  expect(again.uninstall?.id).not.toBe(cancelled.uninstall?.id);
  expect(again.uninstall?.cancelledAt).toBeUndefined();
});

test("an uninstalled Capsule refuses every operation except its teardown", async () => {
  const h = await appliedCapsule();
  // A Plan reviewed before the uninstall must not provision afterwards.
  const pending = await h.controller.createCapsulePlan(h.capsuleId);
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId);

  const uninstalledReason = {
    details: { reason: CAPSULE_UNINSTALL_REASONS.uninstalled },
  };
  await expect(h.controller.createCapsulePlan(h.capsuleId)).rejects
    .toMatchObject(uninstalledReason);
  await expect(h.controller.createCapsuleDriftCheck(h.capsuleId)).rejects
    .toMatchObject(uninstalledReason);
  await expect(
    h.controller.createApplyRun({
      planRunId: pending.planRun.id,
      expected: applyExpectedGuardFromPlanRun(pending.planRun),
    }),
  ).rejects.toMatchObject(uninstalledReason);
  await expect(
    h.capsules.patchCapsuleStatus(h.capsuleId, "active"),
  ).rejects.toMatchObject(uninstalledReason);
  await expect(
    h.capsules.patchCapsuleStatus(h.capsuleId, "uninstalled"),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  // "Delete now" stays available: a manual destroy Plan still needs approval.
  const destroyPlan = await h.controller.createCapsuleDestroyPlan(h.capsuleId);
  expect(destroyPlan.planRun.status).toBe("waiting_approval");
  expect(h.destroyJobs).toHaveLength(0);
});

test("a teardown Plan that is not delete-only is left for the owner", async () => {
  const h = await appliedCapsule();
  h.destroyPlanChanges = [
    {
      address: "cloudflare_workers_script.app",
      type: "cloudflare_workers_script",
      actions: ["delete", "create"],
    },
  ];
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId);
  await jumpToDue(h);
  expect(await h.finalize()).toMatchObject({ blocked: 1, destroysStarted: 0 });
  const capsule = (await h.store.getCapsule(h.capsuleId))!;
  expect(capsule.status).toBe("uninstalled");
  expect(capsule.uninstall).toMatchObject({
    phase: "scheduled",
    blockedReason: "destroy_plan_not_delete_only",
  });
  const plan = (await h.store.getPlanRun(capsule.uninstall!.destroyPlanRunId!))!;
  expect(plan.approval).toBeUndefined();
  expect(h.destroyJobs).toHaveLength(0);
  // Blocked requests are not re-read every tick and the owner can still cancel.
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId)).status).toBe(
    "active",
  );
});

test("unknown teardown changes are never approved unattended", async () => {
  const h = await appliedCapsule();
  h.destroyPlanChanges = undefined;
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId);
  await jumpToDue(h);
  expect(await h.finalize()).toMatchObject({ blocked: 1 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.blockedReason)
    .toBe("destroy_plan_unverifiable");
  expect(h.destroyJobs).toHaveLength(0);
});

test("once teardown is approved the uninstall can no longer be cancelled", async () => {
  const h = await appliedCapsule();
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId);
  const advanced = await h.capsules.advanceCapsuleUninstall(
    h.capsuleId,
    { uninstallId: scheduled.uninstall!.id, revision: 1 },
    { phase: "destroying", destroyStartedAt: new Date(h.clock.ms).toISOString() },
  );
  expect(advanced.uninstall?.revision).toBe(2);
  await expect(h.capsules.cancelCapsuleUninstall(h.capsuleId)).rejects
    .toMatchObject({
      details: { reason: CAPSULE_UNINSTALL_REASONS.destroyStarted },
    });
  // A finalizer step that observed the older revision changes nothing.
  await expect(
    h.capsules.advanceCapsuleUninstall(
      h.capsuleId,
      { uninstallId: scheduled.uninstall!.id, revision: 1 },
      { blockedReason: "destroy_plan_failed" },
    ),
  ).rejects.toMatchObject({ details: { reason: "capsule_lifecycle_busy" } });
});

test("only an applied, settled Capsule can enter the grace state", async () => {
  const h = await appliedCapsule();
  await h.capsules.patchCapsuleStatus(h.capsuleId, "disabled");
  await expect(h.capsules.scheduleCapsuleUninstall(h.capsuleId)).rejects
    .toMatchObject({
      details: { reason: CAPSULE_UNINSTALL_REASONS.unavailable },
    });

  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_unapplied001",
    capsuleId: "cap_unapplied001",
  });
  const capsules = new CapsulesService({ store });
  await capsules.patchCapsuleStatus(seeded.capsule.id, "active");
  await expect(capsules.scheduleCapsuleUninstall(seeded.capsule.id)).rejects
    .toMatchObject({
      details: { reason: CAPSULE_UNINSTALL_REASONS.notApplied },
    });
});

test("the grace period comes from TAKOSUMI_UNINSTALL_GRACE_DAYS with a 7 day OSS default", () => {
  expect(uninstallGraceSettingFromEnv({})).toEqual({
    ok: true,
    days: 7,
    configured: false,
  });
  expect(uninstallGraceSettingFromEnv({ TAKOSUMI_UNINSTALL_GRACE_DAYS: " " }))
    .toEqual({ ok: true, days: 7, configured: false });
  expect(uninstallGraceSettingFromEnv({ TAKOSUMI_UNINSTALL_GRACE_DAYS: "0" }))
    .toEqual({ ok: true, days: 0, configured: true });
  expect(uninstallGraceSettingFromEnv({ TAKOSUMI_UNINSTALL_GRACE_DAYS: "30" }))
    .toEqual({ ok: true, days: 30, configured: true });
  for (const value of ["-1", "1.5", "7d", "366", "1e3"]) {
    expect(
      uninstallGraceSettingFromEnv({ TAKOSUMI_UNINSTALL_GRACE_DAYS: value }),
      value,
    ).toEqual({ ok: false, days: 7, value });
  }
  expect(() => new CapsulesService({
    store: new InMemoryOpenTofuControlStore(),
    uninstallGraceDays: 400,
  })).toThrow(RangeError);
});
