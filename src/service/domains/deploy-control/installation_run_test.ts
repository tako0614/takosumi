/**
 * Installation-driven run integration tests (Core Specification §19 / §20 / §21
 * / §23).
 *
 * The Space-direct model replaced the App/Environment/InstallProfile lanes: a
 * run targets an existing Installation (seeded via `seedInstallationModel`), and
 * the controller EMITS the dispatch fields the OpenTofu runner DO consumes.
 * These tests assert, via a recording runner, that an installation-driven
 * plan/apply/destroy carries `stateScope { spaceId, installationId, environment,
 * generation }` + `sourceArchive { objectKey, digest }` at the correct
 * generations, that a missing snapshot is a typed `source_sync_required` 409,
 * that a destroy-plan lands waiting_approval, that apply persists state at
 * base+1 and records a StateSnapshot (new R2_STATE keys) + Deployment (§21
 * shape) + marks the Installation active with a bumped generation, that destroy
 * (after approval) persists at base+1 and marks the Installation destroyed, that
 * a second plan reads the bumped generation, and the security invariants: a
 * changed/missing SourceSnapshot at apply is failed_precondition and a stale
 * plan (generation moved) is state_generation_mismatch.
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
import type { PlanRun } from "takosumi-contract/deploy-control-api";
import {
  FIXTURE_ARCHIVE_DIGEST,
  seedInstallationModel,
  type SeedModelOptions,
} from "./test_model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
// The fixture archives the snapshot under this object key (snapshotId snap_fixture).
const ARCHIVE_KEY =
  "spaces/space_test/sources/src_fixture/snapshots/snap_fixture/source.tar.zst";

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
        // `launch_url` is a well-known DeploymentOutput kind so the raw-module
        // PUBLIC projection publishes it (a generic name would be filtered from
        // publicOutputs but still flows to spaceOutputs). `bucket_name` is a
        // generic non-sensitive output: spaceOutputs only. `admin_token` is
        // sensitive-flagged: it must appear in NEITHER projection (invariants
        // 11/12).
        outputs: {
          launch_url: { sensitive: false, value: "https://x.example" },
          bucket_name: { sensitive: false, value: "my-bucket" },
          admin_token: { sensitive: true, value: "super-secret-token" },
        } as never,
        stateDigest: STATE_DIGEST,
        rawOutputsKey:
          "spaces/space_test/installations/inst_fixture/runs/apply_0007/outputs.raw.json.enc",
      });
    },
    destroy: (job) => {
      destroyJobs.push(job);
      return Promise.resolve({});
    },
  };
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

/**
 * Seeds the Space-direct Installation model and returns a wired controller +
 * runner. Defaults to a `preview` environment so the no-approval apply path is
 * exercised; pass `environment: "production"` to land plans waiting_approval.
 */
async function seededController(
  options: SeedModelOptions = {},
): Promise<{
  store: OpenTofuDeploymentStore;
  runner: RecordingRunner;
  controller: OpenTofuDeploymentController;
}> {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedInstallationModel(store, { environment: "preview", ...options });
  const controller = controllerWith(store, runner);
  return { store, runner, controller };
}

test("installation plan dispatch carries sourceArchive + stateScope at the current generation", async () => {
  const { runner, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.sourceSnapshotId).toEqual("snap_fixture");
  expect(planRun.installationContext).toEqual({
    spaceId: "space_test",
    installationId: "inst_fixture",
    environment: "preview",
  });
  // First plan: no prior StateSnapshot -> base generation 0.
  expect(planRun.baseStateGeneration).toEqual(0);

  expect(runner.planJobs).toHaveLength(1);
  const job = runner.planJobs[0]!;
  expect(job.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  // Plan restores against the CURRENT generation (0).
  expect(job.stateScope).toEqual({
    spaceId: "space_test",
    installationId: "inst_fixture",
    environment: "preview",
    generation: 0,
  });

  // The unified Run facade projects the installation context.
  const run = await controller.getRun(planRun.id);
  expect(run.installationId).toEqual("inst_fixture");
  expect(run.environment).toEqual("preview");
  expect(run.sourceSnapshotId).toEqual("snap_fixture");
  expect(run.baseStateGeneration).toEqual(0);
});

test("installation plan returns a typed source_sync_required 409 when no snapshot exists", async () => {
  const { runner, controller } = await seededController({ withoutSnapshot: true });

  await expect(controller.createInstallationPlan("inst_fixture")).rejects.toMatchObject(
    { code: "failed_precondition" },
  );
  await expect(controller.createInstallationPlan("inst_fixture")).rejects.toThrow(
    /source_sync_required/,
  );
  expect(runner.planJobs).toHaveLength(0);
});

test("installation destroy-plan completes and the unified Run is waiting_approval", async () => {
  const { runner, controller } = await seededController();

  const { planRun } = await controller.createInstallationDestroyPlan("inst_fixture");
  expect(planRun.operation).toEqual("destroy");
  expect(planRun.status).toEqual("succeeded");

  // A destroy plan ALWAYS lands waiting_approval (spec §19 two-stage destroy),
  // independent of the environment's approval gate.
  const run = await controller.getRun(planRun.id);
  expect(run.type).toEqual("destroy_plan");
  expect(run.status).toEqual("waiting_approval");

  // The destroy plan dispatch still carries the installation state scope + archive.
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.stateScope?.generation).toEqual(0);
  expect(runner.planJobs[0]!.sourceArchive?.objectKey).toEqual(ARCHIVE_KEY);
});

test("installation apply emits generation base+1, records a StateSnapshot + Deployment, and bumps the generation", async () => {
  const { store, runner, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun, installation, deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  // Apply persists state at base+1 (= 1).
  expect(runner.applyJobs).toHaveLength(1);
  const applyJob = runner.applyJobs[0]!;
  expect(applyJob.stateScope).toEqual({
    spaceId: "space_test",
    installationId: "inst_fixture",
    environment: "preview",
    generation: 1,
  });
  expect(applyJob.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });

  // The StateSnapshot is recorded at generation 1 with the runner's digest and
  // the spec §20 R2_STATE object key (installation-keyed).
  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(latest?.generation).toEqual(1);
  expect(latest?.digest).toEqual(STATE_DIGEST);
  expect(latest?.installationId).toEqual("inst_fixture");
  expect(latest?.environment).toEqual("preview");
  expect(latest?.objectKey).toEqual(
    "spaces/space_test/installations/inst_fixture/envs/preview/states/00000001.tfstate.enc",
  );

  // §21 Deployment: the apply records an active Deployment with the new shape.
  expect(deployment?.status).toEqual("active");
  expect(deployment?.installationId).toEqual("inst_fixture");
  expect(deployment?.environment).toEqual("preview");
  expect(deployment?.applyRunId).toEqual(applyRun.id);
  expect(deployment?.sourceSnapshotId).toEqual("snap_fixture");
  expect(deployment?.stateGeneration).toEqual(1);
  expect(deployment?.outputsPublic).toMatchObject({
    launch_url: "https://x.example",
  });

  // The Installation is marked active with a bumped generation + current deployment.
  expect(installation?.status).toEqual("active");
  expect(installation?.currentStateGeneration).toEqual(1);
  expect(installation?.currentDeploymentId).toEqual(deployment?.id);
});

test("installation apply records an OutputSnapshot and links it on the Deployment + Installation", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { installation, deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  // The OutputSnapshot is recorded and linked from both the Deployment and the
  // Installation's currentOutputSnapshotId.
  expect(deployment?.outputSnapshotId).toBeDefined();
  expect(installation?.currentOutputSnapshotId).toEqual(deployment?.outputSnapshotId);

  const snapshot = await store.getOutputSnapshot(deployment!.outputSnapshotId!);
  expect(snapshot).toBeDefined();
  expect(snapshot?.installationId).toEqual("inst_fixture");
  expect(snapshot?.stateGeneration).toEqual(1);
  // rawOutputArtifactKey is the §26 key the runner DO echoed (rawOutputsKey).
  expect(snapshot?.rawOutputArtifactKey).toEqual(
    "spaces/space_test/installations/inst_fixture/runs/apply_0007/outputs.raw.json.enc",
  );

  // spaceOutputs = ALL non-sensitive outputs from the raw envelope.
  expect(snapshot?.spaceOutputs).toEqual({
    launch_url: "https://x.example",
    bucket_name: "my-bucket",
  });
  // publicOutputs = the existing public projection (what Deployment.outputsPublic
  // carries) — only the well-known launch_url here.
  expect(snapshot?.publicOutputs).toEqual({ launch_url: "https://x.example" });
  expect(snapshot?.publicOutputs).toEqual(
    deployment?.outputsPublic as Record<string, unknown>,
  );

  // The digest is stable + recomputable over { spaceOutputs, publicOutputs }.
  const { stableJsonDigest } = await import("../../adapters/source/digest.ts");
  expect(snapshot?.outputDigest).toEqual(
    await stableJsonDigest({
      spaceOutputs: snapshot!.spaceOutputs,
      publicOutputs: snapshot!.publicOutputs,
    }),
  );

  // getLatestOutputSnapshot resolves the same record.
  const latest = await store.getLatestOutputSnapshot("inst_fixture");
  expect(latest?.id).toEqual(snapshot?.id);
});

test("a sensitive-flagged runner output leaks into NO projection (invariants 11/12)", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun, deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const snapshot = await store.getOutputSnapshot(deployment!.outputSnapshotId!);

  // The sensitive value never appears anywhere in the public projections.
  const serializedSnapshot = JSON.stringify(snapshot);
  expect(serializedSnapshot).not.toContain("admin_token");
  expect(serializedSnapshot).not.toContain("super-secret-token");
  expect(snapshot?.spaceOutputs).not.toHaveProperty("admin_token");
  expect(snapshot?.publicOutputs).not.toHaveProperty("admin_token");

  // Nor on the public Deployment projection.
  const serializedDeployment = JSON.stringify(deployment);
  expect(serializedDeployment).not.toContain("admin_token");
  expect(serializedDeployment).not.toContain("super-secret-token");
  expect(deployment?.outputsPublic).not.toHaveProperty("admin_token");

  // Nor on the public §19 Run projection of the apply run, nor the ApplyRun's
  // own public outputs (the well-known projection drops it).
  const run = await controller.getRun(applyRun.id);
  expect(JSON.stringify(run)).not.toContain("admin_token");
  expect(JSON.stringify(run)).not.toContain("super-secret-token");
  const reread = await controller.getApplyRun(applyRun.id);
  expect(JSON.stringify(reread.applyRun.outputs ?? [])).not.toContain("admin_token");
  expect(JSON.stringify(reread.applyRun.outputs ?? [])).not.toContain(
    "super-secret-token",
  );
});

test("a second installation plan reads the bumped generation and its apply moves to gen 2", async () => {
  const { store, runner, controller } = await seededController();

  const first = await controller.createInstallationPlan("inst_fixture");
  await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });

  // Second plan sees the installation at generation 1 now.
  const second = await controller.createInstallationPlan("inst_fixture");
  expect(second.planRun.baseStateGeneration).toEqual(1);
  expect(runner.planJobs[1]!.stateScope?.generation).toEqual(1);

  await controller.createApplyRun({
    planRunId: second.planRun.id,
    expected: applyExpectedGuardFromPlanRun(second.planRun),
  });
  expect(runner.applyJobs[1]!.stateScope?.generation).toEqual(2);
  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(latest?.generation).toEqual(2);
});

test("apply is rejected when the plan's SourceSnapshot is no longer present", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
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

test("installation apply is rejected when the state generation advanced since plan", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  // Simulate a sibling apply advancing the installation state generation to 1.
  await store.putStateSnapshot({
    id: "state_sibling",
    spaceId: "space_test",
    installationId: "inst_fixture",
    environment: "preview",
    generation: 1,
    objectKey:
      "spaces/space_test/installations/inst_fixture/envs/preview/states/00000001.tfstate.enc",
    digest: STATE_DIGEST,
    createdByRunId: "apply_sibling",
    createdAt: "2026-06-06T00:09:59.000Z",
  });

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    }),
  ).rejects.toThrow(/state_generation_mismatch/);
});

test("installation destroy-plan apply tears down state at base+1 after approval and marks the installation destroyed", async () => {
  const { store, runner, controller } = await seededController();

  // Establish a generation-1 state via a create apply first.
  const create = await controller.createInstallationPlan("inst_fixture");
  const created = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  const createdDeploymentId = created.deployment?.id;

  // Destroy-plan lands waiting_approval; approve, then apply.
  const destroy = await controller.createInstallationDestroyPlan("inst_fixture");
  expect(destroy.planRun.baseStateGeneration).toEqual(1);
  const waiting = await controller.getRun(destroy.planRun.id);
  expect(waiting.status).toEqual("waiting_approval");
  await controller.approveRun(destroy.planRun.id);

  const { applyRun, installation } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  expect(runner.destroyJobs).toHaveLength(1);
  // Teardown persists at base+1 (= 2).
  expect(runner.destroyJobs[0]!.stateScope?.generation).toEqual(2);
  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(latest?.generation).toEqual(2);

  // The Installation is marked destroyed with the current deployment cleared.
  expect(installation?.status).toEqual("destroyed");
  expect(installation?.currentDeploymentId).toBeUndefined();
  expect(installation?.currentStateGeneration).toEqual(2);

  // The previously-active Deployment is marked destroyed (§21 status transition).
  if (createdDeploymentId) {
    const previous = await store.getDeployment(createdDeploymentId);
    expect(previous?.status).toEqual("destroyed");
  }
});

test("the previous active Deployment is superseded on a second successful apply", async () => {
  const { store, controller } = await seededController();

  const first = await controller.createInstallationPlan("inst_fixture");
  const firstApply = await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });
  const firstDeploymentId = firstApply.deployment!.id;

  const second = await controller.createInstallationPlan("inst_fixture");
  const secondApply = await controller.createApplyRun({
    planRunId: second.planRun.id,
    expected: applyExpectedGuardFromPlanRun(second.planRun),
  });

  const previous = await store.getDeployment(firstDeploymentId);
  expect(previous?.status).toEqual("superseded");
  expect(secondApply.deployment?.status).toEqual("active");
  expect(secondApply.deployment?.stateGeneration).toEqual(2);
});

test("OpenTofuControllerError is surfaced for an unknown installation", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = controllerWith(store, recordingRunner());
  await expect(
    controller.createInstallationPlan("inst_missing"),
  ).rejects.toBeInstanceOf(OpenTofuControllerError);
});
