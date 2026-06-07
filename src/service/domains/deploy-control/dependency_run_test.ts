/**
 * Dependency variable_injection + DependencySnapshot integration tests (Core
 * Specification §15 / §17 / invariant 9).
 *
 * A producer Installation applies (gen 1) and records an OutputSnapshot whose
 * spaceOutputs carry `base_domain`. A consumer Installation declares a
 * `variable_injection` Dependency on that output; its plan injects `base_domain`
 * into the runner variables and pins a DependencySnapshot (digests only, no
 * values in diagnostics). The §19 Run projects the dependencySnapshotId.
 *
 * Then the security behavior: in a PRODUCTION consumer (strict mode), the
 * consumer's apply fails `dependency_snapshot_stale` once the producer's state
 * generation moves after plan; in a PREVIEW consumer (pinned mode) the apply
 * succeeds despite the producer moving, applying the frozen values.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
} from "./mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { DependenciesService } from "../dependencies/mod.ts";
import { seedInstallationModel } from "./test_model_fixture.ts";
import { stableJsonDigest } from "../../adapters/source/digest.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
}

/**
 * A runner whose apply emits `base_domain` (a generic non-sensitive output that
 * lands in spaceOutputs) so a downstream consumer can inject it. Records every
 * plan/apply job so the test can assert the injected variables.
 */
function recordingRunner(): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  return {
    planJobs,
    applyJobs,
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
        // A delete/replace change so the §25 action policy flags the plan
        // requiresApproval -> a production plan parks waiting_approval, keeping
        // the `approveRun` calls in the strict-staleness test valid. Approval is
        // no longer gated by the environment alone. (Preview plans also require
        // approval now, but the preview tests apply directly — apply is not
        // approval-gated.)
        planResourceChanges: [
          {
            address: "module.app.cloudflare_workers_script.this",
            type: "cloudflare_workers_script",
            actions: ["delete", "create"],
          },
        ],
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        outputs: {
          base_domain: { sensitive: false, value: "shota.example.com" },
        } as never,
        stateDigest:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      });
    },
    destroy: () => Promise.resolve({}),
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
 * Seeds a producer + consumer in the same Space (distinct sources/snapshots) at
 * the given environment, plus a `variable_injection` Dependency from producer's
 * `base_domain` to the consumer's `base_domain` input.
 */
async function seedGraph(
  store: OpenTofuDeploymentStore,
  environment: string,
): Promise<{ producer: string; consumer: string }> {
  await seedInstallationModel(store, {
    environment,
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    installationId: "inst_producer",
    name: "producer",
  });
  await seedInstallationModel(store, {
    environment,
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    installationId: "inst_consumer",
    name: "consumer",
  });
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    spaceId: "space_test",
    producerInstallationId: "inst_producer",
    consumerInstallationId: "inst_consumer",
    mode: "variable_injection",
    visibility: "space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  return { producer: "inst_producer", consumer: "inst_consumer" };
}

test("consumer plan injects the producer output and pins a DependencySnapshot", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const { consumer } = await seedGraph(store, "preview");
  const controller = controllerWith(store, runner);

  // Producer applies first -> gen 1 + OutputSnapshot with base_domain.
  const producerPlan = await controller.createInstallationPlan("inst_producer");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const producer = (await controller.getInstallation("inst_producer")).installation;
  expect(producer.currentStateGeneration).toEqual(1);
  expect(producer.currentOutputSnapshotId).toBeDefined();

  // Consumer plan: injects base_domain into the runner variables and pins a snapshot.
  const consumerPlan = await controller.createInstallationPlan(consumer);
  expect(consumerPlan.planRun.dependencySnapshotId).toBeDefined();

  // The runner plan job for the consumer carries the injected variable.
  const consumerPlanJob = runner.planJobs.find(
    (job) => job.planRun.installationId === consumer,
  );
  expect(consumerPlanJob?.variables.base_domain).toEqual("shota.example.com");

  // The DependencySnapshot pins the producer state generation + digests.
  const snapshot = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  expect(snapshot?.mode).toEqual("pinned"); // preview consumer
  expect(snapshot?.dependencies).toHaveLength(1);
  const entry = snapshot!.dependencies[0]!;
  expect(entry.producerInstallationId).toEqual("inst_producer");
  expect(entry.producerStateGeneration).toEqual(1);
  expect(entry.producerOutputSnapshotId).toEqual(producer.currentOutputSnapshotId);
  expect(entry.values).toEqual({ base_domain: "shota.example.com" });
  expect(entry.valuesDigest).toEqual(
    await stableJsonDigest({ base_domain: "shota.example.com" }),
  );

  // The §19 Run projects the dependencySnapshotId.
  const run = await controller.getRun(consumerPlan.planRun.id);
  expect(run.dependencySnapshotId).toEqual(consumerPlan.planRun.dependencySnapshotId);
});

test("strict consumer apply fails dependency_snapshot_stale after the producer moves", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedGraph(store, "production");
  const controller = controllerWith(store, runner);

  // Producer applies -> gen 1. The plan's delete/replace change flags
  // requiresApproval so it parks waiting_approval; approve BEFORE the apply
  // (apply marks the plan applied, clearing the gate).
  const producerPlan = await controller.createInstallationPlan("inst_producer");
  await controller.approveRun(producerPlan.planRun.id);
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  // Consumer plan (production -> strict snapshot).
  const consumerPlan = await controller.createInstallationPlan("inst_consumer");
  const snapshot = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  expect(snapshot?.mode).toEqual("strict");

  // Producer re-applies -> gen 2 (its state generation moves under the snapshot).
  const producerPlan2 = await controller.createInstallationPlan("inst_producer");
  await controller.approveRun(producerPlan2.planRun.id);
  await controller.createApplyRun({
    planRunId: producerPlan2.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan2.planRun),
  });
  expect(
    (await controller.getInstallation("inst_producer")).installation
      .currentStateGeneration,
  ).toEqual(2);

  // The consumer's strict apply now fails dependency_snapshot_stale.
  await controller.approveRun(consumerPlan.planRun.id);
  await expect(
    controller.createApplyRun({
      planRunId: consumerPlan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
    }),
  ).rejects.toThrow(/dependency_snapshot_stale/);
});

test("pinned consumer apply succeeds despite the producer moving", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedGraph(store, "preview");
  const controller = controllerWith(store, runner);

  // Producer applies -> gen 1 (preview: no approval gate).
  const producerPlan = await controller.createInstallationPlan("inst_producer");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  // Consumer plan (preview -> pinned snapshot).
  const consumerPlan = await controller.createInstallationPlan("inst_consumer");
  const snapshot = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  expect(snapshot?.mode).toEqual("pinned");

  // Producer re-applies -> gen 2.
  const producerPlan2 = await controller.createInstallationPlan("inst_producer");
  await controller.createApplyRun({
    planRunId: producerPlan2.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan2.planRun),
  });

  // The consumer's pinned apply tolerates the producer movement and succeeds,
  // applying the values frozen at plan time.
  const consumerApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(consumerApply.applyRun.status).toEqual("succeeded");
  expect(consumerApply.deployment?.dependencySnapshotId).toEqual(
    consumerPlan.planRun.dependencySnapshotId,
  );
});

test("a required dependency with no producer OutputSnapshot is dependency_outputs_unavailable", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedGraph(store, "preview");
  const controller = controllerWith(store, runner);

  // The producer has NOT applied yet, so it has no OutputSnapshot. The consumer
  // plan's required mapping cannot be satisfied.
  await expect(
    controller.createInstallationPlan("inst_consumer"),
  ).rejects.toThrow(/dependency_outputs_unavailable/);
});

test("plan diagnostics never carry injected dependency values", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedGraph(store, "preview");
  const controller = controllerWith(store, runner);

  const producerPlan = await controller.createInstallationPlan("inst_producer");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const consumerPlan = await controller.createInstallationPlan("inst_consumer");

  // The public PlanRun keeps only digests: the injected value must not appear in
  // the variablesDigest field name, audit events, or anywhere on the public run.
  const serialized = JSON.stringify(consumerPlan.planRun);
  expect(serialized).not.toContain("shota.example.com");
});

// ---------------------------------------------------------------------------
// published_output (spec §18): cross-Space output consumption via an OutputShare.
// ---------------------------------------------------------------------------

/**
 * Seeds a producer in `space_producer` + a consumer in `space_consumer`, an
 * ACTIVE OutputShare from the producer's Space to the consumer's Space covering
 * `base_domain`, and a `published_output` cross_space Dependency mapping the
 * SHARED name `base_domain` into the consumer's `base_domain` input.
 */
async function seedCrossSpaceGraph(
  store: OpenTofuDeploymentStore,
  consumerEnvironment: string,
): Promise<{ producer: string; consumer: string }> {
  await seedInstallationModel(store, {
    spaceId: "space_producer",
    environment: "production",
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    installationId: "inst_producer",
    name: "producer",
  });
  await seedInstallationModel(store, {
    spaceId: "space_consumer",
    environment: consumerEnvironment,
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    installationId: "inst_consumer",
    name: "consumer",
  });
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  // Grant first (createDependency for published_output requires an active share).
  await store.putOutputShare({
    id: "oshare_1",
    fromSpaceId: "space_producer",
    toSpaceId: "space_consumer",
    producerInstallationId: "inst_producer",
    outputs: [{ name: "base_domain", sensitive: false }],
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    spaceId: "space_consumer",
    producerInstallationId: "inst_producer",
    consumerInstallationId: "inst_consumer",
    mode: "published_output",
    visibility: "cross_space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  return { producer: "inst_producer", consumer: "inst_consumer" };
}

test("cross-space published_output injects the shared output and pins a snapshot", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const controller = controllerWith(store, runner);

  // Producer applies (in space_producer) -> gen 1 + OutputSnapshot base_domain.
  const producerPlan = await controller.createInstallationPlan("inst_producer");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  // Consumer plan: the published_output edge injects base_domain across the
  // Space boundary (authorized by the active share) and pins a snapshot.
  const consumerPlan = await controller.createInstallationPlan(consumer);
  expect(consumerPlan.planRun.dependencySnapshotId).toBeDefined();
  const consumerPlanJob = runner.planJobs.find(
    (job) => job.planRun.installationId === consumer,
  );
  expect(consumerPlanJob?.variables.base_domain).toEqual("shota.example.com");

  // The consumer applies successfully using the shared value.
  const consumerApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(consumerApply.applyRun.status).toEqual("succeeded");
});

test("revoking the share between plan and apply fails the consumer apply output_share_revoked", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const controller = controllerWith(store, runner);

  const producerPlan = await controller.createInstallationPlan("inst_producer");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  // Consumer plan succeeds while the share is active.
  const consumerPlan = await controller.createInstallationPlan(consumer);
  expect(consumerPlan.planRun.dependencySnapshotId).toBeDefined();

  // Revoke the share AFTER plan, BEFORE apply.
  const share = await store.getOutputShare("oshare_1");
  await store.putOutputShare({
    ...share!,
    status: "revoked",
    revokedAt: "2026-06-06T02:00:00.000Z",
  });

  // The consumer's apply now fails: the published_output edge re-verifies the
  // share at apply, and a revoked grant is output_share_revoked.
  await expect(
    controller.createApplyRun({
      planRunId: consumerPlan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
    }),
  ).rejects.toThrow(/output_share_revoked/);
});

// ---------------------------------------------------------------------------
// remote_state (spec §15): producer state materialized via the depStates dispatch.
// ---------------------------------------------------------------------------

test("remote_state dispatch carries depStates from the producer's latest StateSnapshot", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  // Same-Space producer + consumer with a remote_state edge (empty mapping).
  await seedInstallationModel(store, {
    environment: "preview",
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    installationId: "inst_producer",
    name: "producer",
  });
  await seedInstallationModel(store, {
    environment: "preview",
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    installationId: "inst_consumer",
    name: "consumer",
  });
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    spaceId: "space_test",
    producerInstallationId: "inst_producer",
    consumerInstallationId: "inst_consumer",
    mode: "remote_state",
    visibility: "space",
    outputs: {},
  });
  const controller = controllerWith(store, runner);

  // Producer applies -> records a StateSnapshot (gen 1) the depState points at.
  const producerPlan = await controller.createInstallationPlan("inst_producer");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const producerState = await store.getLatestStateSnapshot(
    "inst_producer",
    "preview",
  );
  expect(producerState?.generation).toEqual(1);

  // Consumer plan: the plan job carries a depState for the producer state.
  const consumerPlan = await controller.createInstallationPlan("inst_consumer");
  const planJob = runner.planJobs.find(
    (job) => job.planRun.installationId === "inst_consumer",
  );
  expect(planJob?.depStates).toBeDefined();
  expect(planJob?.depStates).toHaveLength(1);
  const dep = planJob!.depStates![0]!;
  expect(dep.name).toEqual("producer");
  expect(dep.installationId).toEqual("inst_producer");
  expect(dep.environment).toEqual("preview");
  expect(dep.generation).toEqual(1);
  expect(dep.objectKey).toEqual(producerState!.objectKey);
  expect(dep.digest).toEqual(producerState!.digest);

  // The consumer apply ALSO carries the depState (materialized before apply).
  const consumerApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(consumerApply.applyRun.status).toEqual("succeeded");
  const applyJob = runner.applyJobs.find(
    (job) => job.planRun.installationId === "inst_consumer",
  );
  expect(applyJob?.depStates).toHaveLength(1);
  expect(applyJob!.depStates![0]!.objectKey).toEqual(producerState!.objectKey);
});

test("remote_state dispatch fails dependency_state_unavailable when the producer never applied", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedInstallationModel(store, {
    environment: "preview",
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    installationId: "inst_producer",
    name: "producer",
  });
  await seedInstallationModel(store, {
    environment: "preview",
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    installationId: "inst_consumer",
    name: "consumer",
  });
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    spaceId: "space_test",
    producerInstallationId: "inst_producer",
    consumerInstallationId: "inst_consumer",
    mode: "remote_state",
    visibility: "space",
    outputs: {},
  });
  const controller = controllerWith(store, runner);

  // The producer has NO StateSnapshot (never applied). The consumer plan's
  // depState resolution at dispatch fails dependency_state_unavailable, which the
  // plan consumer records as a failed run (no throw to the caller).
  const consumerPlan = await controller.createInstallationPlan("inst_consumer");
  expect(consumerPlan.planRun.status).toEqual("failed");
  expect(JSON.stringify(consumerPlan.planRun)).toContain(
    "dependency_state_unavailable",
  );
});
