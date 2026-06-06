/**
 * §24 stale-propagation integration tests.
 *
 * After a producer apply records an OutputSnapshot whose projected outputs
 * CHANGED versus the producer's previous snapshot, every transitive downstream
 * consumer in the Space that is currently `active` is marked `stale`. An
 * unchanged output marks nothing; a not-yet-applied (`installing`) consumer is
 * left untouched (stale is only meaningful for an already-deployed consumer).
 */

import { expect, test } from "bun:test";
import type { OpenTofuRunner } from "./mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { DependenciesService } from "../dependencies/mod.ts";
import { seedInstallationModel } from "./test_model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function ids(): (prefix: string) => string {
  let n = 1;
  return (p) => `${p}_${String(n++).padStart(8, "0")}`;
}

function nowSeq(start: number): () => number {
  let v = start;
  return () => v++;
}

function runnerEmitting(
  valueByInstallation: ReadonlyMap<string, string>,
): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
      }),
    apply: (job) =>
      Promise.resolve({
        outputs: {
          base_domain: {
            sensitive: false,
            value: valueByInstallation.get(job.planRun.installationId ?? "") ??
              "x.example.com",
          },
        } as never,
        stateDigest:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      }),
    destroy: () => Promise.resolve({}),
  };
}

async function edge(
  store: OpenTofuDeploymentStore,
  producer: string,
  consumer: string,
): Promise<void> {
  const deps = new DependenciesService({
    store,
    newId: (() => {
      let n = 1;
      return (p: string) => `${p}_e${String(n++).padStart(4, "0")}`;
    })(),
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    spaceId: "space_test",
    producerInstallationId: producer,
    consumerInstallationId: consumer,
    mode: "variable_injection",
    visibility: "space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
}

test("a changed producer output marks an active consumer stale", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedInstallationModel(store, {
    environment: "preview",
    sourceId: "src_p",
    snapshotId: "snap_p",
    installConfigId: "cfg_p",
    installationId: "inst_p",
    name: "p",
  });
  await seedInstallationModel(store, {
    environment: "preview",
    sourceId: "src_c",
    snapshotId: "snap_c",
    installConfigId: "cfg_c",
    installationId: "inst_c",
    name: "c",
  });
  await edge(store, "inst_p", "inst_c");

  const controller = new OpenTofuDeploymentController({
    store,
    runner: runnerEmitting(new Map([["inst_p", "v1"], ["inst_c", "c1"]])),
    now: nowSeq(1),
    newId: ids(),
  });

  // Producer + consumer both apply -> both active.
  const applyOf = async (id: string) => {
    const plan = await controller.createInstallationPlan(id);
    await controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
  };
  await applyOf("inst_p");
  await applyOf("inst_c");
  expect((await controller.getInstallation("inst_c")).installation.status)
    .toEqual("active");

  // Producer re-applies with a CHANGED output -> consumer goes stale.
  const changed = new OpenTofuDeploymentController({
    store,
    runner: runnerEmitting(new Map([["inst_p", "v2"], ["inst_c", "c1"]])),
    now: nowSeq(1000),
    newId: (() => {
      let n = 1;
      return (p: string) => `${p}_r${String(n++).padStart(6, "0")}`;
    })(),
  });
  const replan = await changed.createInstallationPlan("inst_p");
  await changed.createApplyRun({
    planRunId: replan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(replan.planRun),
  });
  expect((await changed.getInstallation("inst_c")).installation.status)
    .toEqual("stale");
  // The producer itself stays active.
  expect((await changed.getInstallation("inst_p")).installation.status)
    .toEqual("active");
});

test("a not-yet-applied (installing) consumer is left untouched by a producer change", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedInstallationModel(store, {
    environment: "preview",
    sourceId: "src_p",
    snapshotId: "snap_p",
    installConfigId: "cfg_p",
    installationId: "inst_p",
    name: "p",
  });
  // The consumer is seeded `installing` (fixture default) and never applied.
  await seedInstallationModel(store, {
    environment: "preview",
    sourceId: "src_c",
    snapshotId: "snap_c",
    installConfigId: "cfg_c",
    installationId: "inst_c",
    name: "c",
  });
  await edge(store, "inst_p", "inst_c");

  const controller = new OpenTofuDeploymentController({
    store,
    runner: runnerEmitting(new Map([["inst_p", "v1"]])),
    now: nowSeq(1),
    newId: ids(),
  });
  const applyOf = async (id: string) => {
    const plan = await controller.createInstallationPlan(id);
    await controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
  };
  await applyOf("inst_p"); // gen 1, snapshot v1

  const changed = new OpenTofuDeploymentController({
    store,
    runner: runnerEmitting(new Map([["inst_p", "v2"]])),
    now: nowSeq(1000),
    newId: (() => {
      let n = 1;
      return (p: string) => `${p}_r${String(n++).padStart(6, "0")}`;
    })(),
  });
  const replan = await changed.createInstallationPlan("inst_p");
  await changed.createApplyRun({
    planRunId: replan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(replan.planRun),
  });
  // The consumer never reached `active`, so it is not flagged stale.
  expect((await changed.getInstallation("inst_c")).installation.status)
    .toEqual("installing");
});
