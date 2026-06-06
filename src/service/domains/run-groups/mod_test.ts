/**
 * RunGroups service tests (Core Specification §19 / §24 — "RunGroup basic").
 *
 * Covers the pure status computation, the empty-stale-set precondition, and the
 * end-to-end space_update flow over a 3-installation chain
 * (core -> files -> talk): a producer output change cascades stale, plan-update
 * builds a group in topological layers, approve clears the gate, and the group
 * status transitions waiting_approval -> succeeded as members apply through the
 * existing per-run apply flow.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
} from "../deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "../deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { DependenciesService } from "../dependencies/mod.ts";
import { seedInstallationModel } from "../deploy-control/test_model_fixture.ts";
import { computeGroupStatus, RunGroupsService } from "./mod.ts";
import type { Run } from "takosumi-contract/runs";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(8, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}

/**
 * A runner whose apply emits a `base_domain` output. The value is sourced from a
 * per-installation map so a re-apply of the producer can emit a CHANGED value
 * (driving the stale cascade) while the others stay stable.
 */
function recordingRunner(
  outputByInstallation: ReadonlyMap<string, string>,
): OpenTofuRunner & { planJobs: OpenTofuPlanJob[]; applyJobs: OpenTofuApplyJob[] } {
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
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      const installationId = job.planRun.installationId ?? "";
      const value = outputByInstallation.get(installationId) ??
        "default.example.com";
      return Promise.resolve({
        outputs: {
          base_domain: { sensitive: false, value },
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
 * Seeds a 3-installation chain in one Space: core -> files -> talk, each a
 * `variable_injection` consumer of the upstream's `base_domain`. Returns the
 * installation ids in topological order.
 */
async function seedChain(
  store: OpenTofuDeploymentStore,
  environment: string,
): Promise<{ core: string; files: string; talk: string }> {
  for (const name of ["core", "files", "talk"]) {
    await seedInstallationModel(store, {
      environment,
      sourceId: `src_${name}`,
      snapshotId: `snap_${name}`,
      installConfigId: `cfg_${name}`,
      installationId: `inst_${name}`,
      name,
    });
  }
  const deps = new DependenciesService({
    store,
    newId: (() => {
      let n = 1;
      return (prefix: string) => `${prefix}_edge${String(n++).padStart(4, "0")}`;
    })(),
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    spaceId: "space_test",
    producerInstallationId: "inst_core",
    consumerInstallationId: "inst_files",
    mode: "variable_injection",
    visibility: "space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  await deps.createDependency({
    spaceId: "space_test",
    producerInstallationId: "inst_files",
    consumerInstallationId: "inst_talk",
    mode: "variable_injection",
    visibility: "space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  return { core: "inst_core", files: "inst_files", talk: "inst_talk" };
}

/** Applies a preview installation plan to completion (no approval gate). */
async function applyPlan(
  controller: OpenTofuDeploymentController,
  installationId: string,
): Promise<void> {
  const plan = await controller.createInstallationPlan(installationId);
  await controller.createApplyRun({
    planRunId: plan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(plan.planRun),
  });
}

function fakeRun(status: Run["status"]): Run {
  return {
    id: `run_${status}`,
    spaceId: "space_test",
    type: "plan",
    status,
    createdBy: "system",
    createdAt: "2026-06-06T00:00:00.000Z",
  };
}

test("computeGroupStatus precedence: active dominates, then waiting, failed, cancelled, succeeded", () => {
  expect(computeGroupStatus([])).toEqual("succeeded");
  expect(computeGroupStatus([fakeRun("succeeded"), fakeRun("succeeded")]))
    .toEqual("succeeded");
  expect(computeGroupStatus([fakeRun("succeeded"), fakeRun("queued")]))
    .toEqual("running");
  expect(computeGroupStatus([fakeRun("running"), fakeRun("waiting_approval")]))
    .toEqual("running");
  expect(
    computeGroupStatus([fakeRun("succeeded"), fakeRun("waiting_approval")]),
  ).toEqual("waiting_approval");
  // failed beats waiting only when nothing is still active; with a waiting member
  // present and no active member, waiting wins per the precedence order.
  expect(computeGroupStatus([fakeRun("failed"), fakeRun("succeeded")]))
    .toEqual("failed");
  expect(computeGroupStatus([fakeRun("cancelled"), fakeRun("succeeded")]))
    .toEqual("cancelled");
  // failed dominates cancelled when both terminal-negative are present.
  expect(computeGroupStatus([fakeRun("cancelled"), fakeRun("failed")]))
    .toEqual("failed");
});

test("createSpaceUpdate with no stale installations is failed_precondition nothing_to_update", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(new Map());
  await seedChain(store, "preview");
  const controller = controllerWith(store, runner);
  const runGroups = new RunGroupsService({
    store,
    controller,
    newId: deterministicIds(),
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await expect(runGroups.createSpaceUpdate("space_test")).rejects.toThrow(
    /nothing_to_update/,
  );
});

test("producer output change cascades stale to chained consumers (core -> files -> talk)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  // core emits a STABLE value on its first apply, a CHANGED value on re-apply.
  const runner = recordingRunner(
    new Map([
      ["inst_core", "v1.example.com"],
      ["inst_files", "files.example.com"],
      ["inst_talk", "talk.example.com"],
    ]),
  );
  await seedChain(store, "preview");
  const controller = controllerWith(store, runner);

  // Apply the chain bottom-up so each consumer can read its producer's outputs.
  await applyPlan(controller, "inst_core");
  await applyPlan(controller, "inst_files");
  await applyPlan(controller, "inst_talk");
  for (const id of ["inst_core", "inst_files", "inst_talk"]) {
    expect((await controller.getInstallation(id)).installation.status)
      .toEqual("active");
  }

  // core re-applies with a CHANGED output -> its downstream (files, talk) go stale.
  // Swap core's emitted value before the re-apply.
  (runner as { applyJobs: unknown[] }).applyJobs.length = 0;
  const changed = recordingRunner(
    new Map([
      ["inst_core", "v2.example.com"],
      ["inst_files", "files.example.com"],
      ["inst_talk", "talk.example.com"],
    ]),
  );
  const controller2 = new OpenTofuDeploymentController({
    store,
    runner: changed,
    now: sequenceNow(10_000),
    newId: (() => {
      let n = 1;
      return (prefix: string) => `${prefix}_re${String(n++).padStart(6, "0")}`;
    })(),
  });
  await applyPlan(controller2, "inst_core");

  expect((await controller2.getInstallation("inst_core")).installation.status)
    .toEqual("active");
  expect((await controller2.getInstallation("inst_files")).installation.status)
    .toEqual("stale");
  expect((await controller2.getInstallation("inst_talk")).installation.status)
    .toEqual("stale");
});

test("unchanged producer output marks nothing stale", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    new Map([
      ["inst_core", "stable.example.com"],
      ["inst_files", "files.example.com"],
      ["inst_talk", "talk.example.com"],
    ]),
  );
  await seedChain(store, "preview");
  const controller = controllerWith(store, runner);

  await applyPlan(controller, "inst_core");
  await applyPlan(controller, "inst_files");
  await applyPlan(controller, "inst_talk");

  // core re-applies emitting the SAME base_domain -> no stale cascade.
  await applyPlan(controller, "inst_core");
  expect((await controller.getInstallation("inst_files")).installation.status)
    .toEqual("active");
  expect((await controller.getInstallation("inst_talk")).installation.status)
    .toEqual("active");
});

test("space_update e2e: stale -> plan-update group (topo layers) -> approve -> applies -> succeeded", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    new Map([
      ["inst_core", "v1.example.com"],
      ["inst_files", "files.example.com"],
      ["inst_talk", "talk.example.com"],
    ]),
  );
  // Production environment so plans land waiting_approval (drives the group
  // status transition through waiting_approval).
  await seedChain(store, "production");
  const controller = controllerWith(store, runner);

  // Initial bring-up (production needs approval before each apply).
  for (const id of ["inst_core", "inst_files", "inst_talk"]) {
    const plan = await controller.createInstallationPlan(id);
    await controller.approveRun(plan.planRun.id);
    await controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
  }

  // core re-applies with a CHANGED output -> files + talk go stale.
  const changed = new OpenTofuDeploymentController({
    store,
    runner: recordingRunner(
      new Map([
        ["inst_core", "v2.example.com"],
        ["inst_files", "files.example.com"],
        ["inst_talk", "talk.example.com"],
      ]),
    ),
    now: sequenceNow(20_000),
    newId: (() => {
      let n = 1;
      return (prefix: string) => `${prefix}_chg${String(n++).padStart(6, "0")}`;
    })(),
  });
  const corePlan = await changed.createInstallationPlan("inst_core");
  await changed.approveRun(corePlan.planRun.id);
  await changed.createApplyRun({
    planRunId: corePlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(corePlan.planRun),
  });
  expect((await changed.getInstallation("inst_files")).installation.status)
    .toEqual("stale");

  // plan-update: build the RunGroup. files + talk are stale -> members; their
  // topological order is [[files], [talk]] (files produces for talk).
  const runGroups = new RunGroupsService({
    store,
    controller: changed,
    newId: (() => {
      let n = 1;
      return (prefix: string) => `${prefix}_grp${String(n++).padStart(6, "0")}`;
    })(),
    now: () => "2026-06-06T01:00:00.000Z",
  });
  const created = await runGroups.createSpaceUpdate("space_test");
  expect(created.runGroup.type).toEqual("space_update");

  const graph = JSON.parse(created.runGroup.graphJson) as {
    order: string[][];
    runs: Record<string, string>;
  };
  expect(graph.order).toEqual([["inst_files"], ["inst_talk"]]);
  expect(Object.keys(graph.runs).sort()).toEqual(["inst_files", "inst_talk"]);
  // Production members land waiting_approval -> group is waiting_approval.
  expect(created.runGroup.status).toEqual("waiting_approval");
  // Each member Run carries the runGroupId (spec §19).
  for (const run of created.runs) {
    expect(run.runGroupId).toEqual(created.runGroup.id);
  }

  // Approve the whole group: every waiting member is approved, which clears the
  // apply gate. A succeeded + approved plan projects to `succeeded`, so the
  // group's member plan Runs are now all succeeded -> the group is `succeeded`
  // (its members are PLAN runs; the applies are driven separately below).
  const approved = await runGroups.approveRunGroup(created.runGroup.id);
  expect(approved?.runGroup.status).toEqual("succeeded");

  // Drive the producer (files) apply through the existing per-run flow first.
  const filesRunId = graph.runs["inst_files"]!;
  const filesPlan = await changed.getPlanRun(filesRunId);
  await changed.createApplyRun({
    planRunId: filesRunId,
    expected: applyExpectedGuardFromPlanRun(filesPlan.planRun),
  });
  expect((await changed.getInstallation("inst_files")).installation.status)
    .toEqual("active");

  // In production (strict mode) the consumer (talk) was pinned to files' PRIOR
  // state generation; once files advanced, talk's group plan is correctly stale.
  // The spec-correct remedy is a re-plan of talk against the now-current
  // producer state, which then applies cleanly.
  const talkRunId = graph.runs["inst_talk"]!;
  const talkPlanStale = await changed.getPlanRun(talkRunId);
  await expect(
    changed.createApplyRun({
      planRunId: talkRunId,
      expected: applyExpectedGuardFromPlanRun(talkPlanStale.planRun),
    }),
  ).rejects.toThrow(/dependency_snapshot_stale/);

  const talkReplan = await changed.createInstallationPlan("inst_talk");
  await changed.approveRun(talkReplan.planRun.id);
  await changed.createApplyRun({
    planRunId: talkReplan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(talkReplan.planRun),
  });
  expect((await changed.getInstallation("inst_talk")).installation.status)
    .toEqual("active");
});
