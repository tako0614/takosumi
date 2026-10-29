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
  D1AppOwnershipStore,
  InMemoryAppOwnershipStore,
  SqlAppOwnershipStore,
  type AppOwnershipStore,
} from "../../../../core/domains/app-ownership/store.ts";
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
  DESTROY_PLAN_CREATION_WINDOW_MS,
  finalizeDueCapsuleUninstalls,
  MAX_UNINSTALL_FINALIZE_FAILURES,
  PRE_DESTROY_EXPORT_WINDOW_MS,
  SCHEDULED_UNINSTALL_ACTOR,
  scheduledDestroyRunId,
} from "../../../../core/domains/capsules/uninstall_finalize.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import {
  UNINSTALL_AUTHORIZATION_REASONS,
  UNINSTALL_PAT_EXPIRY_MARGIN_MS,
} from "../../../../core/domains/capsules/uninstall_authorization.ts";
import { InMemoryAccountsStore, validateUninstallRequester } from "@takosjp/takosumi-accounts-service";
import { CAPSULE_LIFECYCLE_COMMAND_CAPABILITY } from "takosumi-contract";
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
  readonly appOwnership: AppOwnershipStore;
  readonly backups: BackupsService;
  readonly activity: ActivityService;
  readonly authorization: { validate: (requester: import("takosumi-contract/capsules").CapsuleUninstallRequester, workspaceId: string, validAtMs?: number) => Promise<boolean> };
  readonly queuedDestroys: import("../../../../core/domains/deploy-control/mod.ts").OpenTofuRunDispatch[];
  readonly credentialMint: { beforeReturn?: () => Promise<void> };
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
    readonly queueDestroy?: boolean;
    readonly preDestroy?: () => Promise<void>;
    readonly uninstallGraceDays?: number;
    readonly ownerless?: boolean;
    readonly appOwnership?: AppOwnershipStore;
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
  if (options.preDestroy) await store.putInstallConfig({
    ...seeded.installConfig,
    lifecycleActions: [{ apiVersion: "takosumi.dev/v1alpha1", kind: "command", id: "cleanup_425",
      phase: "pre_destroy", executor: "operator", command: ["fixture-cleanup"],
      runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY }],
    policy: { lifecycleActions: { allowedExecutors: ["operator"], allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY] } },
  });
  const destroyJobs: OpenTofuDestroyJob[] = [];
  const authorization = { validate: async (_requester: import("takosumi-contract/capsules").CapsuleUninstallRequester, _workspaceId: string, _validAtMs = clock.ms) => true };
  const queuedDestroys: import("../../../../core/domains/deploy-control/mod.ts").OpenTofuRunDispatch[] = [];
  const credentialMint: { beforeReturn?: () => Promise<void> } = {};
  const vault = fakeProviderVault();
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
  const appOwnership = options.appOwnership ?? new InMemoryAppOwnershipStore(store);
  const controller: OpenTofuController = new OpenTofuController({
    store,
    appOwnership,
    activity,
    ...(options.preDestroy ? { releaseActivator: { activate: async () => {
      await options.preDestroy!();
      return { status: "succeeded" as const };
    } } } : {}),
    validateUninstallRequester: (requester, workspaceId) => authorization.validate(requester, workspaceId),
    ...(options.queueDestroy ? { enqueueRun: async (dispatch: import("../../../../core/domains/deploy-control/mod.ts").OpenTofuRunDispatch) => {
      if (dispatch.action === "apply" && (await store.getApplyRun(dispatch.runId))?.operation === "destroy") queuedDestroys.push(dispatch);
      else await controller.dispatchQueuedRun(dispatch);
    } } : {}),
    runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: {
      ...vault,
      mintForCapsuleProviderBindings: async (...args: Parameters<typeof vault.mintForCapsuleProviderBindings>) => {
        const result = await vault.mintForCapsuleProviderBindings(...args);
        await credentialMint.beforeReturn?.();
        return result;
      },
    } as never,
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
    uninstallGraceDays: options.uninstallGraceDays ?? 7,
    validateUninstallRequesterAt: (requester, workspaceId, validAtMs) =>
      authorization.validate(requester, workspaceId, validAtMs),
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
  if (!options.ownerless) {
    expect(await appOwnership.putOwnership({
      capsuleId: seeded.capsule.id,
      ownerAccountId: "user_test",
      ownershipEpoch: 0,
      managementState: "active",
      managementEpoch: 0,
      storageRoot: `apps/${seeded.capsule.id}`,
    }, 0)).toBe(true);
  }

  return Object.assign(harness, {
    store,
    controller,
    capsules,
    appOwnership,
    backups,
    activity,
    clock,
    authorization,
    queuedDestroys,
    credentialMint,
    destroyJobs,
    capsuleId: seeded.capsule.id,
    finalize: (
      overrides: Partial<Parameters<typeof finalizeDueCapsuleUninstalls>[0]> =
        {},
    ) =>
      finalizeDueCapsuleUninstalls({
        store,
        capsules,
        appOwnership,
        controller,
        backups,
        activity,
        now: () => new Date(clock.ms),
        validateUninstallRequester: (requester, workspaceId) => authorization.validate(requester, workspaceId),
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

async function insertRetiredDependency(
  d1: SqliteFakeD1,
  capsuleId: string,
  at: string,
): Promise<void> {
  const legacyDependency = {
    id: "legacy-uninstall-dependency",
    workspaceId: "ws_uninstall001",
    producerCapsuleId: "cap_legacy_producer",
    consumerCapsuleId: capsuleId,
    createdAt: at,
  };
  await d1.prepare(
    `insert into installation_dependencies (
       id, space_id, producer_installation_id, consumer_installation_id,
       record_json, created_at
     ) values (?, ?, ?, ?, ?, ?)`,
  ).bind(
    legacyDependency.id, legacyDependency.workspaceId,
    legacyDependency.producerCapsuleId, legacyDependency.consumerCapsuleId,
    JSON.stringify(legacyDependency), legacyDependency.createdAt,
  ).run();
}

const durableStores: readonly [
  string,
  () => Promise<{ store: OpenTofuControlStore; appOwnership: AppOwnershipStore; close(): Promise<void> }>,
][] = [
  [
    "memory",
    async () => ({
      ...(() => {
        const store = new InMemoryOpenTofuControlStore();
        return { store, appOwnership: new InMemoryAppOwnershipStore(store), close: async () => {} };
      })(),
    }),
  ],
  [
    "postgres",
    async () => {
      const client = await PGliteSqlClient.create();
      const store = new SqlOpenTofuControlStore({ client });
      return {
        store,
        appOwnership: new SqlAppOwnershipStore(client, store),
        close: () => client.close(),
      };
    },
  ],
  [
    "d1",
    async () => {
      const db = new SqliteFakeD1();
      const store = new CloudflareD1OpenTofuControlStore(db);
      return { store, appOwnership: new D1AppOwnershipStore(db, store), close: async () => {} };
    },
  ],
];

for (const [label, open] of durableStores) {
  test(`${label}: a scheduled uninstall survives the grace period, then exports and destroys`, async () => {
    const { store, appOwnership, close } = await open();
    try {
      await scheduledUninstallRunsToCompletion(await appliedCapsule({ store, appOwnership }));
    } finally {
      await close();
    }
  });
  test(`${label}: waiting requests rotate with a frozen clock across finalizer ticks`, async () => {
    const { store, appOwnership, close } = await open();
    try {
      const h = await appliedCapsule({ store, appOwnership });
      await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
      await jumpToDue(h);
      const current = (await store.getCapsule(h.capsuleId))!;
      for (const suffix of ["001", "002", "003"]) {
        await store.putCapsule({
          ...current,
          id: `cap_uninstall${suffix}`,
          name: `waiting-${suffix}`,
          uninstall: {
            ...current.uninstall!,
            id: `uninstall_waiting${suffix}`,
            preDestroyExport: { status: "skipped", at: new Date(h.clock.ms).toISOString() },
            destroyPlanRunId: `plan_waiting${suffix}`,
            destroyPlanRequestedAt: new Date(h.clock.ms).toISOString(),
          },
        });
      }
      const frozen = new Date(h.clock.ms);
      const selected: string[] = [];
      for (let tick = 0; tick < 6; tick += 1) {
        selected.push((await store.listDueCapsuleUninstalls({
          now: frozen.toISOString(), limit: 1,
        }))[0]!.id);
        expect(await finalizeDueCapsuleUninstalls({
          store, capsules: h.capsules, controller: h.controller,
          validateUninstallRequester: async () => true,
          now: () => frozen,
        }, { limit: 1 })).toMatchObject({ scanned: 1, waiting: 1, failures: 0 });
      }
      expect(selected).toEqual([
        "cap_uninstall001", "cap_uninstall002", "cap_uninstall003",
        "cap_uninstall001", "cap_uninstall002", "cap_uninstall003",
      ]);
      expect(h.destroyJobs).toHaveLength(0);
    } finally {
      await close();
    }
  });
}

test("ownerless legacy scheduled uninstall keeps the system Run actor through teardown", async () => {
  const h = await appliedCapsule({ ownerless: true });
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
    requester: { subject: "user_test" },
  });
  expect(scheduled.status).toBe("uninstalled");
  await jumpToDue(h);
  expect(await finalizeDueCapsuleUninstalls({
    store: h.store,
    capsules: h.capsules,
    appOwnership: h.appOwnership,
    controller: h.controller,
    validateUninstallRequester: async () => true,
    now: () => new Date(h.clock.ms),
  })).toMatchObject({
    destroyPlansCreated: 1,
    destroysStarted: 1,
    blocked: 0,
    failures: 0,
  });
  const uninstall = (await h.store.getCapsule(h.capsuleId))!.uninstall!;
  const plan = (await h.store.getPlanRun(uninstall.destroyPlanRunId!))!;
  expect(plan.createdBy).toBe(SCHEDULED_UNINSTALL_ACTOR);
  expect(plan.approval?.approvedBy).toBe(SCHEDULED_UNINSTALL_ACTOR);
  expect(plan.auditEvents).toContainEqual(expect.objectContaining({
    type: "plan.approved",
    actor: SCHEDULED_UNINSTALL_ACTOR,
  }));
  expect(await h.appOwnership.getOwnership(h.capsuleId)).toBeUndefined();
});

async function scheduledUninstallRunsToCompletion(h: Harness): Promise<void> {
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
    actor: "user_test",
    requester: { subject: "user_test" },
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
    (await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } })).uninstall,
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
  expect(plan.createdBy).toBe("user_test");
  expect(plan.approval?.approvedBy).toBe("user_test");
  expect(plan.approval?.reason).toBe(`scheduled uninstall ${uninstall.id}`);
  expect(plan.approval?.approvedAt).toBeGreaterThanOrEqual(
    Date.parse(uninstall.scheduledDestroyAt),
  );
  const approvalAudit = plan.auditEvents.filter((event) =>
    event.type === "plan.approved"
  );
  expect(approvalAudit).toHaveLength(1);
  expect(approvalAudit[0]).toMatchObject({
    actor: "user_test",
    at: plan.approval!.approvedAt,
    data: { approvedBy: "user_test" },
  });
  const approvalActivity = (await h.activity.list("ws_uninstall001", 500))
    .filter((event) => event.action === "run.approved" && event.runId === plan.id);
  expect(approvalActivity).toHaveLength(1);
  expect(approvalActivity[0]).toMatchObject({
    actorId: "user_test",
    metadata: {
      approvedAt: new Date(plan.approval!.approvedAt).toISOString(),
      reason: `scheduled uninstall ${uninstall.id}`,
    },
  });
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
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
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
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
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
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  const cancelled = await h.capsules.cancelCapsuleUninstall(h.capsuleId, {
    actor: "user_test",
    requester: { subject: "user_test" },
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
  const again = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  expect(again.uninstall).toMatchObject({ phase: "scheduled", revision: 3 });
  expect(again.uninstall?.id).not.toBe(cancelled.uninstall?.id);
  expect(again.uninstall?.cancelledAt).toBeUndefined();
});

test("an uninstalled Capsule refuses every operation except its teardown", async () => {
  const h = await appliedCapsule();
  // A Plan reviewed before the uninstall must not provision afterwards.
  const pending = await h.controller.createCapsulePlan(h.capsuleId);
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });

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
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
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

test("retired dependency blocks scheduled teardown without a PlanRun or retry", async () => {
  const d1 = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(d1);
  const h = await appliedCapsule({ store, appOwnership: new D1AppOwnershipStore(d1, store) });
  await insertRetiredDependency(d1, h.capsuleId, new Date(h.clock.ms).toISOString());
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  const planRunIdsBefore = (await h.store.listRunsByWorkspace("ws_uninstall001"))
    .filter((run) => run.type === "plan")
    .map((run) => run.id);

  expect(await h.finalize()).toMatchObject({
    scanned: 1, blocked: 1, failures: 0, destroyPlansCreated: 0,
    destroysStarted: 0,
  });
  const uninstall = (await h.store.getCapsule(h.capsuleId))?.uninstall;
  expect(uninstall).toMatchObject({
    phase: "scheduled", blockedReason: "dependency_retired", destroyAttempts: 1,
  });
  expect(await h.store.getPlanRun(uninstall!.destroyPlanRunId!)).toBeUndefined();
  expect((await h.store.listRunsByWorkspace("ws_uninstall001"))
    .filter((run) => run.type === "plan")
    .map((run) => run.id)).toEqual(planRunIdsBefore);
  expect((await h.store.listActivityEvents("ws_uninstall001", { limit: 100 }))
    .find((event) => event.action === "capsule.uninstall_blocked")?.metadata?.reason)
    .toBe("dependency_retired");
  expect(h.destroyJobs).toHaveLength(0);
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.destroyAttempts).toBe(1);
  expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId)).status).toBe("active");
});

test("retired dependency appearing after teardown Plan blocks Apply before dispatch", async () => {
  const d1 = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(d1);
  const h = await appliedCapsule({ store, appOwnership: new D1AppOwnershipStore(d1, store) });
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
    requester: { subject: "user_test" },
  });
  await jumpToDue(h);
  let planCreates = 0;
  let applyAdmissions = 0;

  const result = await h.finalize({
    controller: {
      createCapsuleDestroyPlan: async (...args) => {
        planCreates += 1;
        const created = await h.controller.createCapsuleDestroyPlan(...args);
        await insertRetiredDependency(d1, h.capsuleId, new Date(h.clock.ms).toISOString());
        return created;
      },
      approveRun: (...args) => h.controller.approveRun(...args),
      createApplyRun: (...args) => {
        applyAdmissions += 1;
        return h.controller.createApplyRun(...args);
      },
    },
  });
  expect(result).toMatchObject({
    scanned: 1, destroyPlansCreated: 1, blocked: 1,
    destroysStarted: 0, failures: 0,
  });
  expect(planCreates).toBe(1);
  expect(applyAdmissions).toBe(1);
  const uninstall = (await h.store.getCapsule(h.capsuleId))?.uninstall;
  expect(uninstall).toMatchObject({
    phase: "destroying", blockedReason: "dependency_retired", destroyAttempts: 1,
  });
  const planId = scheduledDestroyRunId("plan", scheduled.uninstall!.id, 1);
  expect((await h.store.getPlanRun(planId))?.approval?.approvedBy).toBe("user_test");
  expect(await h.store.getApplyRun(scheduledDestroyRunId("apply", scheduled.uninstall!.id, 1)))
    .toBeUndefined();
  expect(h.destroyJobs).toHaveLength(0);
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.destroyAttempts).toBe(1);
});

test("unknown teardown changes are never approved unattended", async () => {
  const h = await appliedCapsule();
  h.destroyPlanChanges = undefined;
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  expect(await h.finalize()).toMatchObject({ blocked: 1 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.blockedReason)
    .toBe("destroy_plan_unverifiable");
  expect(h.destroyJobs).toHaveLength(0);
});

test("once teardown is approved the uninstall can no longer be cancelled", async () => {
  const h = await appliedCapsule();
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
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
  await expect(h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } })).rejects
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

test("restore and InstallConfig rebinding cannot leave the grace state", async () => {
  const h = await appliedCapsule();
  const backup = await h.backups.createBackup({
    workspaceId: "ws_uninstall001",
    capsuleId: h.capsuleId,
    scope: "capsule",
  });
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  const uninstalledReason = {
    details: { reason: CAPSULE_UNINSTALL_REASONS.uninstalled },
  };
  await expect(
    h.controller.createRestoreRun("ws_uninstall001", backup.id, {
      capsuleId: h.capsuleId,
      stateGeneration: 1,
    }),
  ).rejects.toMatchObject(uninstalledReason);
  await expect(
    h.capsules.rebindInstallConfig({
      capsuleId: h.capsuleId,
      targetInstallConfigId: "cfg_other",
      actorSubject: "user_test",
      reason: "change configuration",
      requestDigest: `sha256:${"4".repeat(64)}`,
      expected: {} as never,
    }),
  ).rejects.toMatchObject(uninstalledReason);
  expect((await h.store.getCapsule(h.capsuleId))?.status).toBe("uninstalled");
});

test("an owner-cancelled teardown Plan stops the request instead of re-planning", async () => {
  const h = await appliedCapsule();
  // A non-delete Plan parks the request first, so the owner has a Plan to
  // cancel; then the block is lifted to see what the finalizer does with it.
  h.destroyPlanChanges = undefined;
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  expect(await h.finalize()).toMatchObject({ destroyPlansCreated: 1, blocked: 1 });
  const planRunId = scheduledDestroyRunId("plan", scheduled.uninstall!.id, 1);
  await h.controller.cancelRun(planRunId);
  expect((await h.store.getPlanRun(planRunId))?.status).toBe("cancelled");
  // Simulate the same request without the earlier block (fresh tick state).
  const parked = (await h.store.getCapsule(h.capsuleId))!;
  await h.store.putCapsule({
    ...parked,
    uninstall: { ...parked.uninstall!, blockedReason: undefined },
  });
  expect(await h.finalize()).toMatchObject({ blocked: 1, destroyPlansCreated: 0 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall).toMatchObject({
    destroyAttempts: 1,
    blockedReason: "destroy_plan_cancelled",
  });
  expect(h.destroyJobs).toHaveLength(0);
});

test("cancelling after Apply refusal makes its system-approved teardown permanently inapplicable", async () => {
  const h = await appliedCapsule();
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  let applyCalls = 0;
  const refused = await h.finalize({
    controller: {
      createCapsuleDestroyPlan: (capsuleId, context, internal) =>
        h.controller.createCapsuleDestroyPlan(capsuleId, context, internal),
      approveRun: (id, input) => h.controller.approveRun(id, input),
      createApplyRun: () => {
        applyCalls += 1;
        return Promise.reject(
          new OpenTofuControllerError(
            "failed_precondition",
            "execution authority changed",
            { reason: "capsule_execution_authority_changed" },
          ),
        );
      },
    },
  });
  expect(refused).toMatchObject({ blocked: 1, destroysStarted: 0, failures: 0 });
  expect(applyCalls).toBe(1);
  const blocked = (await h.store.getCapsule(h.capsuleId))!;
  expect(blocked.status).toBe("uninstalled");
  expect(blocked.uninstall).toMatchObject({
    id: scheduled.uninstall!.id,
    phase: "destroying",
    blockedReason: "destroy_apply_refused",
  });
  expect(h.destroyJobs).toHaveLength(0);
  // Nothing reached the provider, so the owner can still keep the service.
  const kept = await h.capsules.cancelCapsuleUninstall(h.capsuleId);
  expect(kept.status).toBe("active");
  expect(kept.uninstall?.phase).toBe("cancelled");
  const oldPlan = (await h.store.getPlanRun(blocked.uninstall!.destroyPlanRunId!))!;
  expect(oldPlan.approval?.approvedBy).toBe("user_test");
  const applyOldPlan = () => h.controller.createApplyRun({
    planRunId: oldPlan.id,
    expected: applyExpectedGuardFromPlanRun(oldPlan),
  });
  await expect(applyOldPlan()).rejects.toMatchObject({
    code: "failed_precondition",
  });
  // A fresh uninstall does not revive the approval for the cancelled request.
  const replacement = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  expect(replacement.uninstall!.id).not.toBe(scheduled.uninstall!.id);
  await expect(applyOldPlan()).rejects.toMatchObject({
    code: "failed_precondition",
  });
  expect(h.destroyJobs).toHaveLength(0);
});

test("overlapping finalizers claim a single export attempt before creating artifacts", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let exports = 0;
  const backups = {
    enabled: true,
    captureManagementAuthority: (id: string) => h.backups.captureManagementAuthority(id),
    createBackup: async (request: Parameters<BackupsService["createBackup"]>[0]) => {
      exports += 1;
      if (exports === 1) {
        started();
        await paused;
      }
      return h.backups.createBackup(request);
    },
  };
  const first = h.finalize({ backups, onError: () => undefined });
  await entered;
  const second = await h.finalize({ backups, onError: () => undefined });
  const beforeRelease = { exports, destroyJobs: h.destroyJobs.length };
  release();
  await first;
  expect(second).toMatchObject({ waiting: 1, destroysStarted: 0, failures: 0 });
  expect(beforeRelease).toEqual({ exports: 1, destroyJobs: 0 });
  expect(exports).toBe(1);
  expect(await h.store.listBackupRecords("ws_uninstall001")).toHaveLength(1);
  expect(h.destroyJobs).toHaveLength(1);
});

test("an export with lost acknowledgement is never retried and blocks unattended destroy", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  expect(await h.finalize({
    capsules: {
      getCapsule: (id) => h.capsules.getCapsule(id),
      advanceCapsuleUninstall: (id, expected, changes) => {
        if (changes.preDestroyExport !== undefined) {
          return Promise.reject(new Error("lost export result acknowledgement"));
        }
        return h.capsules.advanceCapsuleUninstall(id, expected, changes);
      },
    },
    onError: () => undefined,
  })).toMatchObject({ failures: 1, destroysStarted: 0 });
  expect(await h.store.listBackupRecords("ws_uninstall001")).toHaveLength(1);
  expect(await h.finalize()).toMatchObject({ waiting: 1, destroysStarted: 0 });
  h.clock.ms += PRE_DESTROY_EXPORT_WINDOW_MS + 1;
  expect(await h.finalize()).toMatchObject({ blocked: 1, destroysStarted: 0 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.blockedReason)
    .toBe("pre_destroy_export_incomplete");
  expect(await h.store.listBackupRecords("ws_uninstall001")).toHaveLength(1);
  expect(h.destroyJobs).toHaveLength(0);
});

test("an export result survives a waiting-marker race without repeating the export", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  let raced = false;
  const result = await h.finalize({
    capsules: {
      getCapsule: (id) => h.capsules.getCapsule(id),
      advanceCapsuleUninstall: async (id, expected, changes) => {
        if (changes.preDestroyExport !== undefined && !raced) {
          raced = true;
          await h.capsules.advanceCapsuleUninstall(id, expected, {
            lastFinalizeAttemptAt: new Date(h.clock.ms).toISOString(),
          });
        }
        return h.capsules.advanceCapsuleUninstall(id, expected, changes);
      },
    },
  });
  expect(raced).toBe(true);
  expect(result).toMatchObject({ exportsRecorded: 1, destroysStarted: 1, failures: 0 });
  expect(await h.store.listBackupRecords("ws_uninstall001")).toHaveLength(1);
  expect(h.destroyJobs).toHaveLength(1);
});

for (const cancel of [true, false]) {
  test(`a late export after ${cancel ? "cancellation" : "claim timeout"} cannot start teardown`, async () => {
    const h = await appliedCapsule();
    const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
    await jumpToDue(h);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = h.finalize({
      backups: {
        enabled: true,
        captureManagementAuthority: (id) => h.backups.captureManagementAuthority(id),
        createBackup: async (request) => {
          started();
          await paused;
          return h.backups.createBackup(request);
        },
      },
    });
    await entered;
    if (cancel) {
      await h.capsules.cancelCapsuleUninstall(h.capsuleId);
    } else {
      h.clock.ms += PRE_DESTROY_EXPORT_WINDOW_MS + 1;
      expect(await h.finalize()).toMatchObject({ blocked: 1, destroysStarted: 0 });
    }
    release();
    expect(await pending).toMatchObject({ destroysStarted: 0, failures: 0 });
    const capsule = (await h.store.getCapsule(h.capsuleId))!;
    if (cancel) {
      expect(capsule.status).toBe("active");
      expect(capsule.uninstall?.phase).toBe("cancelled");
      expect(capsule.uninstall?.preDestroyExport).toBeUndefined();
    } else {
      expect(capsule.uninstall?.blockedReason).toBe("pre_destroy_export_incomplete");
      expect(capsule.uninstall?.preDestroyExport?.status).toBe("exported");
    }
    const backups = await h.store.listBackupRecords("ws_uninstall001");
    expect(backups).toHaveLength(1);
    expect((await h.activity.list("ws_uninstall001", 500)).find((event) =>
      event.action === "capsule.pre_destroy_export_exported"
    )?.metadata).toMatchObject({
      uninstallId: scheduled.uninstall!.id, backupId: backups[0]!.id,
    });
    expect(h.destroyJobs).toHaveLength(0);
  });
}

test("a Plan made at an older execution epoch is blocked as unverifiable", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  const result = await h.finalize({
    store: {
      listDueCapsuleUninstalls: (input) => h.store.listDueCapsuleUninstalls(input),
      getPlanRun: (id) => h.store.getPlanRun(id),
      getApplyRun: (id) => h.store.getApplyRun(id),
      getWorkspace: (id) => h.store.getWorkspace(id),
      getWorkspaceMember: (workspaceId, subject) => h.store.getWorkspaceMember(workspaceId, subject),
      // As if the InstallConfig was rebound after the Plan was made.
      getCapsuleExecutionAuthorityEpoch: async () => 2,
    },
  });
  expect(result).toMatchObject({ blocked: 1, destroysStarted: 0 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.blockedReason)
    .toBe("destroy_plan_unverifiable");
  expect(h.destroyJobs).toHaveLength(0);
});

test("repeated unexpected errors block one request instead of holding the queue", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  const failingBackups = {
    enabled: true,
    captureManagementAuthority: () =>
      Promise.reject(new Error("backup index unavailable")),
    createBackup: () => Promise.reject(new Error("unused")),
  };
  const errors: unknown[] = [];
  for (let tick = 1; tick < MAX_UNINSTALL_FINALIZE_FAILURES; tick += 1) {
    expect(
      await h.finalize({
        backups: failingBackups,
        onError: (error) => errors.push(error),
      }),
    ).toMatchObject({ failures: 1, blocked: 0 });
  }
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall).toMatchObject({
    finalizeFailures: MAX_UNINSTALL_FINALIZE_FAILURES - 1,
  });
  expect(
    await h.finalize({
      backups: failingBackups,
      onError: (error) => errors.push(error),
    }),
  ).toMatchObject({ failures: 1, blocked: 1 });
  const capsule = (await h.store.getCapsule(h.capsuleId))!;
  expect(capsule.status).toBe("uninstalled");
  expect(capsule.uninstall).toMatchObject({
    phase: "scheduled",
    finalizeFailures: MAX_UNINSTALL_FINALIZE_FAILURES,
    blockedReason: "finalize_failed",
  });
  expect(errors).toHaveLength(MAX_UNINSTALL_FINALIZE_FAILURES);
  // Blocked requests leave the due queue; the owner can still cancel.
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId)).status).toBe(
    "active",
  );
  expect(h.destroyJobs).toHaveLength(0);
});

test("a recorded Plan id is waited for before another attempt is made", async () => {
  const h = await appliedCapsule();
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  let creations = 0;
  const slow = {
    createCapsuleDestroyPlan: () => {
      creations += 1;
      return Promise.reject(new Error("lost acknowledgement"));
    },
    approveRun: (id: string, input: { approvedBy?: string; reason?: string }) =>
      h.controller.approveRun(id, input),
    createApplyRun: () => Promise.reject(new Error("unused")),
  };
  await h.finalize({ controller: slow, onError: () => undefined });
  expect(creations).toBe(1);
  // A concurrent or repeated tick inside the window does not mint attempt 2.
  expect(await h.finalize({ controller: slow })).toMatchObject({ waiting: 1 });
  expect(creations).toBe(1);
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall).toMatchObject({
    destroyAttempts: 1,
    destroyPlanRunId: scheduledDestroyRunId("plan", scheduled.uninstall!.id, 1),
  });
  h.clock.ms += DESTROY_PLAN_CREATION_WINDOW_MS + 1;
  expect(await h.finalize()).toMatchObject({ destroysStarted: 1 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.destroyAttempts)
    .toBe(2);
});

test("cancelling the uninstall cancels the finalizer's unapproved teardown Plan", async () => {
  const h = await appliedCapsule();
  h.destroyPlanChanges = [
    {
      address: "cloudflare_workers_script.app",
      type: "cloudflare_workers_script",
      actions: ["delete", "create"],
    },
  ];
  h.capsules.setUninstallCancellationCleanup(async (planRunId) => {
    const plan = await h.store.getPlanRun(planRunId);
    if (plan?.status === "waiting_approval") {
      await h.controller.cancelRun(planRunId);
    }
  });
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  expect(await h.finalize()).toMatchObject({ blocked: 1 });
  const planRunId = (await h.store.getCapsule(h.capsuleId))!.uninstall!
    .destroyPlanRunId!;
  expect((await h.store.getPlanRun(planRunId))?.status).toBe("waiting_approval");
  await h.capsules.cancelCapsuleUninstall(h.capsuleId);
  expect((await h.store.getPlanRun(planRunId))?.status).toBe("cancelled");
});

test("an exported request says whether app data was part of the export", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  await h.finalize();
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.preDestroyExport)
    .toMatchObject({ status: "exported", includesServiceData: false });
});

for (const [label, open] of durableStores) {
  for (const loss of ["removed", "demoted", "grant_expired", "grant_revoked", "account_deleted", "retained"] as const) {
    test(`${label}: deadline reauthorization refuses ${loss} requester`, async () => {
      const { store, appOwnership, close } = await open();
      try {
        const h = await appliedCapsule({ store, appOwnership });
        const subject = "tsub_uninstall_admin" as const;
        const member = {
          id: "wm_425_admin",
          workspaceId: "ws_uninstall001", accountId: subject,
          roles: ["admin" as const], status: "active" as const,
          createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
        };
        await store.putWorkspaceMember(member);
        const accounts = new InMemoryAccountsStore();
        accounts.saveAccount({ subject, createdAt: START, updatedAt: START });
        const token = {
          tokenId: "pat_425", tokenPrefix: "fixture", subject, name: "scheduled",
          scopes: ["write" as const], workspaceId: member.workspaceId,
          createdAt: START, expiresAt: START + 8 * DAY_MS,
        };
        accounts.savePersonalAccessToken("fixture-bearer-never-persisted", token);
        h.authorization.validate = (requester, workspaceId, validAtMs = h.clock.ms) =>
          validateUninstallRequester(accounts, requester, workspaceId, validAtMs);
        const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
          actor: subject, requester: { subject, grant: { kind: "personal-access-token", tokenId: token.tokenId } },
        });
        expect(scheduled.uninstall?.requester?.subject).toBe(subject);
        const publicRead = await h.controller.getCapsule(h.capsuleId);
        expect(publicRead.capsule.uninstall).not.toHaveProperty("requester");
        expect(JSON.stringify(publicRead)).not.toContain(token.tokenId);
        if (loss === "removed") await store.putWorkspaceMember({ ...member, status: "suspended" });
        if (loss === "demoted") await store.putWorkspaceMember({ ...member, roles: ["viewer"] });
        if (loss === "grant_expired") accounts.savePersonalAccessToken("fixture-bearer-never-persisted", { ...token, expiresAt: START + DAY_MS });
        if (loss === "grant_revoked") await accounts.revokePersonalAccessToken({ subject, tokenId: token.tokenId, revokedAt: START + DAY_MS });
        if (loss === "account_deleted") {
          const missing = Object.create(accounts) as InMemoryAccountsStore;
          missing.findAccount = () => undefined;
          h.authorization.validate = (requester, workspaceId) => validateUninstallRequester(missing, requester, workspaceId, h.clock.ms);
        }
        await jumpToDue(h);
        if (loss === "retained") {
          expect(await h.finalize()).toMatchObject({ destroysStarted: 1, blocked: 0 });
          expect(h.destroyJobs).toHaveLength(1);
          expect((await store.getCapsule(h.capsuleId))?.status).toBe("destroyed");
          return;
        }
        const rejectedAt = new Date(h.clock.ms).toISOString();
        expect(await h.finalize()).toMatchObject({ blocked: 1, exportsRecorded: 0, destroyPlansCreated: 0, destroysStarted: 0, failures: 0 });
        expect(h.destroyJobs).toHaveLength(0);
        expect((await store.getCapsule(h.capsuleId))?.uninstall).toMatchObject({
          phase: "scheduled", blockedReason: UNINSTALL_AUTHORIZATION_REASONS.denied,
          authorizationRejectedAt: rejectedAt,
        });
        const event = (await store.listActivityEvents(member.workspaceId, { limit: 500 })).find((event) => event.action === "capsule.uninstall_blocked");
        expect(event).toMatchObject({ actorId: SCHEDULED_UNINSTALL_ACTOR, metadata: {
          requesterSubject: subject, reason: UNINSTALL_AUTHORIZATION_REASONS.denied,
          rejectedAt,
        } });
        // Restoring authority does not silently revive a refused reservation.
        await store.putWorkspaceMember(member);
        accounts.savePersonalAccessToken("fixture-bearer-never-persisted", token);
        expect(await h.finalize()).toMatchObject({ scanned: 0 });
        expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId)).status).toBe("active");
      } finally { await close(); }
    });
  }
}

for (const [label, open] of durableStores) {
  test(`${label}: a PAT admitted with the six-hour margin blocks on delayed finalization and needs cancel/reschedule`, async () => {
    const { store, appOwnership, close } = await open();
    try {
      const h = await appliedCapsule({ store, appOwnership });
      const subject = "tsub_delayed_uninstall" as const;
      const workspaceId = "ws_uninstall001";
      await store.putWorkspaceMember({
        id: "wm_delayed_uninstall", workspaceId, accountId: subject,
        roles: ["admin"], status: "active",
        createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
      });
      const accounts = new InMemoryAccountsStore();
      accounts.saveAccount({ subject, createdAt: START, updatedAt: START });
      const token = {
        tokenId: "pat_delayed_uninstall", tokenPrefix: "fixture", subject,
        name: "scheduled", scopes: ["write" as const], workspaceId,
        createdAt: h.clock.ms,
        expiresAt: h.clock.ms + 7 * DAY_MS + UNINSTALL_PAT_EXPIRY_MARGIN_MS + 1,
      };
      accounts.savePersonalAccessToken("fixture-original-pat", token);
      h.authorization.validate = (requester, workspace, validAtMs = h.clock.ms) =>
        validateUninstallRequester(accounts, requester, workspace, validAtMs);
      const requester = { subject, grant: { kind: "personal-access-token" as const, tokenId: token.tokenId } };
      const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { actor: subject, requester });
      expect(Date.parse(scheduled.uninstall!.scheduledDestroyAt)).toBe(
        token.expiresAt - UNINSTALL_PAT_EXPIRY_MARGIN_MS - 1,
      );

      // No record mutation: actual time reaches expiry before this delayed tick.
      h.clock.ms = token.expiresAt;
      expect(await h.finalize()).toMatchObject({
        blocked: 1, exportsRecorded: 0, destroyPlansCreated: 0, destroysStarted: 0, failures: 0,
      });
      expect((await store.getCapsule(h.capsuleId))?.uninstall).toMatchObject({
        id: scheduled.uninstall!.id, requester,
        blockedReason: UNINSTALL_AUTHORIZATION_REASONS.denied,
        authorizationRejectedAt: new Date(h.clock.ms).toISOString(),
      });
      expect(h.destroyJobs).toHaveLength(0);

      const replacement = { ...token, tokenId: "pat_replacement_uninstall", expiresAt: h.clock.ms + 8 * DAY_MS };
      accounts.savePersonalAccessToken("fixture-replacement-pat", replacement);
      expect(await h.authorization.validate(requester, workspaceId)).toBe(false);
      expect(await h.finalize()).toMatchObject({ scanned: 0 });
      expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId, { actor: subject })).status).toBe("active");
      const rescheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
        actor: subject,
        requester: { subject, grant: { kind: "personal-access-token", tokenId: replacement.tokenId } },
      });
      expect(rescheduled.uninstall!.id).not.toBe(scheduled.uninstall!.id);
      expect(rescheduled.uninstall!.requester?.grant).toEqual({ kind: "personal-access-token", tokenId: replacement.tokenId });
      expect(Date.parse(rescheduled.uninstall!.scheduledDestroyAt) - h.clock.ms).toBe(7 * DAY_MS);
      expect(rescheduled.uninstall).not.toHaveProperty("blockedReason");
      await jumpToDue(h);
      expect(await h.finalize()).toMatchObject({ destroysStarted: 1, blocked: 0 });
      expect(h.destroyJobs).toHaveLength(1);
    } finally { await close(); }
  });
}

for (const graceDays of [0, 7]) {
  test(`OAuth uninstall admission refuses even a valid grant with ${graceDays} grace days without mutation`, async () => {
    const h = await appliedCapsule({ uninstallGraceDays: graceDays });
    const before = await h.store.getCapsule(h.capsuleId);
    const actionsBefore = await activityActions(h);
    await expect(h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
      actor: "user_test",
      requester: { subject: "user_test", grant: { kind: "oauth-access-token", tokenHash: "fixture-token-hash" } },
    })).rejects.toMatchObject({
      code: "failed_precondition",
      details: { reason: "capsule_uninstall_oauth_unsupported" },
    });
    expect(await h.store.getCapsule(h.capsuleId)).toEqual(before);
    expect(await activityActions(h)).toEqual(actionsBefore);
    expect(await h.finalize()).toMatchObject({ scanned: 0 });
    expect(h.destroyJobs).toHaveLength(0);
  });
}

for (const [label, open] of durableStores) {
  test(`${label}: a requester-less legacy reservation stays blocked until explicit cancel and reschedule`, async () => {
    const { store, appOwnership, close } = await open();
    try {
      const h = await appliedCapsule({ store, appOwnership });
      // Model the existing JSON row, including an actor audit that must not be
      // adopted as requester evidence by the finalizer or a scheduling replay.
      const legacy = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { actor: "user_test" });
      expect(legacy.uninstall).not.toHaveProperty("requester");
      expect(await h.finalize()).toMatchObject({ scanned: 0 });
      await jumpToDue(h);
      const rejectedAt = new Date(h.clock.ms).toISOString();
      expect(await h.finalize()).toMatchObject({
        blocked: 1, exportsRecorded: 0, destroyPlansCreated: 0, destroysStarted: 0, failures: 0,
      });
      const blocked = (await store.getCapsule(h.capsuleId))!;
      expect(blocked).toMatchObject({ status: "uninstalled", uninstall: {
        id: legacy.uninstall!.id, phase: "scheduled",
        blockedReason: UNINSTALL_AUTHORIZATION_REASONS.missing, authorizationRejectedAt: rejectedAt,
      } });
      expect(blocked.currentStateVersionId).toBe(legacy.currentStateVersionId);
      expect(blocked.currentStateGeneration).toBe(legacy.currentStateGeneration);
      expect(await store.listBackupRecords(blocked.workspaceId)).toHaveLength(0);
      const event = (await store.listActivityEvents(blocked.workspaceId, { limit: 500 }))
        .find((event) => event.action === "capsule.uninstall_blocked");
      expect(event).toMatchObject({ actorId: SCHEDULED_UNINSTALL_ACTOR, metadata: {
        uninstallId: legacy.uninstall!.id, reason: UNINSTALL_AUTHORIZATION_REASONS.missing, rejectedAt,
      } });
      expect(event!.metadata).not.toHaveProperty("requesterSubject");
      expect(await h.finalize()).toMatchObject({ scanned: 0 });
      expect(await store.getCapsule(h.capsuleId)).toEqual(blocked);
      const replay = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
        actor: "user_test", requester: { subject: "user_test" },
      });
      expect(replay.uninstall).toEqual(blocked.uninstall);
      expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId, { actor: "user_test" })).status).toBe("active");
      const replacement = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, {
        actor: "user_test", requester: { subject: "user_test" },
      });
      expect(replacement.uninstall!.id).not.toBe(legacy.uninstall!.id);
      expect(replacement.uninstall!.requester).toEqual({ subject: "user_test" });
      expect(replacement.uninstall).not.toHaveProperty("blockedReason");
      expect(replacement.uninstall).not.toHaveProperty("authorizationRejectedAt");
      expect(Date.parse(replacement.uninstall!.scheduledDestroyAt) - h.clock.ms).toBe(7 * DAY_MS);
      expect(await h.finalize()).toMatchObject({ scanned: 0 });
      await jumpToDue(h);
      expect(await h.finalize()).toMatchObject({ destroysStarted: 1, blocked: 0 });
      expect((await store.getCapsule(h.capsuleId))?.status).toBe("destroyed");
      expect(h.destroyJobs).toHaveLength(1);
    } finally { await close(); }
  });
}

test("an existing OAuth reservation blocks after expiry even when a fresh token exists for the same account", async () => {
  const h = await appliedCapsule();
  const subject = "tsub_legacy_uninstall_oauth";
  await h.store.putWorkspaceMember({
    id: "wm_legacy_uninstall_oauth", workspaceId: "ws_uninstall001", accountId: subject,
    roles: ["admin"], status: "active", createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
  });
  const scheduled = await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { actor: subject, requester: { subject } });
  const secret = "fixture-old-oauth-reservation";
  const tokenHash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))).toString("base64url")}`;
  // Seed the historical JSON shape directly: new OAuth reservations cannot be
  // created after this fix, and refreshing must never rewrite this evidence.
  const requester = { subject, grant: { kind: "oauth-access-token" as const, tokenHash } };
  await h.store.putCapsule({ ...scheduled, uninstall: { ...scheduled.uninstall!, requester } });
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({ subject: requester.subject, createdAt: START, updatedAt: START });
  const originalGrant = {
    clientId: "fixture-uninstall-client", subject: "fixture-pairwise",
    takosumiSubject: requester.subject, scope: "capsules:write", workspaceId: scheduled.workspaceId,
    expiresAt: START + 5 * 60_000,
  };
  accounts.saveAccessToken(secret, originalGrant);
  h.authorization.validate = (evidence, workspaceId) => validateUninstallRequester(accounts, evidence, workspaceId, h.clock.ms);
  expect(await h.authorization.validate(requester, scheduled.workspaceId)).toBe(true);
  await jumpToDue(h);
  accounts.saveAccessToken("fixture-refreshed-oauth-token", { ...originalGrant, expiresAt: h.clock.ms + 5 * 60_000 });
  expect(await h.finalize()).toMatchObject({
    blocked: 1, exportsRecorded: 0, destroyPlansCreated: 0, destroysStarted: 0,
  });
  const blocked = (await h.store.getCapsule(h.capsuleId))!;
  expect(blocked.uninstall).toMatchObject({
    requester, blockedReason: UNINSTALL_AUTHORIZATION_REASONS.denied,
    authorizationRejectedAt: new Date(h.clock.ms).toISOString(),
  });
  expect(await h.finalize()).toMatchObject({ scanned: 0 });
  expect(h.destroyJobs).toHaveLength(0);
  expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId, { actor: requester.subject })).status).toBe("active");
});

test("legacy requester and unavailable authorization fail closed with durable audit time", async () => {
  for (const unavailable of ["legacy", "missing_port", "lookup_error"] as const) {
    const h = await appliedCapsule();
    await h.capsules.scheduleCapsuleUninstall(h.capsuleId, unavailable === "legacy" ? {} : { requester: { subject: "user_test" } });
    await jumpToDue(h);
    const overrides = unavailable === "missing_port" ? { validateUninstallRequester: undefined }
      : unavailable === "lookup_error" ? { validateUninstallRequester: async () => { throw new Error("secret-backend-detail"); } } : {};
    expect(await h.finalize(overrides)).toMatchObject({ blocked: 1, destroysStarted: 0 });
    const capsule = await h.store.getCapsule(h.capsuleId);
    expect(capsule?.uninstall?.blockedReason).toBe(unavailable === "legacy" ? UNINSTALL_AUTHORIZATION_REASONS.missing : UNINSTALL_AUTHORIZATION_REASONS.unavailable);
    expect(capsule?.uninstall?.authorizationRejectedAt).toBeDefined();
    expect(JSON.stringify(capsule)).not.toContain("secret-backend-detail");
    expect(h.destroyJobs).toHaveLength(0);
  }
});

test("revocation while approval awaits prevents Apply and leaves cancellation available", async () => {
  const h = await appliedCapsule();
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  expect(await h.finalize({ controller: {
    createCapsuleDestroyPlan: (...args) => h.controller.createCapsuleDestroyPlan(...args),
    approveRun: async (...args) => {
      const result = await h.controller.approveRun(...args);
      h.authorization.validate = async () => false;
      return result;
    },
    createApplyRun: (...args) => h.controller.createApplyRun(...args),
  } })).toMatchObject({ blocked: 1, destroysStarted: 0 });
  expect(h.destroyJobs).toHaveLength(0);
  expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId)).status).toBe("active");
});

test("grant revocation after queue admission refuses provider dispatch and replay", async () => {
  const h = await appliedCapsule({ queueDestroy: true });
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  expect(await h.finalize()).toMatchObject({ destroysStarted: 1 });
  expect(h.queuedDestroys).toHaveLength(1);
  h.authorization.validate = async () => false;
  await h.controller.dispatchQueuedRun(h.queuedDestroys[0]!);
  await h.controller.dispatchQueuedRun(h.queuedDestroys[0]!);
  expect(h.destroyJobs).toHaveLength(0);
  const apply = await h.store.getApplyRun(h.queuedDestroys[0]!.runId);
  expect(apply?.status).toBe("failed");
  const refusal = apply?.auditEvents.find((event) => event.type === "uninstall.authorization_refused");
  expect(refusal?.actor).toBe(SCHEDULED_UNINSTALL_ACTOR);
  expect(refusal?.data).toMatchObject({ actor: SCHEDULED_UNINSTALL_ACTOR, requesterSubject: "user_test", reason: UNINSTALL_AUTHORIZATION_REASONS.denied });
  expect(await h.finalize()).toMatchObject({ blocked: 1 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall).toMatchObject({ blockedReason: UNINSTALL_AUTHORIZATION_REASONS.denied, authorizationRejectedAt: new Date(refusal!.at).toISOString() });
  expect((await h.capsules.cancelCapsuleUninstall(h.capsuleId)).status).toBe("active");
});

test("revocation during awaited provider credential preparation refuses the final destroy dispatch", async () => {
  const h = await appliedCapsule({ queueDestroy: true });
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  expect(await h.finalize()).toMatchObject({ destroysStarted: 1 });
  let revoked = false;
  h.credentialMint.beforeReturn = async () => {
    revoked = true;
    h.authorization.validate = async () => false;
  };
  await h.controller.dispatchQueuedRun(h.queuedDestroys[0]!);
  expect(revoked).toBe(true);
  expect(h.destroyJobs).toHaveLength(0);
  const apply = await h.store.getApplyRun(h.queuedDestroys[0]!.runId);
  expect(apply?.auditEvents).toContainEqual(expect.objectContaining({ type: "uninstall.authorization_refused" }));
  expect(await h.finalize()).toMatchObject({ blocked: 1 });
  expect((await h.store.getCapsule(h.capsuleId))?.uninstall?.blockedReason).toBe(UNINSTALL_AUTHORIZATION_REASONS.denied);
});

test("successful pre-destroy cleanup cannot authorize a new provider destroy after revocation", async () => {
  let cleanupRan = false;
  let revoke: () => void = () => undefined;
  const h = await appliedCapsule({ queueDestroy: true, preDestroy: async () => {
    cleanupRan = true;
    revoke();
  } });
  revoke = () => { h.authorization.validate = async () => false; };
  await h.capsules.scheduleCapsuleUninstall(h.capsuleId, { requester: { subject: "user_test" } });
  await jumpToDue(h);
  expect(await h.finalize()).toMatchObject({ destroysStarted: 1 });
  await h.controller.dispatchQueuedRun(h.queuedDestroys[0]!);
  expect(cleanupRan).toBe(true);
  expect(h.destroyJobs).toHaveLength(0);
  const apply = await h.store.getApplyRun(h.queuedDestroys[0]!.runId);
  expect(apply?.auditEvents).toContainEqual(expect.objectContaining({ type: "lifecycle_action.pre_destroy.succeeded", data: expect.objectContaining({ actionDispatched: true }) }));
  expect(apply?.auditEvents).toContainEqual(expect.objectContaining({ type: "uninstall.authorization_refused", actor: SCHEDULED_UNINSTALL_ACTOR }));
  expect(await h.finalize()).toMatchObject({ blocked: 1 });
  await expect(h.capsules.cancelCapsuleUninstall(h.capsuleId)).rejects.toThrow();
});
