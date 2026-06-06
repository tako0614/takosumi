/**
 * M2 env-driven run integration tests (Core Specification §10.4 / §10.6 / §11).
 *
 * Closes the M2 integration seam: the controller EMITS the dispatch fields the
 * OpenTofu runner DO consumes. These tests assert, via a recording runner, that
 * an Environment-driven plan/apply/destroy carries `stateScope` + `sourceArchive`
 * with the correct generations, that a missing snapshot is a typed 409, that a
 * destroy-plan lands waiting_approval, that an apply persists state at base+1 and
 * records a StateSnapshot, that a changed snapshot is rejected, and — the
 * regression pin — that runs WITHOUT environment context carry no new fields.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
} from "./mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import type { StoredSource } from "./store.ts";
import type { App, Environment, InstallProfile } from "takosumi-contract/lanes";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { PlanRun } from "takosumi-contract/deploy-control-api";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const ARCHIVE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ARCHIVE_KEY =
  "spaces/space_test/sources/src_0001/snapshots/snap_0001/source.tar.zst";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
  readonly destroyJobs: OpenTofuDestroyJob[];
}

function recordingRunner(): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  const destroyJobs: OpenTofuDestroyJob[] = [];
  return {
    planJobs,
    applyJobs,
    destroyJobs,
    plan: (job) => {
      planJobs.push(job);
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        outputs: { url: { sensitive: false, value: "https://x.example" } } as never,
        stateDigest: STATE_DIGEST,
      });
    },
    destroy: (job) => {
      destroyJobs.push(job);
      return Promise.resolve({});
    },
  };
}

async function seedEnvironment(
  store: OpenTofuDeploymentStore,
  options: {
    readonly withSnapshot?: boolean;
    readonly requireApproval?: boolean;
    readonly installProfileId?: string;
    readonly sourceUrl?: string;
    readonly ref?: string;
  } = {},
): Promise<{ app: App; environment: Environment }> {
  const ref = options.ref ?? "main";
  const source: StoredSource = {
    id: "src_0001",
    spaceId: "space_test",
    name: "app",
    url: options.sourceUrl ?? "https://github.com/example/app.git",
    defaultRef: ref,
    defaultPath: ".",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    hookSecretHash: "sha256:deadbeef",
    autoSync: true,
  };
  await store.putSource(source);
  if (options.withSnapshot ?? true) {
    const snapshot: SourceSnapshot = {
      id: "snap_0001",
      sourceId: "src_0001",
      url: source.url,
      ref,
      resolvedCommit: "a".repeat(40),
      path: ".",
      archiveObjectKey: ARCHIVE_KEY,
      archiveDigest: ARCHIVE_DIGEST,
      archiveSizeBytes: 1234,
      fetchedByRunId: "ssr_0001",
      fetchedAt: "2026-06-06T00:01:00.000Z",
    };
    await store.putSourceSnapshot(snapshot);
  }
  const app: App = {
    id: "app_0001",
    spaceId: "space_test",
    name: "app",
    sourceId: "src_0001",
    installType: "opentofu_module",
    ...(options.installProfileId
      ? { installProfileId: options.installProfileId }
      : {}),
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putApp(app);
  const environment: Environment = {
    id: "env_0001",
    appId: "app_0001",
    name: options.requireApproval ? "production" : "preview",
    ref,
    path: ".",
    autoSync: true,
    autoPlan: true,
    autoApply: !options.requireApproval,
    requireApproval: options.requireApproval ?? false,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putEnvironment(environment);
  return { app, environment };
}

function controllerWith(
  store: OpenTofuDeploymentStore,
  runner: OpenTofuRunner,
): OpenTofuDeploymentController {
  return new OpenTofuDeploymentController({
    store,
    runner,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
}

test("env plan dispatch carries sourceArchive + stateScope at the current generation", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedEnvironment(store);
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createEnvironmentPlan("env_0001");

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.sourceSnapshotId).toEqual("snap_0001");
  expect(planRun.environmentContext).toEqual({
    spaceId: "space_test",
    appId: "app_0001",
    environmentId: "env_0001",
  });
  // First plan: no prior StateSnapshot -> base generation 0.
  expect(planRun.baseStateGeneration).toEqual(0);

  expect(runner.planJobs).toHaveLength(1);
  const job = runner.planJobs[0]!;
  expect(job.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: ARCHIVE_DIGEST,
  });
  // Plan restores against the CURRENT generation (0).
  expect(job.stateScope).toEqual({
    spaceId: "space_test",
    appId: "app_0001",
    envId: "env_0001",
    generation: 0,
  });

  // The unified Run facade projects the env context.
  const run = await controller.getRun(planRun.id);
  expect(run.appId).toEqual("app_0001");
  expect(run.environmentId).toEqual("env_0001");
  expect(run.sourceSnapshotId).toEqual("snap_0001");
  expect(run.baseStateGeneration).toEqual(0);
});

test("env plan returns a typed source_sync_required 409 when no snapshot exists", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedEnvironment(store, { withSnapshot: false });
  const controller = controllerWith(store, runner);

  await expect(controller.createEnvironmentPlan("env_0001")).rejects.toMatchObject({
    code: "failed_precondition",
  });
  await expect(controller.createEnvironmentPlan("env_0001")).rejects.toThrow(
    /source_sync_required/,
  );
  expect(runner.planJobs).toHaveLength(0);
});

test("env destroy-plan completes and the unified Run is waiting_approval", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedEnvironment(store);
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createEnvironmentDestroyPlan("env_0001");
  expect(planRun.operation).toEqual("destroy");
  expect(planRun.status).toEqual("succeeded");

  const run = await controller.getRun(planRun.id);
  expect(run.type).toEqual("destroy_plan");
  expect(run.status).toEqual("waiting_approval");

  // The destroy plan dispatch still carries the env state scope + archive.
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.stateScope?.generation).toEqual(0);
  expect(runner.planJobs[0]!.sourceArchive?.objectKey).toEqual(ARCHIVE_KEY);
});

test("env apply emits generation base+1, records a StateSnapshot, and bumps the generation", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedEnvironment(store);
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createEnvironmentPlan("env_0001");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  // Apply persists state at base+1 (= 1).
  expect(runner.applyJobs).toHaveLength(1);
  const applyJob = runner.applyJobs[0]!;
  expect(applyJob.stateScope).toEqual({
    spaceId: "space_test",
    appId: "app_0001",
    envId: "env_0001",
    generation: 1,
  });
  expect(applyJob.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: ARCHIVE_DIGEST,
  });

  // The StateSnapshot is recorded at generation 1 with the runner's digest and
  // the spec R2_STATE object key.
  const latest = await store.getLatestStateSnapshot("env_0001");
  expect(latest?.generation).toEqual(1);
  expect(latest?.digest).toEqual(STATE_DIGEST);
  expect(latest?.objectKey).toEqual(
    "spaces/space_test/apps/app_0001/envs/env_0001/states/00000001.tfstate.enc",
  );
});

test("a second env plan reads the bumped generation and its apply moves to gen 2", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedEnvironment(store);
  const controller = controllerWith(store, runner);

  const first = await controller.createEnvironmentPlan("env_0001");
  await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });

  // Second plan sees the env at generation 1 now.
  const second = await controller.createEnvironmentPlan("env_0001");
  expect(second.planRun.baseStateGeneration).toEqual(1);
  expect(runner.planJobs[1]!.stateScope?.generation).toEqual(1);

  await controller.createApplyRun({
    planRunId: second.planRun.id,
    expected: applyExpectedGuardFromPlanRun(second.planRun),
  });
  expect(runner.applyJobs[1]!.stateScope?.generation).toEqual(2);
  const latest = await store.getLatestStateSnapshot("env_0001");
  expect(latest?.generation).toEqual(2);
});

test("apply is rejected when the plan's SourceSnapshot is no longer present", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedEnvironment(store);
  // The controller and a no-runner controller share the store; create a plan
  // with a runner so it reaches `succeeded`, then mutate the persisted plan to
  // reference a snapshot that does not exist.
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createEnvironmentPlan("env_0001");
  const tampered: PlanRun = {
    ...(await store.getPlanRun(planRun.id))!,
    sourceSnapshotId: "snap_missing",
  };
  await store.putPlanRun(tampered);

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    }),
  ).rejects.toThrow(/source_snapshot/);
});

test("env apply is rejected when the environment state generation advanced since plan", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedEnvironment(store);
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createEnvironmentPlan("env_0001");
  // Simulate a sibling apply advancing the env state generation to 1.
  await store.putStateSnapshot({
    id: "state_sibling",
    appId: "app_0001",
    environmentId: "env_0001",
    generation: 1,
    objectKey: "spaces/space_test/apps/app_0001/envs/env_0001/states/00000001.tfstate.enc",
    digest: STATE_DIGEST,
    createdByRunId: "apply_sibling",
    createdAt: 999,
  });

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    }),
  ).rejects.toThrow(/state_generation_mismatch/);
});

test("env plan uses the install profile's template binding when the App is template-backed", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const profile: InstallProfile = {
    id: "profile_test_r2",
    name: "r2",
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: { bucketName: "b", accountId: "a" },
    outputAllowlist: {},
    policyId: "policy_test_r2",
    templateBinding: { templateId: "cloudflare-r2-bucket", templateVersion: "1.0.0" },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putInstallProfile(profile);
  await seedEnvironment(store, { installProfileId: "profile_test_r2" });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createEnvironmentPlan("env_0001");
  expect(planRun.templateBinding?.templateId).toEqual("cloudflare-r2-bucket");

  // The template dispatch (generated root) AND the env dispatch both ride along.
  expect(runner.planJobs).toHaveLength(1);
  const job = runner.planJobs[0]!;
  expect(job.template?.id).toEqual("cloudflare-r2-bucket");
  expect(job.stateScope?.envId).toEqual("env_0001");
  expect(job.sourceArchive?.objectKey).toEqual(ARCHIVE_KEY);
});

test("REGRESSION: a non-env plan/apply dispatch carries no stateScope or sourceArchive", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: { kind: "git", url: "https://github.com/example/app.git", ref: "main" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.stateScope).toBeUndefined();
  expect(runner.planJobs[0]!.sourceArchive).toBeUndefined();
  expect("stateScope" in runner.planJobs[0]!).toBe(false);
  expect("sourceArchive" in runner.planJobs[0]!).toBe(false);

  expect(runner.applyJobs).toHaveLength(1);
  expect(runner.applyJobs[0]!.stateScope).toBeUndefined();
  expect(runner.applyJobs[0]!.sourceArchive).toBeUndefined();
  expect("stateScope" in runner.applyJobs[0]!).toBe(false);
  expect("sourceArchive" in runner.applyJobs[0]!).toBe(false);

  // No StateSnapshot is recorded for a non-env run.
  const snapshots = await store.listStateSnapshots("env_0001");
  expect(snapshots).toHaveLength(0);
});

test("env destroy-plan apply tears down state at base+1 after approval", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedEnvironment(store);
  const controller = controllerWith(store, runner);

  // Establish a generation-1 state via a create apply first.
  const create = await controller.createEnvironmentPlan("env_0001");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });

  // Destroy-plan, approve, then apply.
  const destroy = await controller.createEnvironmentDestroyPlan("env_0001");
  expect(destroy.planRun.baseStateGeneration).toEqual(1);
  await controller.approveRun(destroy.planRun.id);
  const { applyRun } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  expect(runner.destroyJobs).toHaveLength(1);
  // Teardown persists at base+1 (= 2).
  expect(runner.destroyJobs[0]!.stateScope?.generation).toEqual(2);
  const latest = await store.getLatestStateSnapshot("env_0001");
  expect(latest?.generation).toEqual(2);
});

test("OpenTofuControllerError is surfaced for an unknown environment", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = controllerWith(store, recordingRunner());
  await expect(controller.createEnvironmentPlan("env_missing")).rejects.toBeInstanceOf(
    OpenTofuControllerError,
  );
});
