// Phase 18.3 — Drift watcher + canary auto-abort/rollback tests.
//
// These tests exercise the drift_watcher module and its integration with
// `RolloutCanaryService`. They cover:
//
//   1. `evaluateDriftSeverity` decision logic for each drift reason.
//   2. `ProviderObservationDriftWatcher` filters by `sampledSince` so
//      pre-step observations cannot abort a freshly-applied step.
//   3. canary step → security-drift → auto abort (no policy → no rollback).
//   4. canary step → config-drift + `autoRollbackOnDrift: true` → rollback
//      triggered, run status `aborted`, condition stamped.
//   5. canary step → config-drift + policy opted out → abort but no rollback.
//   6. drift in middle of multi-step run halts subsequent steps.
//   7. non-severe drift (e.g. `cache-drift`) does NOT abort the run.
//   8. `CanaryAbortedOnDrift` condition is appended via the deployment
//      client's optional condition hook.

import assert from "node:assert/strict";
import {
  type DriftWatcher,
  type DriftWatcherSampleInput,
  evaluateDriftSeverity,
  ProviderObservationDriftWatcher,
  type RolloutAppendConditionInput,
  type RolloutApplyOutcome,
  RolloutCanaryService,
  type RolloutDeploymentClient,
  type RolloutResolveInput,
  type RolloutRollbackInput,
} from "./mod.ts";
import {
  InMemoryProviderObservationStore,
  type ProviderObservation,
} from "../../domains/runtime/mod.ts";
import type {
  Deployment,
  DeploymentCondition,
  GroupHead,
} from "takosumi-contract";
import type { PublicDeployManifest } from "../../domains/deploy/types.ts";

Deno.test("evaluateDriftSeverity returns abort only for default-threshold drift reasons", () => {
  assert.equal(
    evaluateDriftSeverity(observation({ driftReason: "security-drift" })),
    "abort",
  );
  assert.equal(
    evaluateDriftSeverity(observation({ driftReason: "config-drift" })),
    "abort",
  );
  assert.equal(
    evaluateDriftSeverity(observation({ driftReason: "status-drift" })),
    "none",
  );
  assert.equal(
    evaluateDriftSeverity(observation({ driftReason: "cache-drift" })),
    "none",
  );
  // observed_state must be `drifted` to even qualify
  assert.equal(
    evaluateDriftSeverity(
      observation({ observedState: "present", driftReason: "security-drift" }),
    ),
    "none",
  );
  // missing reason -> insufficient info
  assert.equal(
    evaluateDriftSeverity(observation({ driftReason: undefined })),
    "none",
  );
});

Deno.test("ProviderObservationDriftWatcher ignores observations recorded before the step apply timestamp", async () => {
  const store = new InMemoryProviderObservationStore();
  await store.record({
    materializationId: "mat_a",
    observedState: "drifted",
    driftReason: "security-drift",
    observedAt: "2026-04-30T00:00:00.000Z", // before step
  });
  const watcher = new ProviderObservationDriftWatcher({
    observationStore: store,
  });

  const sample = await watcher.sample({
    deploymentId: "dep_1",
    stepId: "10",
    materializationIds: ["mat_a"],
    sampledSince: "2026-04-30T00:00:05.000Z",
  });

  assert.equal(sample.verdict, "none");
});

Deno.test("ProviderObservationDriftWatcher returns abort when post-apply observation is severe", async () => {
  const store = new InMemoryProviderObservationStore();
  await store.record({
    materializationId: "mat_a",
    observedState: "drifted",
    driftReason: "security-drift",
    observedAt: "2026-04-30T00:00:10.000Z",
    providerId: "aws",
  });
  const watcher = new ProviderObservationDriftWatcher({
    observationStore: store,
  });

  const sample = await watcher.sample({
    deploymentId: "dep_1",
    stepId: "10",
    materializationIds: ["mat_a"],
    sampledSince: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(sample.verdict, "abort");
  assert.equal(sample.observation?.driftReason, "security-drift");
  assert.equal(sample.observation?.providerId, "aws");
});

Deno.test("RolloutCanaryService aborts on security-drift without rollback when policy opts out", async () => {
  const stub = new StubDeploymentClient();
  const watcher = stubWatcher((input) => {
    if (input.stepId === "10") {
      return {
        verdict: "abort",
        observation: {
          materializationId: "mat_security_a",
          observedState: "drifted",
          driftReason: "security-drift",
          observedAt: "2026-04-30T00:00:01.000Z",
          providerId: "aws",
        },
      };
    }
    return { verdict: "none" };
  });
  const service = new RolloutCanaryService({
    deploymentService: stub,
    driftWatcher: watcher,
    // policy left default → autoRollbackOnDrift: false
    idFactory: sequenceIds(["run_1"]),
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });

  const run = await service.run({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    steps: [
      {
        id: "10",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 100,
        materializationIds: ["mat_security_a"],
      },
      {
        id: "50",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 500,
      },
    ],
  });

  assert.equal(run.status, "aborted");
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].status, "aborted");
  assert.equal(run.steps[0].driftAbort?.reason, "security-drift");
  assert.equal(run.steps[0].driftAbort?.autoRollbackTriggered, false);
  assert.equal(run.driftAbort?.reason, "security-drift");
  assert.equal(stub.rollbackCalls.length, 0);
  // Condition stamped on the step deployment
  assert.equal(stub.appendedConditions.length, 1);
  assert.equal(
    stub.appendedConditions[0].condition.type,
    "CanaryAbortedOnDrift",
  );
  assert.equal(
    stub.appendedConditions[0].condition.reason,
    "ProviderSecurityDrift",
  );
});

Deno.test("RolloutCanaryService triggers auto-rollback when policy opts in and prior step exists", async () => {
  const stub = new StubDeploymentClient();
  const watcher = stubWatcher((input) => {
    if (input.stepId === "50") {
      return {
        verdict: "abort",
        observation: {
          materializationId: "mat_config_b",
          observedState: "drifted",
          driftReason: "config-drift",
          observedAt: "2026-04-30T00:00:02.000Z",
          providerId: "cloudflare",
        },
      };
    }
    return { verdict: "none" };
  });
  const service = new RolloutCanaryService({
    deploymentService: stub,
    driftWatcher: watcher,
    policy: { autoRollbackOnDrift: true },
    idFactory: sequenceIds(["run_2"]),
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
    // Use the stub's sequential ids ("deployment_0", "deployment_1", ...)
  });

  const run = await service.run({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    steps: [
      {
        id: "10",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 100,
        materializationIds: ["mat_config_a"],
      },
      {
        id: "50",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 500,
        materializationIds: ["mat_config_b"],
      },
      {
        id: "100",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 1000,
      },
    ],
  });

  assert.equal(run.status, "aborted");
  assert.deepEqual(
    run.steps.map((s) => s.status),
    ["applied", "aborted"],
  );
  assert.equal(run.steps[1].driftAbort?.reason, "config-drift");
  assert.equal(run.steps[1].driftAbort?.autoRollbackTriggered, true);
  // Rollback target defaults to the previous applied step's deployment id
  assert.equal(
    run.steps[1].driftAbort?.rolledBackToDeploymentId,
    run.steps[0].deploymentId,
  );
  assert.equal(stub.rollbackCalls.length, 1);
  assert.equal(
    stub.rollbackCalls[0].targetDeploymentId,
    run.steps[0].deploymentId,
  );
  assert.equal(stub.rollbackCalls[0].reason, "CanaryAbortedOnDrift");
  // Subsequent step (id=100) MUST not have been resolved/applied
  assert.equal(stub.applyCalls.length, 2);
});

Deno.test("RolloutCanaryService respects explicit rollbackTargetDeploymentId from input", async () => {
  const stub = new StubDeploymentClient();
  const watcher = stubWatcher(() => ({
    verdict: "abort",
    observation: {
      materializationId: "mat_x",
      observedState: "drifted",
      driftReason: "config-drift",
      observedAt: "2026-04-30T00:00:01.000Z",
    },
  }));
  const service = new RolloutCanaryService({
    deploymentService: stub,
    driftWatcher: watcher,
    policy: { autoRollbackOnDrift: true },
    idFactory: sequenceIds(["run_3"]),
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });

  const run = await service.run({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    rollbackTargetDeploymentId: "deployment_pre_canary",
    steps: [
      {
        id: "10",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 100,
        materializationIds: ["mat_x"],
      },
    ],
  });

  assert.equal(run.status, "aborted");
  assert.equal(stub.rollbackCalls.length, 1);
  assert.equal(
    stub.rollbackCalls[0].targetDeploymentId,
    "deployment_pre_canary",
  );
  assert.equal(
    run.steps[0].driftAbort?.rolledBackToDeploymentId,
    "deployment_pre_canary",
  );
});

Deno.test("RolloutCanaryService does not trigger rollback when no prior step and no explicit target", async () => {
  const stub = new StubDeploymentClient();
  const watcher = stubWatcher(() => ({
    verdict: "abort",
    observation: {
      materializationId: "mat_x",
      observedState: "drifted",
      driftReason: "security-drift",
      observedAt: "2026-04-30T00:00:01.000Z",
    },
  }));
  const service = new RolloutCanaryService({
    deploymentService: stub,
    driftWatcher: watcher,
    policy: { autoRollbackOnDrift: true },
    idFactory: sequenceIds(["run_4"]),
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });

  const run = await service.run({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    steps: [
      {
        id: "10",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 100,
        materializationIds: ["mat_x"],
      },
    ],
  });

  assert.equal(run.status, "aborted");
  assert.equal(run.steps[0].driftAbort?.autoRollbackTriggered, false);
  assert.equal(stub.rollbackCalls.length, 0);
});

Deno.test("RolloutCanaryService ignores non-severe drift and completes the run", async () => {
  const stub = new StubDeploymentClient();
  const watcher = stubWatcher(() => ({ verdict: "none" }));
  const service = new RolloutCanaryService({
    deploymentService: stub,
    driftWatcher: watcher,
    policy: { autoRollbackOnDrift: true },
    idFactory: sequenceIds(["run_5"]),
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });

  const run = await service.run({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    steps: [
      {
        id: "10",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 100,
      },
      {
        id: "100",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 1000,
      },
    ],
  });

  assert.equal(run.status, "succeeded");
  assert.equal(run.steps.length, 2);
  assert.equal(stub.rollbackCalls.length, 0);
  assert.equal(stub.appendedConditions.length, 0);
});

Deno.test("RolloutCanaryService end-to-end with ProviderObservationDriftWatcher abort", async () => {
  // Use the real ProviderObservationDriftWatcher backed by an in-memory store.
  // Simulate the runtime adapter recording a drift observation between
  // `applyDeployment` and the watcher sample by intercepting applyDeployment.
  const observationStore = new InMemoryProviderObservationStore();
  const watcher = new ProviderObservationDriftWatcher({
    observationStore,
  });

  const stub = new StubDeploymentClient({
    onApply: async (deploymentId) => {
      // Simulate the provider stream emitting a security drift right after
      // the canary step is applied — observedAt MUST be after the apply
      // timestamp so the watcher's `sampledSince` filter accepts it.
      await observationStore.record({
        materializationId: "mat_e2e",
        observedState: "drifted",
        driftReason: "security-drift",
        observedAt: new Date(Date.now() + 1000).toISOString(),
        providerId: "k8s",
        createdByOperationId: deploymentId,
      });
    },
  });

  const service = new RolloutCanaryService({
    deploymentService: stub,
    driftWatcher: watcher,
    policy: { autoRollbackOnDrift: true },
    idFactory: sequenceIds(["run_6"]),
    // No fixed clock — the apply / sample sequence uses real timestamps so
    // the recorded observation is strictly after the step's appliedAt.
  });

  const run = await service.run({
    spaceId: "space_e2e",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    rollbackTargetDeploymentId: "deployment_pre_canary",
    steps: [
      {
        id: "10",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 100,
        materializationIds: ["mat_e2e"],
      },
      {
        id: "100",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 1000,
        materializationIds: ["mat_e2e"],
      },
    ],
  });

  assert.equal(run.status, "aborted");
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].status, "aborted");
  assert.equal(run.steps[0].driftAbort?.reason, "security-drift");
  assert.equal(run.steps[0].driftAbort?.providerId, "k8s");
  assert.equal(run.steps[0].driftAbort?.autoRollbackTriggered, true);
  assert.equal(stub.rollbackCalls.length, 1);
  assert.equal(
    stub.rollbackCalls[0].targetDeploymentId,
    "deployment_pre_canary",
  );
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function observation(
  overrides: Partial<ProviderObservation> = {},
): ProviderObservation {
  return {
    materializationId: "mat_default",
    observedState: "drifted",
    driftReason: "config-drift",
    observedAt: "2026-04-30T00:00:00.000Z",
    ...overrides,
  };
}

function stubWatcher(
  callback: (
    input: DriftWatcherSampleInput,
  ) =>
    | {
      verdict: "none" | "abort";
      observation?: ProviderObservation;
    }
    | Promise<{
      verdict: "none" | "abort";
      observation?: ProviderObservation;
    }>,
): DriftWatcher {
  return {
    sample: (input) => Promise.resolve(callback(input)),
  };
}

interface StubDeploymentClientOptions {
  readonly failOnIndex?: number;
  readonly onApply?: (deploymentId: string) => void | Promise<void>;
}

class StubDeploymentClient implements RolloutDeploymentClient {
  readonly resolveCalls: Array<RolloutResolveInput & { deploymentId: string }> =
    [];
  readonly applyCalls: string[] = [];
  readonly rollbackCalls: RolloutRollbackInput[] = [];
  readonly appendedConditions: RolloutAppendConditionInput[] = [];
  #counter = 0;
  readonly #options: StubDeploymentClientOptions;

  constructor(options: StubDeploymentClientOptions = {}) {
    this.#options = options;
  }

  resolveDeployment(input: RolloutResolveInput): Promise<Deployment> {
    const index = this.#counter++;
    if (
      this.#options.failOnIndex !== undefined &&
      index === this.#options.failOnIndex
    ) {
      return Promise.reject(new Error("injected resolveDeployment failure"));
    }
    const id = input.deploymentId ?? `deployment_${index}`;
    this.resolveCalls.push({ ...input, deploymentId: id });
    return Promise.resolve(deployment(id, input.spaceId, input.groupId));
  }

  async applyDeployment(deploymentId: string): Promise<RolloutApplyOutcome> {
    this.applyCalls.push(deploymentId);
    if (this.#options.onApply) await this.#options.onApply(deploymentId);
    return {
      deployment: deployment(deploymentId, "space_a", "demo-app", "applied"),
      groupHead: groupHead("demo-app", deploymentId),
    };
  }

  appendDeploymentCondition(
    input: RolloutAppendConditionInput,
  ): Promise<Deployment> {
    this.appendedConditions.push(input);
    return Promise.resolve(
      withCondition(
        deployment(input.deploymentId, "space_a", "demo-app", "applied"),
        input.condition,
      ),
    );
  }

  rollbackGroup(input: RolloutRollbackInput): Promise<GroupHead> {
    this.rollbackCalls.push(input);
    return Promise.resolve(groupHead(input.groupId, input.targetDeploymentId));
  }
}

function withCondition(
  base: Deployment,
  condition: DeploymentCondition,
): Deployment {
  return {
    ...base,
    conditions: [...base.conditions, condition],
  };
}

function deployment(
  id: string,
  spaceId: string,
  groupId: string | undefined,
  status: "resolved" | "applied" = "resolved",
): Deployment {
  return {
    id,
    group_id: groupId ?? "demo-app",
    space_id: spaceId,
    input: {
      manifest_snapshot: "sha256:stub",
      source_kind: "inline",
    },
    resolution: {
      descriptor_closure: {
        resolutions: [],
        dependencies: [],
        closureDigest: "sha256:empty",
        createdAt: "2026-04-30T00:00:00.000Z",
      },
      resolved_graph: {
        digest: "sha256:empty",
        components: [],
        projections: [],
      },
    },
    desired: {
      routes: [],
      bindings: [],
      resources: [],
      runtime_network_policy: {
        policyDigest: "sha256:empty",
        defaultEgress: "deny-by-default",
      },
      activation_envelope: {
        primary_assignment: {
          componentAddress: "component:web",
          weight: 1000,
        },
        envelopeDigest: "sha256:empty",
      },
    },
    status,
    conditions: [],
    policy_decisions: [],
    approval: null,
    rollback_target: null,
    created_at: "2026-04-30T00:00:00.000Z",
    applied_at: status === "applied" ? "2026-04-30T00:00:00.000Z" : null,
    finalized_at: status === "applied" ? "2026-04-30T00:00:00.000Z" : null,
  };
}

function groupHead(groupId: string, currentId: string): GroupHead {
  return {
    space_id: "space_rollout",
    group_id: groupId,
    current_deployment_id: currentId,
    previous_deployment_id: null,
    generation: 1,
    advanced_at: "2026-04-30T00:00:00.000Z",
  };
}

function sampleManifest(): PublicDeployManifest {
  return {
    name: "demo-app",
    version: "1.0.0",
    compute: {
      web: {
        type: "container",
        image:
          "registry.example.test/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111",
        port: 8080,
      },
    },
    routes: {
      web: {
        target: "web",
        protocol: "https",
        host: "demo.example.test",
        path: "/",
      },
      events: { target: "web", protocol: "event" },
    },
    outputs: {
      updates: {
        type: "output.topic@v1",
        from: "web",
        outputs: { event: { routeRef: "events" } },
      },
    },
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? crypto.randomUUID();
}
