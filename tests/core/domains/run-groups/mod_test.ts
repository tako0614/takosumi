/**
 * RunGroups service tests (Core Specification §19 / §24 — "RunGroup basic").
 *
 * Covers the pure status computation, the empty-stale-set precondition, and the
 * end-to-end workspace_update flow over a 3-capsule chain
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
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { DependenciesService } from "../../../../core/domains/dependencies/mod.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import {
  computeGroupStatus,
  RunGroupsService,
} from "../../../../core/domains/run-groups/mod.ts";
import type { Run } from "takosumi-contract/runs";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";

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
 * per-capsule map so a re-apply of the producer can emit a CHANGED value
 * (driving the stale cascade) while the others stay stable.
 */
function recordingRunner(
  outputByCapsule: ReadonlyMap<string, string>,
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
            address: "module.child.cloudflare_workers_script.this",
            type: "cloudflare_workers_script",
            actions: ["delete", "create"],
          },
        ],
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      const capsuleId = job.planRun.capsuleId ?? "";
      const value = outputByCapsule.get(capsuleId) ?? "default.example.com";
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
  store: OpenTofuControlStore,
  runner: OpenTofuRunner,
): OpenTofuController {
  return new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    store,
    runner,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
}

/**
 * Seeds a 3-capsule chain in one Workspace: core -> files -> talk, each a
 * `variable_injection` consumer of the upstream's `base_domain`. Returns the
 * capsule ids in topological order.
 */
async function seedChain(
  store: OpenTofuControlStore,
  environment: string,
): Promise<{ core: string; files: string; talk: string }> {
  for (const name of ["core", "files", "talk"]) {
    const seeded = await seedCapsuleModel(store, {
      environment,
      sourceId: `src_${name}`,
      snapshotId: `snap_${name}`,
      installConfigId: `cfg_${name}`,
      capsuleId: `inst_${name}`,
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
    await seedProviderConnections(store, seeded.capsule);
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
    workspaceId: "workspace_test",
    producerCapsuleId: "inst_core",
    consumerCapsuleId: "inst_files",
    mode: "variable_injection",
    visibility: "workspace",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  await deps.createDependency({
    workspaceId: "workspace_test",
    producerCapsuleId: "inst_files",
    consumerCapsuleId: "inst_talk",
    mode: "variable_injection",
    visibility: "workspace",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  return { core: "inst_core", files: "inst_files", talk: "inst_talk" };
}

/** Applies a preview capsule plan to completion (no approval gate). */
async function applyPlan(
  controller: OpenTofuController,
  capsuleId: string,
): Promise<void> {
  const plan = await controller.createCapsulePlan(capsuleId);
  await controller.createApplyRun({
    planRunId: plan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(plan.planRun),
  });
}

function fakeRun(status: Run["status"]): Run {
  return {
    id: `run_${status}`,
    workspaceId: "workspace_test",
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

test("createWorkspaceUpdate maps a wedged (cyclic) dependency graph to failed_precondition, not an uncaught 500", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // Seed two Capsules in one Workspace and mark BOTH stale so they enter the
  // workspace_update member set.
  for (const name of ["alpha", "beta"]) {
    const { capsule } = await seedCapsuleModel(store, {
      environment: "preview",
      sourceId: `src_${name}`,
      snapshotId: `snap_${name}`,
      installConfigId: `cfg_${name}`,
      capsuleId: `inst_${name}`,
      name,
    });
    await store.putCapsule({ ...capsule, status: "stale" });
  }
  // Inject an inverse-edge cycle directly (the create path prevents cycles, so a
  // wedge can only pre-exist). alpha -> beta AND beta -> alpha.
  await store.putDependency({
    id: "dep_cycle_1",
    workspaceId: "workspace_test",
    producerCapsuleId: "inst_alpha",
    consumerCapsuleId: "inst_beta",
    mode: "variable_injection",
    visibility: "workspace",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putDependency({
    id: "dep_cycle_2",
    workspaceId: "workspace_test",
    producerCapsuleId: "inst_beta",
    consumerCapsuleId: "inst_alpha",
    mode: "variable_injection",
    visibility: "workspace",
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
  await expect(
    runGroups.createWorkspaceUpdate("workspace_test"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
  });
  await expect(
    runGroups.createWorkspaceUpdate("workspace_test"),
  ).rejects.toThrow(/dependency_cycle/);
});

test("createWorkspaceUpdate with no stale Capsules is failed_precondition nothing_to_update", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(new Map());
  await seedChain(store, "preview");
  const controller = controllerWith(store, runner);
  const runGroups = new RunGroupsService({
    store,
    controller,
    newId: deterministicIds(),
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await expect(
    runGroups.createWorkspaceUpdate("workspace_test"),
  ).rejects.toThrow(/nothing_to_update/);
});

test("producer output change cascades stale to chained consumers (core -> files -> talk)", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
    expect((await controller.getCapsule(id)).capsule.status).toEqual("active");
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
  const controller2 = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
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

  expect((await controller2.getCapsule("inst_core")).capsule.status).toEqual(
    "active",
  );
  expect((await controller2.getCapsule("inst_files")).capsule.status).toEqual(
    "stale",
  );
  expect((await controller2.getCapsule("inst_talk")).capsule.status).toEqual(
    "stale",
  );
});

test("unchanged producer output marks nothing stale", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
  expect((await controller.getCapsule("inst_files")).capsule.status).toEqual(
    "active",
  );
  expect((await controller.getCapsule("inst_talk")).capsule.status).toEqual(
    "active",
  );
});

test("workspace_update e2e: stale -> plan-update group (topo layers) -> approve -> applies -> succeeded", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
    const plan = await controller.createCapsulePlan(id);
    await controller.approveRun(plan.planRun.id);
    await controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
  }
  // core re-applies with a CHANGED output -> files + talk go stale.
  const changed = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
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
  const corePlan = await changed.createCapsulePlan("inst_core");
  await changed.approveRun(corePlan.planRun.id);
  await changed.createApplyRun({
    planRunId: corePlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(corePlan.planRun),
  });
  expect((await changed.getCapsule("inst_files")).capsule.status).toEqual(
    "stale",
  );

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
  const created = await runGroups.createWorkspaceUpdate("workspace_test");
  expect(created.runGroup.type).toEqual("workspace_update");

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
  expect((await changed.getCapsule("inst_files")).capsule.status).toEqual(
    "active",
  );

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

  const talkReplan = await changed.createCapsulePlan("inst_talk");
  await changed.approveRun(talkReplan.planRun.id);
  await changed.createApplyRun({
    planRunId: talkReplan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(talkReplan.planRun),
  });
  expect((await changed.getCapsule("inst_talk")).capsule.status).toEqual(
    "active",
  );
});

test("workspace_drift_check groups active Capsules into read-only drift_check runs", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
  const created = await runGroups.createWorkspaceDriftCheck("workspace_test", {
    limit: 2,
  });

  expect(created.runGroup.type).toEqual("workspace_drift_check");
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
