import assert from "node:assert/strict";
import {
  InMemoryPreparedArtifactStore,
  InMemoryProtectedReferenceStore,
  InMemorySupplyChainRecordStore,
} from "../../domains/supply-chain/mod.ts";
import { SupplyChainService } from "./mod.ts";

Deno.test("prepare artifact request creates artifact, record, mirror decision, and protected windows", async () => {
  const service = newService([
    "artifact_1",
    "record_1",
    "protect_active",
    "protect_rollback",
  ]);

  const result = await service.prepareArtifactRequest({
    storageRef: "s3://prepared/artifact_1",
    expiresAt: "2026-04-28T00:00:00.000Z",
    sourceDigest: "sha256:source",
    buildInputDigest: "sha256:build-input",
    buildEnvironmentDigest: "sha256:build-env",
    resolvedGraphDigest: "sha256:graph",
    packageResolutionDigest: "sha256:packages",
    artifactDigest: "sha256:artifact",
    providerPackageDigests: ["sha256:provider"],
    resourceContractPackageDigests: ["sha256:resource-contract"],
    nativeSchemaDigests: ["sha256:schema"],
    provenanceRef: "prov://artifact_1",
    signatureRef: "sig://artifact_1",
    createdAt: "2026-04-27T00:00:00.000Z",
    mirror: {
      sourceArtifactRef: "registry.example.test/demo:1.0.0",
      sourceArtifactDigest: "sha256:artifact",
      packageResolutionDigest: "sha256:packages",
      policy: {
        mirrorExternalImages: true,
        retainForRollbackWindow: true,
      },
      retentionDeadline: "2026-04-30T00:00:00.000Z",
      provenanceRef: "prov://artifact_1",
    },
    protection: {
      activationId: "activation_current",
      activeExpiresAt: "2026-04-29T00:00:00.000Z",
      rollbackExpiresAt: "2026-04-30T00:00:00.000Z",
    },
  });

  assert.equal(result.reused, false);
  assert.equal(result.artifact.id, "artifact_1");
  assert.equal(result.supplyChainRecord.id, "record_1");
  assert.equal(result.supplyChainRecord.artifactDigest, "sha256:artifact");
  assert.deepEqual(result.supplyChainRecord.signatureRefs, [
    "sig://artifact_1",
  ]);
  assert.equal(
    result.mirror?.mirroredArtifactRef,
    "mirror://sha256%3Aartifact",
  );
  assert.equal(result.mirror?.retentionDeadline, "2026-04-30T00:00:00.000Z");
  assert.deepEqual(
    result.protectedReferences.map((
      ref,
    ) => [ref.id, ref.reason, ref.expiresAt]),
    [
      ["protect_active", "current-activation", "2026-04-29T00:00:00.000Z"],
      ["protect_rollback", "rollback-window", "2026-04-30T00:00:00.000Z"],
    ],
  );
});

Deno.test("prepare artifact request reuses matching prepared artifact", async () => {
  const stores = storesFixture();
  await stores.artifacts.put({
    id: "artifact_existing",
    digest: "sha256:artifact",
    storageRef: "s3://prepared/artifact_existing",
    expiresAt: "2026-04-28T00:00:00.000Z",
    sourceDigest: "sha256:source",
    buildInputDigest: "sha256:build-input",
    buildEnvironmentDigest: "sha256:build-env",
    resolvedGraphDigest: "sha256:graph",
    packageResolutionDigest: "sha256:packages",
    createdAt: "2026-04-27T00:00:00.000Z",
  });
  const service = new SupplyChainService({
    stores,
    idFactory: sequenceIds(["record_reuse"]),
    clock: () => new Date("2026-04-27T00:05:00.000Z"),
  });

  const result = await service.prepareArtifactRequest({
    storageRef: "s3://ignored/new",
    expiresAt: "2026-04-28T00:00:00.000Z",
    sourceDigest: "sha256:source",
    buildInputDigest: "sha256:build-input",
    buildEnvironmentDigest: "sha256:build-env",
    resolvedGraphDigest: "sha256:graph",
    packageResolutionDigest: "sha256:packages",
    artifactDigest: "sha256:artifact",
    readSetValid: true,
    approvalStateValid: true,
  });

  assert.equal(result.reused, true);
  assert.equal(result.artifact.id, "artifact_existing");
  assert.equal((await stores.artifacts.list()).length, 1);
  assert.equal(result.supplyChainRecord.id, "record_reuse");
});

Deno.test("prepare artifact request rejects digest collision when reuse validation fails", async () => {
  const stores = storesFixture();
  await stores.artifacts.put({
    id: "artifact_existing",
    digest: "sha256:artifact",
    storageRef: "s3://prepared/artifact_existing",
    expiresAt: "2026-04-28T00:00:00.000Z",
    sourceDigest: "sha256:source-a",
    buildInputDigest: "sha256:build-input",
    buildEnvironmentDigest: "sha256:build-env",
    resolvedGraphDigest: "sha256:graph",
    packageResolutionDigest: "sha256:packages",
    createdAt: "2026-04-27T00:00:00.000Z",
  });
  const service = new SupplyChainService({
    stores,
    idFactory: sequenceIds(["unused"]),
    clock: () => new Date("2026-04-27T00:05:00.000Z"),
  });

  await assert.rejects(
    () =>
      service.prepareArtifactRequest({
        storageRef: "s3://prepared/new",
        expiresAt: "2026-04-28T00:00:00.000Z",
        sourceDigest: "sha256:source-b",
        buildInputDigest: "sha256:build-input",
        buildEnvironmentDigest: "sha256:build-env",
        resolvedGraphDigest: "sha256:graph",
        packageResolutionDigest: "sha256:packages",
        artifactDigest: "sha256:artifact",
      }),
    /PreparedArtifact digest exists but cannot be reused/,
  );
  assert.equal((await stores.artifacts.list()).length, 1);
  assert.equal((await stores.records.list()).length, 0);
});

Deno.test("prepare artifact request does not reuse prepared artifact without explicit read set and approval validation", async () => {
  const stores = storesFixture();
  await stores.artifacts.put({
    id: "artifact_existing",
    digest: "sha256:artifact",
    storageRef: "s3://prepared/artifact_existing",
    expiresAt: "2026-04-28T00:00:00.000Z",
    sourceDigest: "sha256:source",
    buildInputDigest: "sha256:build-input",
    buildEnvironmentDigest: "sha256:build-env",
    resolvedGraphDigest: "sha256:graph",
    packageResolutionDigest: "sha256:packages",
    createdAt: "2026-04-27T00:00:00.000Z",
  });
  const service = new SupplyChainService({
    stores,
    idFactory: sequenceIds(["unused"]),
    clock: () => new Date("2026-04-27T00:05:00.000Z"),
  });

  await assert.rejects(
    () =>
      service.prepareArtifactRequest({
        storageRef: "s3://ignored/new",
        expiresAt: "2026-04-28T00:00:00.000Z",
        sourceDigest: "sha256:source",
        buildInputDigest: "sha256:build-input",
        buildEnvironmentDigest: "sha256:build-env",
        resolvedGraphDigest: "sha256:graph",
        packageResolutionDigest: "sha256:packages",
        artifactDigest: "sha256:artifact",
      }),
    (error) => {
      assert.match(String(error), /PreparedArtifact digest exists/);
      const details = (error as { details?: unknown }).details as {
        rejectionReasons?: readonly string[];
      } | undefined;
      assert.deepEqual(details?.rejectionReasons, [
        "read-set-invalid",
        "approval-state-invalid",
      ]);
      return true;
    },
  );
  assert.equal((await stores.artifacts.list()).length, 1);
  assert.equal((await stores.records.list()).length, 0);
});

Deno.test("pre-Apply prepared artifact validation requires package resolution, read set, and approval match", async () => {
  const stores = storesFixture();
  await stores.artifacts.put({
    id: "artifact_existing",
    digest: "sha256:artifact",
    storageRef: "s3://prepared/artifact_existing",
    expiresAt: "2026-04-28T00:00:00.000Z",
    sourceDigest: "sha256:source",
    buildInputDigest: "sha256:build-input",
    buildEnvironmentDigest: "sha256:build-env",
    resolvedGraphDigest: "sha256:graph",
    packageResolutionDigest: "sha256:packages-a",
    createdAt: "2026-04-27T00:00:00.000Z",
  });
  const service = new SupplyChainService({
    stores,
    clock: () => new Date("2026-04-27T00:05:00.000Z"),
  });

  await assert.rejects(
    () =>
      service.requirePreparedArtifactForApply({
        deploymentId: "deployment_1",
        sourceDigest: "sha256:source",
        buildInputDigest: "sha256:build-input",
        buildEnvironmentDigest: "sha256:build-env",
        resolvedGraphDigest: "sha256:graph",
        packageResolutionDigest: "sha256:packages-b",
        artifactDigest: "sha256:artifact",
        now: "2026-04-27T00:05:00.000Z",
        readSetValid: true,
        approvalStateValid: true,
      }),
    (error) => {
      assert.match(
        String(error),
        /PreparedArtifact pre-Apply validation failed/,
      );
      const details = (error as { details?: unknown }).details as {
        rejectionReasons?: readonly string[];
      } | undefined;
      assert.deepEqual(details?.rejectionReasons, [
        "package-resolution-digest-mismatch",
      ]);
      return true;
    },
  );

  await assert.rejects(
    () =>
      service.requirePreparedArtifactForApply({
        deploymentId: "deployment_1",
        sourceDigest: "sha256:source",
        buildInputDigest: "sha256:build-input",
        buildEnvironmentDigest: "sha256:build-env",
        resolvedGraphDigest: "sha256:graph",
        packageResolutionDigest: "sha256:packages-a",
        artifactDigest: "sha256:artifact",
        now: "2026-04-27T00:05:00.000Z",
        readSetValid: true,
        approvalStateValid: false,
      }),
    (error) => {
      const details = (error as { details?: unknown }).details as {
        rejectionReasons?: readonly string[];
      } | undefined;
      assert.deepEqual(details?.rejectionReasons, [
        "approval-state-invalid",
      ]);
      return true;
    },
  );

  const validated = await service.requirePreparedArtifactForApply({
    deploymentId: "deployment_1",
    sourceDigest: "sha256:source",
    buildInputDigest: "sha256:build-input",
    buildEnvironmentDigest: "sha256:build-env",
    resolvedGraphDigest: "sha256:graph",
    packageResolutionDigest: "sha256:packages-a",
    artifactDigest: "sha256:artifact",
    now: "2026-04-27T00:05:00.000Z",
    readSetValid: true,
    approvalStateValid: true,
  });

  assert.equal(validated.artifact.id, "artifact_existing");
  assert.equal(validated.validation.reusable, true);
});

Deno.test("mirror policy can decide not to mirror or retain", () => {
  const service = newService([]);

  const decision = service.decideArtifactMirror({
    sourceArtifactRef: "registry.example.test/demo:latest",
    sourceArtifactDigest: "sha256:external",
    packageResolutionDigest: "sha256:packages",
    retentionDeadline: "2026-05-01T00:00:00.000Z",
    policy: {
      mirrorExternalImages: false,
      retainForRollbackWindow: false,
    },
  });

  assert.equal(decision.mirroredArtifactRef, undefined);
  assert.equal(decision.retentionDeadline, undefined);
});

function newService(ids: string[]): SupplyChainService {
  return new SupplyChainService({
    stores: storesFixture(),
    idFactory: sequenceIds(ids),
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
}

function storesFixture() {
  return {
    records: new InMemorySupplyChainRecordStore(),
    artifacts: new InMemoryPreparedArtifactStore(),
    protectedReferences: new InMemoryProtectedReferenceStore(),
  };
}

function sequenceIds(ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `generated_${index}`;
}
