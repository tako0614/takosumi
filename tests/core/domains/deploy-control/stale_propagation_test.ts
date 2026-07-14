/**
 * §24 stale-propagation integration tests.
 *
 * After a producer apply records an Output whose projected outputs
 * CHANGED versus the producer's previous snapshot, every transitive downstream
 * consumer in the Workspace that is currently `active` is marked `stale`. An
 * unchanged output marks nothing; a not-yet-applied (`pending`) consumer is
 * left untouched (stale is only meaningful for an already-deployed consumer).
 */

import { expect, test } from "bun:test";
import type { OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { DependenciesService } from "../../../../core/domains/dependencies/mod.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import type {
  ActivityRecorder,
  RecordActivityInput,
} from "../../../../core/domains/activity/mod.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function ids(): (prefix: string) => string {
  let n = 1;
  return (p) => `${p}_${String(n++).padStart(8, "0")}`;
}

function nowSeq(start: number): () => number {
  let v = start;
  return () => v++;
}

function runnerEmitting(
  valueByCapsule: ReadonlyMap<string, string>,
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
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: (job) =>
      Promise.resolve({
        outputs: {
          base_domain: {
            sensitive: false,
            value:
              valueByCapsule.get(job.planRun.capsuleId ?? "") ??
              "x.example.com",
          },
        } as never,
        stateDigest:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      }),
    destroy: () => Promise.resolve({}),
  };
}

function recordingActivity(): {
  readonly recorder: ActivityRecorder;
  readonly events: RecordActivityInput[];
} {
  const events: RecordActivityInput[] = [];
  return {
    events,
    recorder: {
      record: (event) => {
        events.push(event);
        return Promise.resolve(undefined);
      },
    },
  };
}

async function edge(
  store: OpenTofuControlStore,
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
    workspaceId: "ws_test001",
    producerCapsuleId: producer,
    consumerCapsuleId: consumer,
    mode: "variable_injection",
    visibility: "workspace",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
}

test("a changed producer output marks an active consumer stale", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const producer = await seedCapsuleModel(store, {
    environment: "preview",
    workspaceId: "ws_test001",
    sourceId: "src_p",
    snapshotId: "snap_p",
    installConfigId: "cfg_p",
    capsuleId: "cap_producer1",
    name: "p",
    installConfig: {
      outputAllowlist: {
        base_domain: { from: "base_domain", type: "hostname", required: true },
      },
    },
  });
  await seedProviderConnections(store, producer.capsule);
  const consumer = await seedCapsuleModel(store, {
    environment: "preview",
    workspaceId: "ws_test001",
    sourceId: "src_c",
    snapshotId: "snap_c",
    installConfigId: "cfg_c",
    capsuleId: "cap_consumer1",
    name: "c",
  });
  await seedProviderConnections(store, consumer.capsule);
  await edge(store, "cap_producer1", "cap_consumer1");
  const { recorder, events } = recordingActivity();

  const controller = new OpenTofuController({
    store,
    runner: runnerEmitting(
      new Map([
        ["cap_producer1", "v1"],
        ["cap_consumer1", "c1"],
      ]),
    ),
    vault: fakeProviderVault() as never,
    activity: recorder,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: nowSeq(1),
    newId: ids(),
  });

  // Producer + consumer both apply -> both active.
  const applyOf = async (id: string) => {
    const plan = await controller.createCapsulePlan(id);
    await controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
  };
  await applyOf("cap_producer1");
  await applyOf("cap_consumer1");
  expect((await controller.getCapsule("cap_consumer1")).capsule.status).toEqual(
    "active",
  );

  // Producer re-applies with a CHANGED output -> consumer goes stale.
  const changed = new OpenTofuController({
    store,
    runner: runnerEmitting(
      new Map([
        ["cap_producer1", "v2"],
        ["cap_consumer1", "c1"],
      ]),
    ),
    vault: fakeProviderVault() as never,
    activity: recorder,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: nowSeq(1000),
    newId: (() => {
      let n = 1;
      return (p: string) => `${p}_r${String(n++).padStart(6, "0")}`;
    })(),
  });
  const replan = await changed.createCapsulePlan("cap_producer1");
  await changed.createApplyRun({
    planRunId: replan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(replan.planRun),
  });
  expect((await changed.getCapsule("cap_consumer1")).capsule.status).toEqual(
    "stale",
  );
  const staleEvent = events.find(
    (event) =>
      event.action === "capsule.stale" && event.targetId === "cap_consumer1",
  );
  expect(staleEvent?.metadata).toMatchObject({
    producerCapsuleId: "cap_producer1",
    producerCapsuleName: "p",
    changedOutputs: ["base_domain"],
    directChangedOutputs: ["base_domain"],
    reasons: ["p.base_domain changed"],
  });
  expect(JSON.stringify(staleEvent?.metadata)).not.toContain("v2");
  // The producer itself stays active.
  expect((await changed.getCapsule("cap_producer1")).capsule.status).toEqual(
    "active",
  );
});

test("a not-yet-applied (pending) consumer is left untouched by a producer change", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const producer = await seedCapsuleModel(store, {
    environment: "preview",
    workspaceId: "ws_test001",
    sourceId: "src_p",
    snapshotId: "snap_p",
    installConfigId: "cfg_p",
    capsuleId: "cap_producer1",
    name: "p",
    installConfig: {
      outputAllowlist: {
        base_domain: { from: "base_domain", type: "hostname", required: true },
      },
    },
  });
  await seedProviderConnections(store, producer.capsule);
  // The consumer is seeded `pending` (fixture default) and never applied.
  const consumer = await seedCapsuleModel(store, {
    environment: "preview",
    workspaceId: "ws_test001",
    sourceId: "src_c",
    snapshotId: "snap_c",
    installConfigId: "cfg_c",
    capsuleId: "cap_consumer1",
    name: "c",
  });
  await seedProviderConnections(store, consumer.capsule);
  await edge(store, "cap_producer1", "cap_consumer1");

  const controller = new OpenTofuController({
    store,
    runner: runnerEmitting(new Map([["cap_producer1", "v1"]])),
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: nowSeq(1),
    newId: ids(),
  });
  const applyOf = async (id: string) => {
    const plan = await controller.createCapsulePlan(id);
    await controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
  };
  await applyOf("cap_producer1"); // gen 1, snapshot v1

  const changed = new OpenTofuController({
    store,
    runner: runnerEmitting(new Map([["cap_producer1", "v2"]])),
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: nowSeq(1000),
    newId: (() => {
      let n = 1;
      return (p: string) => `${p}_r${String(n++).padStart(6, "0")}`;
    })(),
  });
  const replan = await changed.createCapsulePlan("cap_producer1");
  await changed.createApplyRun({
    planRunId: replan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(replan.planRun),
  });
  // The consumer never reached `active`, so it is not flagged stale.
  expect((await changed.getCapsule("cap_consumer1")).capsule.status).toEqual(
    "pending",
  );
});
