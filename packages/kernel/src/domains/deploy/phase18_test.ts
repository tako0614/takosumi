// Phase 18 fix tests — covering C1 (multi-cloud partial-success rollback),
// C2 (descriptor closure determinism on profile switch), H1 (preview-mode
// resolve does not persist), H2 (rollback validators always run, defaulted),
// and H4 (approval gate enforced at apply preflight).
//
// Each fix has a focused 1-2 test footprint. Tests deliberately avoid wider
// invariants already covered by `plan_apply_test.ts` /
// `core_conformance_test.ts` so a regression in a Phase 18 fix surfaces here
// directly.

import assert from "node:assert/strict";
import {
  DEFAULT_ROLLBACK_VALIDATORS,
  DeploymentService,
  InMemoryDeploymentStore,
} from "./deployment_service.ts";
import type {
  DeploymentProviderAdapter,
  OperationOutcome,
  PlannedOperation,
} from "./apply_orchestrator.ts";
import { compileManifestToAppSpec } from "./compiler.ts";
import { buildDescriptorClosure } from "./descriptor_closure.ts";
import type { Deployment, IsoTimestamp } from "takosumi-contract";
import type { PublicDeployManifest } from "./types.ts";

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

// -- H1: preview mode --------------------------------------------------------

Deno.test("H1: resolveDeploymentWithMode mode='preview' returns persisted=false and skips store write", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_preview_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const result = await service.resolveDeploymentWithMode({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
    mode: "preview",
  });

  assert.equal(result.persisted, false);
  assert.equal(result.deployment.id, "deployment_preview_1");
  assert.equal(result.deployment.status, "resolved");
  // Store MUST NOT contain the preview deployment.
  assert.equal(await store.getDeployment("deployment_preview_1"), undefined);
  assert.deepEqual(await store.listDeployments({}), []);
  // Returned record is still deep-frozen so callers cannot mutate it.
  assert.equal(Object.isFrozen(result.deployment), true);
});

Deno.test("H1: default mode (resolve) persists Deployment to store", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_persist_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const result = await service.resolveDeploymentWithMode({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  assert.equal(result.persisted, true);
  const stored = await store.getDeployment("deployment_persist_1");
  assert.equal(stored?.id, "deployment_persist_1");
  assert.equal(stored?.status, "resolved");
});

// -- H4: approval gate enforcement ------------------------------------------

Deno.test("H4: apply blocks with ApprovalRequired condition when require-approval policy decision is unfilled", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_h4_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  // Inject a require-approval policy decision via direct store write so the
  // apply preflight observes the gate without depending on the resolution
  // pipeline producing one organically.
  const seeded: Deployment = {
    ...resolved,
    policy_decisions: [
      {
        id: "policy_require_approval_1",
        gateGroup: "deployment-gates",
        gate: "operation-planning",
        decision: "require-approval",
        subjectDigest: "sha256:approval-subject" as never,
        decidedAt: "2026-04-27T00:00:30.000Z" as IsoTimestamp,
      },
    ],
  };
  await store.putDeployment(seeded);

  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  assert.equal(applied.status, "failed");
  assert.equal(applied.finalized_at, "2026-04-27T00:01:00.000Z");
  assert.ok(
    applied.conditions.some((condition) =>
      condition.type === "ApprovalRequired" && condition.status === "true"
    ),
    "expected ApprovalRequired condition on the failed Deployment",
  );
  // GroupHead must not have advanced.
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("H4: apply succeeds when require-approval policy decision is satisfied by approval payload", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_h4_2",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });
  const seeded: Deployment = {
    ...resolved,
    policy_decisions: [
      {
        id: "policy_require_approval_2",
        gateGroup: "deployment-gates",
        gate: "operation-planning",
        decision: "require-approval",
        subjectDigest: "sha256:approval-subject" as never,
        decidedAt: "2026-04-27T00:00:30.000Z" as IsoTimestamp,
      },
    ],
  };
  await store.putDeployment(seeded);

  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
    approval: {
      approved_by: "acct_admin",
      approved_at: "2026-04-27T00:00:45.000Z",
      policy_decision_id: "policy_require_approval_2",
    },
  });

  assert.equal(applied.status, "applied");
  assert.equal(
    (await store.getGroupHead("demo-app"))?.current_deployment_id,
    applied.id,
  );
});

// -- C1: multi-cloud partial-success rollback -------------------------------

Deno.test("C1: provider failure after partial success reverts committed operations and emits RolledBack condition", async () => {
  const store = new InMemoryDeploymentStore();
  const reverted: PlannedOperation[] = [];
  // Adapter succeeds for everything except runtime.deploy. The orchestrator
  // executes descriptor.resolve / component.project / resource.bind /
  // access-path.materialize / output.resolve before runtime.deploy in
  // canonical order, so several operations will already be committed when
  // runtime.deploy fails.
  const adapter: DeploymentProviderAdapter = {
    materialize(
      _deployment: Deployment,
      operation: PlannedOperation,
    ): OperationOutcome {
      if (operation.kind === "runtime.deploy") {
        return {
          success: false,
          reason: "RuntimeMaterializationFailed",
          message: "synthetic multi-cloud failure",
        };
      }
      return { success: true, reason: "OperationApplied" };
    },
    rollback(
      _deployment: Deployment,
      operation: PlannedOperation,
    ): OperationOutcome {
      reverted.push(operation);
      return { success: true, reason: "OperationReverted" };
    },
  };
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_c1_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    providerAdapter: adapter,
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
  // At least one committed op preceded the failing runtime.deploy, so the
  // rollback path MUST have invoked the adapter at least once.
  assert.ok(
    reverted.length > 0,
    "expected at least one operation to be reverted before runtime.deploy failure",
  );
  // RolledBack terminal condition is emitted exactly once.
  const rolledBack = applied.conditions.filter((condition) =>
    condition.type === "RolledBack" && condition.status === "true"
  );
  assert.equal(rolledBack.length, 1);
  // Reason is the success-shaped "RolledBack" (not RolledBackPartial) because
  // the adapter implemented rollback successfully.
  assert.equal(rolledBack[0].reason, "RolledBack");
  // Per-operation revert conditions are recorded for observability.
  const opReverted = applied.conditions.filter((condition) =>
    condition.type === "OperationRolledBack" && condition.status === "true"
  );
  assert.ok(
    opReverted.length === reverted.length,
    `expected ${reverted.length} OperationRolledBack conditions, got ${opReverted.length}`,
  );
  // GroupHead must not have advanced.
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("C1: adapter without rollback method emits RolledBackPartial terminal condition", async () => {
  const store = new InMemoryDeploymentStore();
  // Adapter omits `rollback` entirely so committed ops are flagged
  // unrevertable.
  const adapter: DeploymentProviderAdapter = {
    materialize(
      _deployment: Deployment,
      operation: PlannedOperation,
    ): OperationOutcome {
      if (operation.kind === "runtime.deploy") {
        return {
          success: false,
          reason: "RuntimeMaterializationFailed",
          message: "synthetic failure with no rollback impl",
        };
      }
      return { success: true, reason: "OperationApplied" };
    },
  };
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_c1_partial_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    providerAdapter: adapter,
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
  const rolledBack = applied.conditions.find((condition) =>
    condition.type === "RolledBack"
  );
  assert.ok(rolledBack);
  // Adapter has no rollback impl so the terminal condition is partial.
  assert.equal(rolledBack.reason, "RolledBackPartial");
  // Each committed op surfaces an OperationRollbackFailed condition.
  const failed = applied.conditions.filter((condition) =>
    condition.type === "OperationRollbackFailed"
  );
  assert.ok(failed.length > 0);
  // GroupHead never advanced.
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("C1: provider materialize throw finalizes failed Deployment and rolls back committed operations", async () => {
  const store = new InMemoryDeploymentStore();
  const reverted: PlannedOperation[] = [];
  const adapter: DeploymentProviderAdapter = {
    materialize(
      _deployment: Deployment,
      operation: PlannedOperation,
    ): OperationOutcome {
      if (operation.kind === "runtime.deploy") {
        throw new Error("provider SDK timeout");
      }
      return { success: true, reason: "OperationApplied" };
    },
    rollback(
      _deployment: Deployment,
      operation: PlannedOperation,
    ): OperationOutcome {
      reverted.push(operation);
      return { success: true, reason: "OperationReverted" };
    },
  };
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_throw_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    providerAdapter: adapter,
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
  assert.equal(applied.finalized_at, "2026-04-27T00:01:00.000Z");
  assert.ok(reverted.length > 0);
  assert.ok(
    applied.conditions.some((condition) =>
      condition.type === "ApplyFailed" &&
      condition.reason === "ProviderMaterializationThrew" &&
      condition.message === "provider SDK timeout"
    ),
  );
  assert.equal((await store.getDeployment(resolved.id))?.status, "failed");
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("C1: stale GroupHead CAS rolls back successful provider operations", async () => {
  const store = new InMemoryDeploymentStore();
  const reverted: PlannedOperation[] = [];
  const adapter: DeploymentProviderAdapter = {
    materialize(): OperationOutcome {
      return { success: true, reason: "OperationApplied" };
    },
    rollback(
      _deployment: Deployment,
      operation: PlannedOperation,
    ): OperationOutcome {
      reverted.push(operation);
      return { success: true, reason: "OperationReverted" };
    },
  };
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_cas_rollback_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    providerAdapter: adapter,
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

  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: secondDeployment.id,
        appliedAt: "2026-04-27T00:02:00.000Z",
        expectedCurrentDeploymentId: "deployment_phantom",
      }),
    /stale group head/i,
  );

  assert.ok(reverted.length > 0);
  const failed = await store.getDeployment(secondDeployment.id);
  assert.equal(failed?.status, "failed");
  assert.ok(
    failed?.conditions.some((condition) =>
      condition.type === "OperationRolledBack"
    ),
  );
  assert.equal(
    (await store.getGroupHead({ spaceId: "space_deploy", groupId: "demo-app" }))
      ?.current_deployment_id,
    v1.id,
  );
});

// -- C2: descriptor closure determinism on profile switch -------------------

Deno.test("C2: differing effectiveRuntimeCapabilities on AppSpec yields a different descriptor_closure digest", () => {
  // Compile the same authoring manifest twice and then synthesise a
  // post-profile-merge AppSpec by stamping `effectiveRuntimeCapabilities`
  // onto the second spec. The descriptor seeds (components / resources /
  // routes / outputs) are otherwise byte-identical, so any digest
  // delta must come from the C2 fold-in.
  const manifest: PublicDeployManifest = {
    name: "demo-app",
    version: "1.0.0",
    compute: {
      web: { type: "js-worker" },
    },
  };

  const baseSpec = compileManifestToAppSpec(manifest);
  // Profile-merged AppSpec: same authoring shape, but the profile selection
  // contributed a runtime capability.
  const profiledSpec = {
    ...baseSpec,
    effectiveRuntimeCapabilities: { web: ["edge-cdn"] },
  };

  // Sanity: bare spec carries no merged capabilities.
  assert.deepEqual(baseSpec.effectiveRuntimeCapabilities ?? {}, {});

  const baseClosure = buildDescriptorClosure({
    appSpec: baseSpec,
    resolvedAt: "2026-04-30T00:00:00.000Z" as IsoTimestamp,
  });
  const profiledClosure = buildDescriptorClosure({
    appSpec: profiledSpec,
    resolvedAt: "2026-04-30T00:00:00.000Z" as IsoTimestamp,
  });

  // The descriptor seeds are identical (same components / resources /
  // routes), but the effective capability map differs. The closure digest
  // MUST therefore differ — that is the C2 invariant.
  assert.notEqual(baseClosure.closureDigest, profiledClosure.closureDigest);
});

Deno.test("C2: identical effective capability maps yield identical closure digests", () => {
  const manifest: PublicDeployManifest = {
    name: "demo-app",
    version: "1.0.0",
    compute: {
      web: { type: "js-worker" },
    },
  };

  const baseSpec = compileManifestToAppSpec(manifest);
  // Two AppSpecs with identical effective capability maps MUST collapse to
  // the same closure digest — the C2 fold-in is deterministic.
  const a = {
    ...baseSpec,
    effectiveRuntimeCapabilities: { web: ["edge-cdn"] },
  };
  const b = {
    ...baseSpec,
    effectiveRuntimeCapabilities: { web: ["edge-cdn"] },
  };
  const closureA = buildDescriptorClosure({
    appSpec: a,
    resolvedAt: "2026-04-30T00:00:00.000Z" as IsoTimestamp,
  });
  const closureB = buildDescriptorClosure({
    appSpec: b,
    resolvedAt: "2026-04-30T00:00:00.000Z" as IsoTimestamp,
  });

  assert.equal(closureA.closureDigest, closureB.closureDigest);
});

Deno.test("C2: capability ordering does not change the closure digest (canonical sort)", () => {
  const manifest: PublicDeployManifest = {
    name: "demo-app",
    version: "1.0.0",
    compute: {
      web: { type: "js-worker" },
    },
  };

  const baseSpec = compileManifestToAppSpec(manifest);
  // Insertion-order-different but value-identical capability maps must
  // produce the same digest — the closure builder sorts before folding.
  const a = {
    ...baseSpec,
    effectiveRuntimeCapabilities: { web: ["edge-cdn", "kv"] },
  };
  const b = {
    ...baseSpec,
    effectiveRuntimeCapabilities: { web: ["kv", "edge-cdn"] },
  };
  const closureA = buildDescriptorClosure({
    appSpec: a,
    resolvedAt: "2026-04-30T00:00:00.000Z" as IsoTimestamp,
  });
  const closureB = buildDescriptorClosure({
    appSpec: b,
    resolvedAt: "2026-04-30T00:00:00.000Z" as IsoTimestamp,
  });
  assert.equal(closureA.closureDigest, closureB.closureDigest);
});

// -- H2: rollback validators required + default bundle ----------------------

Deno.test("H2: DeploymentStore exposes default rollback validators (always-ok) so rollback never silently skips", async () => {
  // The exported DEFAULT_ROLLBACK_VALIDATORS bundle MUST contain three
  // distinct validator slots — descriptorClosure, artifactAvailability,
  // artifactDigest — each emitting the stamped "RollbackPreflightDefault"
  // reason so observers can distinguish "validator did not run" from
  // "validator ran with the no-snapshot default".
  assert.ok(
    typeof DEFAULT_ROLLBACK_VALIDATORS.descriptorClosureValidator ===
      "function",
  );
  assert.ok(
    typeof DEFAULT_ROLLBACK_VALIDATORS.artifactAvailabilityValidator ===
      "function",
  );
  assert.ok(
    typeof DEFAULT_ROLLBACK_VALIDATORS.artifactDigestValidator === "function",
  );

  // Build a synthetic deployment to feed the validators. The defaults do
  // not inspect it — they only stamp the "RollbackPreflightDefault" reason —
  // so any deployment shape suffices.
  const synthetic = {} as Deployment;
  for (
    const validator of [
      DEFAULT_ROLLBACK_VALIDATORS.descriptorClosureValidator,
      DEFAULT_ROLLBACK_VALIDATORS.artifactAvailabilityValidator,
      DEFAULT_ROLLBACK_VALIDATORS.artifactDigestValidator,
    ]
  ) {
    const finding = await validator(synthetic);
    assert.equal(finding.ok, true);
    assert.equal(finding.reason, "RollbackPreflightDefault");
  }

  // The in-memory store MUST surface the same defaults via
  // `getDefaultRollbackValidators` so callers that bypass injection still
  // get the baseline behaviour.
  const store = new InMemoryDeploymentStore();
  assert.ok(typeof store.getDefaultRollbackValidators === "function");
  const fromStore = store.getDefaultRollbackValidators!();
  assert.equal(typeof fromStore.descriptorClosureValidator, "function");
  assert.equal(typeof fromStore.artifactAvailabilityValidator, "function");
  assert.equal(typeof fromStore.artifactDigestValidator, "function");
});

Deno.test("H2: rollback path uses store-provided validators when caller omits them", async () => {
  let descriptorClosureCalls = 0;
  let artifactAvailabilityCalls = 0;
  let artifactDigestCalls = 0;
  // Subclass the in-memory store to inject custom defaults so we can observe
  // that the rollback path consults them when the caller does not pass any.
  class TrackingStore extends InMemoryDeploymentStore {
    override getDefaultRollbackValidators() {
      return {
        descriptorClosureValidator: () => {
          descriptorClosureCalls += 1;
          return { ok: true, reason: "TrackingDefault" };
        },
        artifactAvailabilityValidator: () => {
          artifactAvailabilityCalls += 1;
          return { ok: true, reason: "TrackingDefault" };
        },
        artifactDigestValidator: () => {
          artifactDigestCalls += 1;
          return { ok: true, reason: "TrackingDefault" };
        },
      };
    }
  }
  const store = new TrackingStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_h2_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  // Seed two applied deployments so the rollback target is retained.
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

  await service.rollbackGroup({
    spaceId: "space_deploy",
    groupId: "demo-app",
    targetDeploymentId: v1.id,
    advancedAt: "2026-04-27T00:03:00.000Z",
  });

  // All three store-provided default validators MUST have been invoked.
  assert.equal(descriptorClosureCalls, 1);
  assert.equal(artifactAvailabilityCalls, 1);
  assert.equal(artifactDigestCalls, 1);
});
