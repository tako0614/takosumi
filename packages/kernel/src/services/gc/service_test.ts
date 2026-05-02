import assert from "node:assert/strict";
import { InMemoryProtectedReferenceStore } from "../../domains/supply-chain/mod.ts";
import { GcRetentionService } from "./mod.ts";

Deno.test("GC retains object with active ProtectedReference", async () => {
  const protectedReferences = new InMemoryProtectedReferenceStore();
  await protectedReferences.put({
    id: "protect_artifact",
    refType: "PreparedArtifact",
    refId: "artifact_expired",
    reason: "rollback-window",
    expiresAt: "2026-04-30T00:00:00.000Z",
    createdAt: "2026-04-27T00:00:00.000Z",
  });
  const service = new GcRetentionService({ protectedReferences });

  const decision = await service.decidePreparedArtifact({
    id: "artifact_expired",
    digest: "sha256:artifact",
    storageRef: "s3://prepared/artifact_expired",
    expiresAt: "2026-04-28T00:00:00.000Z",
    sourceDigest: "sha256:source",
    buildInputDigest: "sha256:build-input",
    buildEnvironmentDigest: "sha256:build-env",
    resolvedGraphDigest: "sha256:graph",
    packageResolutionDigest: "sha256:packages",
    createdAt: "2026-04-27T00:00:00.000Z",
  }, "2026-04-29T00:00:00.000Z");

  assert.equal(decision.retain, true);
  assert.equal(decision.deleteOperation, undefined);
  assert.deepEqual(decision.reasons.map((reason) => reason.code), [
    "protected-reference",
  ]);
  assert.deepEqual(decision.reasons[0]?.referenceIds, ["protect_artifact"]);
});

Deno.test("GC keeps old WorkloadRevision during rollback window", async () => {
  const service = new GcRetentionService({
    protectedReferences: new InMemoryProtectedReferenceStore(),
  });

  const retained = await service.decideWorkloadRevision({
    id: "workload_revision_old",
    active: false,
    supersededAt: "2026-04-27T01:00:00.000Z",
    rollbackWindowExpiresAt: "2026-04-30T00:00:00.000Z",
  }, "2026-04-29T00:00:00.000Z");
  const expired = await service.decideWorkloadRevision({
    id: "workload_revision_expired",
    active: false,
    supersededAt: "2026-04-27T01:00:00.000Z",
    rollbackWindowExpiresAt: "2026-04-28T00:00:00.000Z",
  }, "2026-04-29T00:00:00.000Z");

  assert.equal(retained.retain, true);
  assert.equal(retained.reasons[0]?.code, "rollback-window");
  assert.equal(expired.retain, false);
  assert.equal(expired.deleteOperation?.dryRun, true);
});

Deno.test("GC plans prepared artifact/resource/provider package decisions without deleting", async () => {
  const service = new GcRetentionService({
    protectedReferences: new InMemoryProtectedReferenceStore(),
  });

  const plan = await service.planDryRun({
    now: "2026-04-29T00:00:00.000Z",
    preparedArtifacts: [{
      id: "artifact_expired",
      digest: "sha256:artifact-expired",
      storageRef: "s3://prepared/artifact_expired",
      expiresAt: "2026-04-28T00:00:00.000Z",
      sourceDigest: "sha256:source",
      buildInputDigest: "sha256:build-input",
      buildEnvironmentDigest: "sha256:build-env",
      resolvedGraphDigest: "sha256:graph",
      packageResolutionDigest: "sha256:packages",
      createdAt: "2026-04-27T00:00:00.000Z",
    }, {
      id: "artifact_ttl",
      digest: "sha256:artifact-ttl",
      storageRef: "s3://prepared/artifact_ttl",
      expiresAt: "2026-04-30T00:00:00.000Z",
      sourceDigest: "sha256:source",
      buildInputDigest: "sha256:build-input",
      buildEnvironmentDigest: "sha256:build-env",
      resolvedGraphDigest: "sha256:graph",
      packageResolutionDigest: "sha256:packages",
      createdAt: "2026-04-27T00:00:00.000Z",
    }],
    resources: [{
      id: "resource_db",
      activeBindingCount: 1,
    }, {
      id: "resource_deleted",
      activeBindingCount: 0,
      providerResourceActive: false,
    }],
    providerPackages: [{
      digest: "sha256:provider-active",
      activeMaterializationIds: ["materialization_current"],
    }, {
      digest: "sha256:provider-rollback",
      rollbackMaterializations: [{
        id: "materialization_previous",
        rollbackWindowExpiresAt: "2026-04-30T00:00:00.000Z",
      }],
    }, {
      digest: "sha256:provider-unused",
    }],
  });

  const decisions = new Map(
    plan.decisions.map((decision) => [decision.refId, decision]),
  );
  assert.equal(decisions.get("artifact_expired")?.retain, false);
  assert.equal(
    decisions.get("artifact_ttl")?.reasons[0]?.code,
    "ttl-not-expired",
  );
  assert.equal(
    decisions.get("resource_db")?.reasons[0]?.code,
    "active-binding",
  );
  assert.equal(decisions.get("resource_deleted")?.retain, false);
  assert.equal(
    decisions.get("sha256:provider-active")?.reasons[0]?.code,
    "active-materialization",
  );
  assert.equal(
    decisions.get("sha256:provider-rollback")?.reasons[0]?.code,
    "rollback-materialization",
  );
  assert.equal(decisions.get("sha256:provider-unused")?.retain, false);
  assert.deepEqual(
    plan.deleteOperations.map((
      operation,
    ) => [operation.refType, operation.refId]),
    [
      ["PreparedArtifact", "artifact_expired"],
      ["ResourceInstance", "resource_deleted"],
      ["ProviderPackage", "sha256:provider-unused"],
    ],
  );
});

Deno.test("GC retains mirrored external image through rollback window", async () => {
  const service = new GcRetentionService({
    protectedReferences: new InMemoryProtectedReferenceStore(),
  });

  const retained = await service.decideMirroredArtifact({
    ref: "registry.example.test/demo:1.0.0",
    digest: "sha256:mirrored",
    retentionDeadline: "2026-04-30T00:00:00.000Z",
  }, "2026-04-29T00:00:00.000Z");
  const expired = await service.decideMirroredArtifact({
    ref: "registry.example.test/demo:0.9.0",
    digest: "sha256:old-mirror",
    retentionDeadline: "2026-04-28T00:00:00.000Z",
  }, "2026-04-29T00:00:00.000Z");

  assert.equal(retained.retain, true);
  assert.equal(retained.reasons[0]?.code, "rollback-window");
  assert.equal(expired.retain, false);
  assert.equal(expired.deleteOperation?.dryRun, true);
});

Deno.test("GC retains deploy retained artifacts required for rollback", async () => {
  const service = new GcRetentionService({
    protectedReferences: new InMemoryProtectedReferenceStore(),
  });

  const retained = await service.decideRetainedDeployArtifact({
    id: "descriptor-closure:sha256:closure",
    kind: "descriptor-closure",
    digest: "sha256:closure",
    retainedAt: "2026-04-27T00:00:00.000Z",
    retainedUntil: "2026-04-30T00:00:00.000Z",
    sourceActivationId: "activation_v1",
  }, "2026-04-29T00:00:00.000Z");
  const expired = await service.decideRetainedDeployArtifact({
    id: "app-release:sha256:old",
    kind: "app-release",
    digest: "sha256:old",
    retainedAt: "2026-04-27T00:00:00.000Z",
    retainedUntil: "2026-04-28T00:00:00.000Z",
    sourceActivationId: "activation_old",
  }, "2026-04-29T00:00:00.000Z");

  assert.equal(retained.retain, true);
  assert.equal(retained.reasons[0]?.code, "rollback-window");
  assert.deepEqual(retained.reasons[0]?.referenceIds, ["activation_v1"]);
  assert.equal(expired.retain, false);
  assert.equal(expired.deleteOperation?.refType, "RetainedDeployArtifact");
});
