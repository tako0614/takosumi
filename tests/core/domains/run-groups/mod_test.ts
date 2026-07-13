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
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { DependenciesService } from "../../../../core/domains/dependencies/mod.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedInstallationModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import {
  computeGroupStatus,
  RunGroupsService,
} from "../../../../core/domains/run-groups/mod.ts";
import type { Run } from "takosumi-contract/runs";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

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
): OpenTofuRunner & {
  planJobs: OpenTofuPlanJob[];
  applyJobs: OpenTofuApplyJob[];
} {
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
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        // A replace (delete+create) change so the §25 action policy flags the
        // plan requiresApproval. This drives the RunGroup status transition
        // through `waiting_approval` (approval is no longer gated by the
        // environment alone — it follows the plan's actual changes). The apply
        // path is not approval-gated, so the preview `applyPlan` helper still
        // applies without an explicit approve.
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
      const installationId = job.planRun.installationId ?? "";
      const value =
        outputByInstallation.get(installationId) ?? "default.example.com";
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
    vault: fakeProviderVault() as never,
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
    const seeded = await seedInstallationModel(store, {
      environment,
      sourceId: `src_${name}`,
      snapshotId: `snap_${name}`,
      installConfigId: `cfg_${name}`,
      installationId: `inst_${name}`,
      name,
      ...(name === "core" || name === "files"
        ? {
            installConfig: {
              outputAllowlist: {
                base_domain: {
                  from: "base_domain",
                  type: "hostname",
                  required: true,
                },
              },
            },
          }
        : {}),
    });
    await seedProviderConnections(store, seeded.installation);
  }
  const deps = new DependenciesService({
    store,
    newId: (() => {
      let n = 1;
      return (prefix: string) =>
        `${prefix}_edge${String(n++).padStart(4, "0")}`;
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
  expect(
    computeGroupStatus([fakeRun("succeeded"), fakeRun("succeeded")]),
  ).toEqual("succeeded");
  expect(computeGroupStatus([fakeRun("succeeded"), fakeRun("queued")])).toEqual(
    "running",
  );
  expect(
    computeGroupStatus([fakeRun("running"), fakeRun("waiting_approval")]),
  ).toEqual("running");
  expect(
    computeGroupStatus([fakeRun("succeeded"), fakeRun("waiting_approval")]),
  ).toEqual("waiting_approval");
  // failed beats waiting only when nothing is still active; with a waiting member
  // present and no active member, waiting wins per the precedence order.
  expect(computeGroupStatus([fakeRun("failed"), fakeRun("succeeded")])).toEqual(
    "failed",
  );
  expect(
    computeGroupStatus([fakeRun("cancelled"), fakeRun("succeeded")]),
  ).toEqual("cancelled");
  // failed dominates cancelled when both terminal-negative are present.
  expect(computeGroupStatus([fakeRun("cancelled"), fakeRun("failed")])).toEqual(
    "failed",
  );
});

test("createSpaceUpdate maps a wedged (cyclic) dependency graph to failed_precondition, not an uncaught 500", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  // Seed two installations in one Space and mark BOTH stale so they enter the
  // space_update member set.
  for (const name of ["alpha", "beta"]) {
    const { installation } = await seedInstallationModel(store, {
      environment: "preview",
      sourceId: `src_${name}`,
      snapshotId: `snap_${name}`,
      installConfigId: `cfg_${name}`,
      installationId: `inst_${name}`,
      name,
    });
    await store.putInstallation({ ...installation, status: "stale" });
  }
  // Inject an inverse-edge cycle directly (the create path prevents cycles, so a
  // wedge can only pre-exist). alpha -> beta AND beta -> alpha.
  await store.putDependency({
    id: "dep_cycle_1",
    spaceId: "space_test",
    producerInstallationId: "inst_alpha",
    consumerInstallationId: "inst_beta",
    mode: "variable_injection",
    visibility: "space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putDependency({
    id: "dep_cycle_2",
    spaceId: "space_test",
    producerInstallationId: "inst_beta",
    consumerInstallationId: "inst_alpha",
    mode: "variable_injection",
    visibility: "space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
    createdAt: "2026-06-06T00:00:00.000Z",
  });

  const controller = controllerWith(store, recordingRunner(new Map()));
  const runGroups = new RunGroupsService({
    store,
    controller,
    newId: deterministicIds(),
    now: () => "2026-06-06T00:00:00.000Z",
  });

  // The wedged DAG would make `topologicalLayers` throw a GraphCycleError; the
  // service must translate it into a typed failed_precondition (not a bare 500).
  await expect(runGroups.createSpaceUpdate("space_test")).rejects.toMatchObject(
    {
      code: "failed_precondition",
    },
  );
  await expect(runGroups.createSpaceUpdate("space_test")).rejects.toThrow(
    /dependency_cycle/,
  );
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
    expect((await controller.getInstallation(id)).installation.status).toEqual(
      "active",
    );
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
    vault: fakeProviderVault() as never,
    now: sequenceNow(10_000),
    newId: (() => {
      let n = 1;
      return (prefix: string) => `${prefix}_re${String(n++).padStart(6, "0")}`;
    })(),
  });
  await applyPlan(controller2, "inst_core");

  expect(
    (await controller2.getInstallation("inst_core")).installation.status,
  ).toEqual("active");
  expect(
    (await controller2.getInstallation("inst_files")).installation.status,
  ).toEqual("stale");
  expect(
    (await controller2.getInstallation("inst_talk")).installation.status,
  ).toEqual("stale");
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
  expect(
    (await controller.getInstallation("inst_files")).installation.status,
  ).toEqual("active");
  expect(
    (await controller.getInstallation("inst_talk")).installation.status,
  ).toEqual("active");
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
  // The runner emits a delete/replace change so the §25 action policy flags
  // each plan requiresApproval -> the members land waiting_approval (drives the
  // group status transition through waiting_approval). The environment no
  // longer gates approval on its own.
  await seedChain(store, "production");
  const controller = controllerWith(store, runner);

  // Initial bring-up (each plan requires approval before its apply).
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
    vault: fakeProviderVault() as never,
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
  expect(
    (await changed.getInstallation("inst_files")).installation.status,
  ).toEqual("stale");

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
  expect(
    (await changed.getInstallation("inst_files")).installation.status,
  ).toEqual("active");

  // In production (strict mode) the consumer (talk) was pinned to files' PRIOR
  // state generation; once files advanced, talk's group plan is correctly stale.
  // The spec-correct remedy is a re-plan of talk against the now-current
  // producer state, which then applies cleanly.
  const talkRunId = graph.runs["inst_talk"]!;
  const talkPlanStale = await changed.getPlanRun(talkRunId);
  const staleTalkApply = await changed.createApplyRun({
    planRunId: talkRunId,
    expected: applyExpectedGuardFromPlanRun(talkPlanStale.planRun),
  });
  expect(staleTalkApply.applyRun.status).toBe("failed");
  expect(staleTalkApply.applyRun.diagnostics?.[0]?.message).toContain(
    "dependency_snapshot_stale",
  );

  const talkReplan = await changed.createInstallationPlan("inst_talk");
  await changed.approveRun(talkReplan.planRun.id);
  await changed.createApplyRun({
    planRunId: talkReplan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(talkReplan.planRun),
  });
  expect(
    (await changed.getInstallation("inst_talk")).installation.status,
  ).toEqual("active");
});

test("space_drift_check groups active installations into read-only drift_check runs", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    new Map([
      ["inst_core", "core.example.com"],
      ["inst_files", "files.example.com"],
      ["inst_talk", "talk.example.com"],
    ]),
  );
  await seedChain(store, "preview");
  const controller = controllerWith(store, runner);

  for (const id of ["inst_core", "inst_files", "inst_talk"]) {
    await applyPlan(controller, id);
  }

  const runGroups = new RunGroupsService({
    store,
    controller,
    newId: (() => {
      let n = 1;
      return (prefix: string) =>
        `${prefix}_drift${String(n++).padStart(5, "0")}`;
    })(),
    now: () => "2026-06-06T02:00:00.000Z",
  });
  const created = await runGroups.createSpaceDriftCheck("space_test", {
    limit: 2,
  });

  expect(created.runGroup.type).toEqual("space_drift_check");
  expect(created.runs).toHaveLength(2);
  expect(created.runs.every((run) => run.type === "drift_check")).toBe(true);
  expect(
    created.runs.every((run) => run.runGroupId === created.runGroup.id),
  ).toBe(true);
  expect(created.runs.every((run) => run.status === "succeeded")).toBe(true);

  const graph = JSON.parse(created.runGroup.graphJson) as {
    order: string[][];
    runs: Record<string, string>;
  };
  expect(Object.keys(graph.runs).sort()).toEqual(["inst_core", "inst_files"]);
});

test("workspace_output_sync plans and applies one dependency layer at a time", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    new Map([
      ["inst_core", "core.example.com"],
      ["inst_files", "files.example.com"],
      ["inst_talk", "talk.example.com"],
    ]),
  );
  await seedChain(store, "production");
  const controller = controllerWith(store, runner);
  for (const id of ["inst_core", "inst_files", "inst_talk"]) {
    const plan = await controller.createInstallationPlan(id);
    await controller.approveRun(plan.planRun.id);
    await controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
  }
  const appliedCore = await store.getInstallation("inst_core");
  const appliedCoreDeployment = await store.getDeployment(
    appliedCore!.currentDeploymentId!,
  );
  await store.putSourceSnapshot({
    ...(await store.getSourceSnapshot("snap_core"))!,
    id: "snap_core_newer",
    resolvedCommit: "ffffffffffffffffffffffffffffffffffffffff",
    archiveObjectKey:
      "spaces/space_test/sources/src_core/snapshots/snap_core_newer/source.tar.zst",
    fetchedAt: "2026-06-06T02:59:00.000Z",
  });

  const groups = new RunGroupsService({
    store,
    controller,
    newId: () => "rg_output_sync",
    now: () => "2026-06-06T03:00:00.000Z",
  });
  const created = await groups.createWorkspaceOutputSync(
    "space_test",
    7,
    1,
    "rg_output_sync",
  );
  expect(created.runGroup.type).toBe("workspace_output_sync");
  let graph = JSON.parse(created.runGroup.graphJson) as {
    currentLayer: number;
    order: string[][];
    runs: Record<string, string>;
    sourceSnapshotIds: Record<string, string>;
  };
  expect(graph.order).toEqual([["inst_core"], ["inst_files"], ["inst_talk"]]);
  expect(Object.keys(graph.runs)).toEqual(["inst_core"]);
  expect(graph.sourceSnapshotIds).toEqual({
    inst_core: appliedCoreDeployment!.sourceSnapshotId,
    inst_files: "snap_files",
    inst_talk: "snap_talk",
  });
  const firstPlan = await store.getPlanRun(graph.runs.inst_core!);
  expect(firstPlan?.sourceSnapshotId).toBe(
    appliedCoreDeployment!.sourceSnapshotId,
  );

  // Crash-recovery window: the plan row exists but its id was not checkpointed
  // into graphJson. Recovery must rediscover it by runGroupId + Capsule rather
  // than enqueueing a duplicate plan.
  const planCallsBeforeRecovery = runner.planJobs.length;
  const stored = await store.getRunGroup(created.runGroup.id);
  await store.putRunGroup({
    ...stored!,
    graphJson: JSON.stringify({ ...graph, runs: {} }),
  });
  const recovered = await groups.advanceWorkspaceOutputSync(
    created.runGroup.id,
  );
  expect(runner.planJobs.length).toBe(planCallsBeforeRecovery);
  expect(recovered?.runGroup.status).toBe("waiting_approval");

  await groups.approveRunGroup(created.runGroup.id);
  let current = await groups.getRunGroup(created.runGroup.id);
  graph = JSON.parse(current!.runGroup.graphJson);
  expect(graph.currentLayer).toBe(1);
  expect(Object.keys(graph.runs).sort()).toEqual(["inst_core", "inst_files"]);

  await groups.approveRunGroup(created.runGroup.id);
  current = await groups.getRunGroup(created.runGroup.id);
  graph = JSON.parse(current!.runGroup.graphJson);
  expect(graph.currentLayer).toBe(2);
  expect(Object.keys(graph.runs).sort()).toEqual([
    "inst_core",
    "inst_files",
    "inst_talk",
  ]);

  await groups.approveRunGroup(created.runGroup.id);
  current = await groups.getRunGroup(created.runGroup.id);
  expect(current!.runGroup.status).toBe("succeeded");
  expect(
    (await controller.getInstallation("inst_talk")).installation.status,
  ).toBe("active");
});
