// Plan/Apply lifecycle tests for the Deployment-centric service surface.

import assert from "node:assert/strict";
import {
  type CommitAppliedDeploymentInput,
  DeploymentService,
  InMemoryDeploymentStore,
} from "./deployment_service.ts";
import {
  TAKOSUMI_DEPLOY_OPERATION_COUNT,
  TAKOSUMI_ROLLBACK_DURATION_SECONDS,
} from "./deploy_metrics.ts";
import type {
  DeploymentProviderAdapter,
  OperationOutcome,
  PlannedOperation,
} from "./apply_orchestrator.ts";
import type { Deployment, IsoTimestamp } from "takosumi-contract";
import type { DeployBlocker, PublicDeployManifest } from "./types.ts";
import { InMemoryObservabilitySink } from "../../services/observability/mod.ts";

const DEMO_IMAGE_1 =
  "registry.example.test/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111";

function sampleManifest(): PublicDeployManifest {
  return {
    name: "demo-app",
    version: "1.0.0",
    compute: {
      web: {
        type: "container",
        image: DEMO_IMAGE_1,
        port: 8080,
        env: { MESSAGE: "hello" },
      },
    },
    resources: {
      db: {
        type: "postgres",
        plan: "dev",
        bindings: { web: "DATABASE_URL" },
      },
    },
    routes: {
      web: {
        target: "web",
        path: "/",
      },
    },
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

// --- Surviving lifecycle tests ----------------------------------------

Deno.test("deploy: resolve produces an immutable resolved Deployment", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_resolved_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  assert.equal(resolved.id, "deployment_resolved_1");
  assert.equal(resolved.space_id, "space_deploy");
  assert.equal(resolved.group_id, "demo-app");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.applied_at, null);
  assert.equal(resolved.finalized_at, null);
  assert.equal(
    resolved.resolution.descriptor_closure.resolutions.length > 0,
    true,
  );
  assert.notEqual(
    resolved.resolution.descriptor_closure.closureDigest,
    "sha256:empty",
  );
  assert.equal(resolved.resolution.resolved_graph.components.length, 1);
  // Phase 10B — six canonical projection families. Sample manifest emits:
  //   runtime-claim:web, resource-claim:db, exposure-target:web/publicHttp,
  //   binding-request:web/DATABASE_URL, access-path-request:db/web.
  // No output entries → output-declaration count is 0.
  assert.equal(resolved.resolution.resolved_graph.projections.length, 5);
  const projectionTypes = new Set(
    resolved.resolution.resolved_graph.projections.map((p) => p.projectionType),
  );
  assert.equal(projectionTypes.has("runtime-claim"), true);
  assert.equal(projectionTypes.has("resource-claim"), true);
  assert.equal(projectionTypes.has("exposure-target"), true);
  assert.equal(projectionTypes.has("binding-request"), true);
  assert.equal(projectionTypes.has("access-path-request"), true);
  assert.notEqual(resolved.resolution.resolved_graph.digest, "sha256:empty");
  assert.equal(resolved.desired.resources.length, 1);
  assert.equal(resolved.desired.bindings.length, 1);
  assert.equal(resolved.desired.routes.length, 1);
  assert.equal(
    resolved.desired.runtime_network_policy.defaultEgress,
    "deny-by-default",
  );
  assert.notEqual(
    resolved.desired.runtime_network_policy.policyDigest,
    "sha256:empty",
  );
  assert.equal(
    resolved.desired.activation_envelope.primary_assignment.componentAddress,
    "component:web",
  );
  assert.notEqual(
    resolved.desired.activation_envelope.envelopeDigest,
    "sha256:empty",
  );
  assert.equal(Object.isFrozen(resolved), true);
  assert.throws(() => {
    (resolved as { status: string }).status = "applied";
  }, TypeError);
});

Deno.test("deploy: approve stores Deployment.approval without applying", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_approval_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await store.putDeployment({
    ...resolved,
    policy_decisions: [{
      id: "policy_1",
      gateGroup: "deployment-gates",
      gate: "operation-planning",
      decision: "require-approval",
      subjectDigest: "sha256:approval-subject" as never,
      decidedAt: "2026-04-27T00:00:30.000Z" as IsoTimestamp,
    }],
  });

  const approved = await service.approveDeployment({
    deploymentId: resolved.id,
    approval: {
      approved_by: "acct_1",
      approved_at: "2026-04-27T00:01:00.000Z",
      policy_decision_id: "policy_1",
    },
  });

  assert.equal(approved.status, "resolved");
  assert.deepEqual(approved.approval, {
    approved_by: "acct_1",
    approved_at: "2026-04-27T00:01:00.000Z",
    policy_decision_id: "policy_1",
  });
  assert.deepEqual((await store.getDeployment(resolved.id))?.approval, {
    approved_by: "acct_1",
    approved_at: "2026-04-27T00:01:00.000Z",
    policy_decision_id: "policy_1",
  });
});

Deno.test("deploy: ProviderObservation store lists by deployment", async () => {
  const store = new InMemoryDeploymentStore();
  await store.recordObservation({
    id: "obs_1",
    deployment_id: "deployment_observed",
    provider_id: "provider_a",
    object_address: "component:web",
    observed_state: "present",
    observed_at: "2026-04-27T00:00:00.000Z",
  });
  await store.recordObservation({
    id: "obs_2",
    deployment_id: "deployment_other",
    provider_id: "provider_a",
    object_address: "component:worker",
    observed_state: "missing",
    observed_at: "2026-04-27T00:01:00.000Z",
  });

  assert.deepEqual(
    (await store.listObservations({ deploymentId: "deployment_observed" }))
      .map((observation) => observation.id),
    ["obs_1"],
  );
});

Deno.test("deploy: apply promotes resolved -> applied and advances GroupHead", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_apply_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  assert.equal(applied.id, resolved.id);
  assert.equal(applied.status, "applied");
  assert.equal(applied.applied_at, "2026-04-27T00:01:00.000Z");
  assert.equal(applied.finalized_at, "2026-04-27T00:01:00.000Z");

  const head = await store.getGroupHead("demo-app");
  assert.equal(head?.current_deployment_id, applied.id);
  assert.equal(head?.space_id, "space_deploy");
  assert.equal(head?.previous_deployment_id, null);
  assert.equal(head?.generation, 1);
});

Deno.test("deploy: GroupHead is scoped by space and group", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_space_head_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const spaceA = await service.resolveDeployment({
    spaceId: "space_a",
    manifest: sampleManifest(),
  });
  const appliedA = await service.applyDeployment({
    deploymentId: spaceA.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  const spaceB = await service.resolveDeployment({
    spaceId: "space_b",
    manifest: sampleManifest(),
  });
  const appliedB = await service.applyDeployment({
    deploymentId: spaceB.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
  });

  assert.equal(
    (await store.getGroupHead({ spaceId: "space_a", groupId: "demo-app" }))
      ?.current_deployment_id,
    appliedA.id,
  );
  assert.equal(
    (await store.getGroupHead({ spaceId: "space_b", groupId: "demo-app" }))
      ?.current_deployment_id,
    appliedB.id,
  );
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("deploy: applying a non-resolved Deployment is rejected", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_apply_twice",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: resolved.id,
        appliedAt: "2026-04-27T00:02:00.000Z",
      }),
    /not in 'resolved' status/,
  );
});

Deno.test("deploy: rollback advances GroupHead to a prior Deployment", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const v1 = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: v1.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  const secondDeployment = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: { ...sampleManifest(), version: "2.0.0" },
  });
  await service.applyDeployment({
    deploymentId: secondDeployment.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
  });

  const headAfterApply = await store.getGroupHead("demo-app");
  assert.equal(headAfterApply?.current_deployment_id, secondDeployment.id);
  assert.equal(headAfterApply?.previous_deployment_id, v1.id);

  const rolledBack = await service.rollbackGroup({
    spaceId: "space_deploy",
    groupId: "demo-app",
    targetDeploymentId: v1.id,
    advancedAt: "2026-04-27T00:03:00.000Z",
  });

  assert.equal(rolledBack.current_deployment_id, v1.id);
  assert.equal(rolledBack.previous_deployment_id, secondDeployment.id);
  assert.equal(rolledBack.generation, 3);
});

Deno.test("deploy: rollback records rollback rate and latency metrics", async () => {
  const store = new InMemoryDeploymentStore();
  const observability = new InMemoryObservabilitySink();
  let counter = 0;
  const service = new DeploymentService({
    store,
    observability,
    idFactory: () => `deployment_metric_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const v1 = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: v1.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  const v2 = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: { ...sampleManifest(), version: "2.0.0" },
  });
  await service.applyDeployment({
    deploymentId: v2.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
  });

  await service.rollbackGroup({
    spaceId: "space_deploy",
    groupId: "demo-app",
    targetDeploymentId: v1.id,
    advancedAt: "2026-04-27T00:03:00.000Z",
  });

  const metrics = await observability.listMetrics();
  const rollbackCounter = metrics.find((metric) =>
    metric.name === TAKOSUMI_DEPLOY_OPERATION_COUNT &&
    metric.tags?.operationKind === "rollback"
  );
  assert.ok(rollbackCounter);
  assert.equal(rollbackCounter.value, 1);
  assert.equal(rollbackCounter.tags?.status, "succeeded");

  const rollbackLatency = metrics.find((metric) =>
    metric.name === TAKOSUMI_ROLLBACK_DURATION_SECONDS
  );
  assert.ok(rollbackLatency);
  assert.equal(rollbackLatency.kind, "histogram");
  assert.equal(rollbackLatency.tags?.operationKind, "rollback");
});

Deno.test("deploy: rollback target must belong to the addressed group", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_other_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const other = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: { ...sampleManifest(), name: "another-app" },
  });

  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_deploy",
        groupId: "demo-app",
        targetDeploymentId: other.id,
      }),
    /does not belong to group demo-app/,
  );
});

Deno.test("deploy: rollback target must belong to the addressed space", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_wrong_space_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const target = await service.resolveDeployment({
    spaceId: "space_a",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: target.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_b",
        groupId: "demo-app",
        targetDeploymentId: target.id,
      }),
    /does not belong to space space_b/,
  );
});

Deno.test("deploy: listDeployments filters by space, group and status", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_list_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const a = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({ deploymentId: a.id });
  await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.resolveDeployment({
    spaceId: "space_other",
    manifest: { ...sampleManifest(), name: "other-app" },
  });

  const all = await service.listDeployments({ spaceId: "space_deploy" });
  assert.equal(all.length, 2);
  const applied = await service.listDeployments({ status: "applied" });
  assert.equal(applied.length, 1);
  const byGroup = await service.listDeployments({ groupId: "demo-app" });
  assert.equal(byGroup.length, 2);
});

// --- Deployment invariants --------------------------------------------
//
// These assert on the Deployment-centric surface:
// `Deployment.resolution`, `Deployment.desired`, `Deployment.conditions`,
// and `GroupHead`. A handful that depended on persistence-level
// must-replan / read-set re-validation hooks remain ignored with a
// `phase-12` reference (those need the live provider plugin contract).

Deno.test("deploy: resolveDeployment is non-mutating and pins manifest_snapshot", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_snapshot_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
    input: {
      manifest_snapshot:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      source_kind: "git",
      source_ref: "git@example.test:demo.git#main",
      group: "demo-app",
    },
  });

  // The resolve step is preview / non-mutating: GroupHead never advances.
  assert.equal(await store.getGroupHead("demo-app"), undefined);
  assert.equal(
    resolved.input.manifest_snapshot,
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(resolved.input.source_ref, "git@example.test:demo.git#main");
  assert.equal(resolved.applied_at, null);
});

Deno.test("deploy: resolved Deployment.desired is comparable across resolves", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_compare_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const a = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  const b = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  // Identical manifests → identical desired digests (the Deployment equivalent of
  // "compare desired app spec"); otherwise diff is genuine.
  assert.equal(
    a.desired.activation_envelope.envelopeDigest,
    b.desired.activation_envelope.envelopeDigest,
  );
  assert.equal(
    a.resolution.descriptor_closure.closureDigest,
    b.resolution.descriptor_closure.closureDigest,
  );

  // A structural manifest change (different component name) drifts the
  // resolved-graph digest because component fingerprints feed into it.
  const drifted = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: {
      ...sampleManifest(),
      compute: {
        api: {
          type: "container",
          image: DEMO_IMAGE_1,
          port: 8080,
          env: { MESSAGE: "hello" },
        },
      },
      resources: {
        db: {
          type: "postgres",
          plan: "dev",
          bindings: { api: "DATABASE_URL" },
        },
      },
      routes: { web: { target: "api", path: "/" } },
    },
  });
  assert.notEqual(
    a.resolution.resolved_graph.digest,
    drifted.resolution.resolved_graph.digest,
  );
});

Deno.test("deploy: blockers from resolution surface on conditions and apply still requires resolved status", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_blockers_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const blockers: readonly DeployBlocker[] = [{
    source: "registry-trust",
    code: "RegistryTrustRevoked",
    message: "trust record revoked",
  }];

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
    blockers,
  });

  assert.equal(resolved.status, "resolved");
  assert.ok(
    resolved.conditions.some((condition) =>
      condition.type === "RegistryTrustRevoked" &&
      condition.status === "false"
    ),
  );

  // Applying still works in the Deployment lifecycle (the apply step does not block on advisory
  // conditions); the canonical enforcement lives at the policy/decision
  // layer (status="failed" when policy_decisions has a deny).
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  assert.equal(applied.status, "applied");
  assert.equal(
    (await store.getGroupHead("demo-app"))?.current_deployment_id,
    applied.id,
  );
});

Deno.test("deploy: applying a denied resolution is rejected (status='failed')", async () => {
  // A denied policy_decision flips the resolved Deployment to status=failed
  // and apply rejects with a stale-precondition error — the Deployment equivalent
  // of "apply rejects Core plans that still require approval".
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_denied_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  // Force a denied policy decision by injecting a manifest whose
  // resource access path requires an external boundary policy that the
  // synthetic harness cannot grant. We surface this by directly seeding
  // a Deployment with a deny policy decision via the store path.
  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  const denied: Deployment = {
    ...resolved,
    status: "failed",
  };
  await store.putDeployment(denied);

  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: resolved.id,
        appliedAt: "2026-04-27T00:01:00.000Z",
      }),
    /not in 'resolved' status/,
  );
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("deploy: provider operation failure marks Deployment failed and does NOT advance GroupHead", async () => {
  const store = new InMemoryDeploymentStore();
  const failingAdapter: DeploymentProviderAdapter = {
    materialize(
      _deployment: Deployment,
      operation: PlannedOperation,
    ): OperationOutcome {
      if (operation.kind === "runtime.deploy") {
        return {
          success: false,
          reason: "RuntimeMaterializationFailed",
          message: "synthetic failure",
        };
      }
      return { success: true, reason: "OperationApplied" };
    },
  };
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_fail_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    providerAdapter: failingAdapter,
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  assert.equal(applied.status, "failed");
  assert.equal(applied.applied_at, null);
  assert.equal(applied.finalized_at, "2026-04-27T00:01:00.000Z");
  assert.ok(
    applied.conditions.some((condition) =>
      condition.type === "ApplyFailed" &&
      condition.status === "true" &&
      condition.reason === "RuntimeMaterializationFailed"
    ),
  );
  // GroupHead must NOT have advanced.
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("deploy: applied Deployment is immutable and advances the GroupHead pointer", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_immutable_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  assert.equal(Object.isFrozen(applied), true);
  assert.throws(() => {
    (applied as { status: string }).status = "rolled-back";
  }, TypeError);
  const head = await store.getGroupHead("demo-app");
  assert.equal(head?.current_deployment_id, applied.id);
  assert.equal(head?.generation, 1);
});

Deno.test("deploy: apply commits final Deployment and GroupHead atomically", async () => {
  class InspectingStore extends InMemoryDeploymentStore {
    sawFinalDeploymentInCommit = false;

    override async commitAppliedDeployment(
      input: CommitAppliedDeploymentInput,
    ) {
      this.sawFinalDeploymentInCommit = input.deployment.status === "applied";
      const result = await super.commitAppliedDeployment(input);
      const stored = await this.getDeployment(input.deployment.id);
      const head = await this.getGroupHead({
        spaceId: input.spaceId,
        groupId: input.groupId,
      });
      assert.equal(stored?.status, "applied");
      assert.equal(head?.current_deployment_id, stored?.id);
      return result;
    }
  }
  const store = new InspectingStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_atomic_commit_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  assert.equal(applied.status, "applied");
  assert.equal(store.sawFinalDeploymentInCommit, true);
});

Deno.test("deploy: applying twice on the same Deployment is rejected (stale precondition)", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_stale_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: resolved.id,
        appliedAt: "2026-04-27T00:02:00.000Z",
      }),
    /not in 'resolved' status/,
  );
});

Deno.test("deploy: rollback is a GroupHead pointer move (no new Deployment is created)", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_rollback_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const v1 = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: v1.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  const secondDeployment = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: { ...sampleManifest(), version: "2.0.0" },
  });
  await service.applyDeployment({
    deploymentId: secondDeployment.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
  });

  const before = await service.listDeployments({ groupId: "demo-app" });
  await service.rollbackGroup({
    spaceId: "space_deploy",
    groupId: "demo-app",
    targetDeploymentId: v1.id,
    advancedAt: "2026-04-27T00:03:00.000Z",
  });
  const after = await service.listDeployments({ groupId: "demo-app" });

  // Deployment count is unchanged; rollback is a pointer move per Core
  // spec § 15 (no new Deployment is created).
  assert.equal(before.length, after.length);
  assert.equal(
    (await store.getGroupHead("demo-app"))?.current_deployment_id,
    v1.id,
  );

  const secondAfter = await service.getDeployment(secondDeployment.id);
  assert.equal(secondAfter?.status, "rolled-back");
  assert.ok(
    secondAfter?.conditions.some((condition) =>
      condition.type === "RolledBack" && condition.status === "true"
    ),
  );
});

Deno.test("deploy: rollback target must be retained (applied or rolled-back)", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_retain_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  // Target is a fresh `resolved` Deployment that has never been applied.
  const target = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_deploy",
        groupId: "demo-app",
        targetDeploymentId: target.id,
      }),
    /is not retained/,
  );
});

// Phase 17D — preflight / drift / CAS hooks. These tests exercise the
// Phase 17D extensions to the apply / rollback path: read-set re-validation,
// descriptor-closure drift detection, source-snapshot validation, and
// optimistic-lock GroupHead CAS. The hooks live on
// `ApplyDeploymentInput` / `RollbackGroupInput` and are injected by callers
// (apply_worker, rollout, runtime-agent) in production deployments.

Deno.test("apply rejects a must-replan stale read set without mutating current activation", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_must_replan_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: resolved.id,
        appliedAt: "2026-04-27T00:01:00.000Z",
        readSetValidator: (_d) => ({
          ok: false,
          reason: "ReadSetStale",
          message: "descriptor providers/postgres advanced after resolve",
          impact: "must-replan",
        }),
      }),
    /ReadSetStale/,
  );

  // Apply rejected before any state transition: GroupHead never advanced and
  // the resolved Deployment is still `resolved` (not `applying` / `failed`).
  assert.equal(await store.getGroupHead("demo-app"), undefined);
  const reread = await store.getDeployment(resolved.id);
  assert.equal(reread?.status, "resolved");
});

Deno.test("apply atomic commit rejects a stale group pointer race without creating activation", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_cas_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  // Seed a prior applied deployment so GroupHead has a concrete current id.
  const v1 = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: v1.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  // Attempt to apply secondDeployment while pinning the wrong expected current deployment.
  const secondDeployment = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: { ...sampleManifest(), version: "2.0.0" },
  });
  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: secondDeployment.id,
        appliedAt: "2026-04-27T00:02:00.000Z",
        expectedCurrentDeploymentId: "deployment_phantom_other",
      }),
    /stale group head/i,
  );

  // GroupHead still points at v1; secondDeployment transitioned to `failed` so the
  // lifecycle is auditable but no pointer was advanced.
  const head = await store.getGroupHead("demo-app");
  assert.equal(head?.current_deployment_id, v1.id);
  const secondAfter = await store.getDeployment(secondDeployment.id);
  assert.equal(secondAfter?.status, "failed");
});

Deno.test("apply reruns validation for must-revalidate read sets before activation", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_revalidate_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  let validatorCalls = 0;
  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: resolved.id,
        appliedAt: "2026-04-27T00:01:00.000Z",
        readSetValidator: (deployment) => {
          validatorCalls += 1;
          // Re-validate by inspecting the resolved-graph digest against a
          // (here synthetic) "current" provider snapshot. A mismatch reports
          // must-revalidate so the apply aborts before activation.commit.
          assert.ok(deployment.resolution.resolved_graph.digest.length > 0);
          return {
            ok: false,
            reason: "ReadSetMustRevalidate",
            impact: "must-revalidate",
          };
        },
      }),
    /ReadSetMustRevalidate/,
  );

  assert.equal(validatorCalls, 1);
  // Must-revalidate path still aborts before activation; GroupHead unchanged.
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("apply preserves source snapshot validation hooks", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_source_snapshot_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  // Source-snapshot validator simulates the artifact integrity check the
  // live provider contract performs (Core spec § 13 step 4).
  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: resolved.id,
        appliedAt: "2026-04-27T00:01:00.000Z",
        sourceSnapshotValidator: (_d) => ({
          ok: false,
          reason: "SourceSnapshotInvalid",
          message: "artifact digest signature failed verification",
        }),
      }),
    /SourceSnapshotInvalid/,
  );

  // Hook fires before any state mutation: deployment is still `resolved`.
  const reread = await store.getDeployment(resolved.id);
  assert.equal(reread?.status, "resolved");

  // Successful validator does not block apply.
  const second = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
    id: "deployment_source_snapshot_ok",
  });
  const applied = await service.applyDeployment({
    deploymentId: second.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
    sourceSnapshotValidator: () => ({ ok: true }),
  });
  assert.equal(applied.status, "applied");
});

Deno.test("rollback is blocked when retained descriptor graph digests drift", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_rb_drift_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const v1 = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: v1.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  const secondDeployment = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: { ...sampleManifest(), version: "2.0.0" },
  });
  await service.applyDeployment({
    deploymentId: secondDeployment.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
  });

  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_deploy",
        groupId: "demo-app",
        targetDeploymentId: v1.id,
        descriptorClosureValidator: (target) => {
          // Simulate the live provider observing a closure-digest drift since
          // the rollback target was applied. The retained closure digest must
          // match the provider-observed snapshot.
          assert.equal(target.id, v1.id);
          return {
            ok: false,
            reason: "RetainedDescriptorClosureDrifted",
            message: "providers/postgres@1.0.0 advanced under same alias",
          };
        },
      }),
    /RetainedDescriptorClosureDrifted/,
  );

  // GroupHead must still point at secondDeployment — the rollback was blocked before any
  // pointer move.
  assert.equal(
    (await store.getGroupHead("demo-app"))?.current_deployment_id,
    secondDeployment.id,
  );
});

Deno.test("rollback is blocked when retained Core artifacts are unavailable", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_rb_unavail_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const v1 = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: v1.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  const secondDeployment = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: { ...sampleManifest(), version: "2.0.0" },
  });
  await service.applyDeployment({
    deploymentId: secondDeployment.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
  });

  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_deploy",
        groupId: "demo-app",
        targetDeploymentId: v1.id,
        artifactAvailabilityValidator: () => ({
          ok: false,
          reason: "RetainedArtifactUnavailable",
          message: "registry returned 404 for artifact pinned by closure",
        }),
      }),
    /RetainedArtifactUnavailable/,
  );

  // Pointer still at secondDeployment — apply rejects without advancing.
  assert.equal(
    (await store.getGroupHead("demo-app"))?.current_deployment_id,
    secondDeployment.id,
  );
});

Deno.test("rollback is blocked when retained artifact digest changed", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_rb_digest_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const v1 = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  await service.applyDeployment({
    deploymentId: v1.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  const secondDeployment = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: { ...sampleManifest(), version: "2.0.0" },
  });
  await service.applyDeployment({
    deploymentId: secondDeployment.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
  });

  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_deploy",
        groupId: "demo-app",
        targetDeploymentId: v1.id,
        artifactDigestValidator: () => ({
          ok: false,
          reason: "RetainedArtifactDigestChanged",
          message:
            "registry returned new digest for artifact pinned by closure",
        }),
      }),
    /RetainedArtifactDigestChanged/,
  );

  assert.equal(
    (await store.getGroupHead("demo-app"))?.current_deployment_id,
    secondDeployment.id,
  );
});
