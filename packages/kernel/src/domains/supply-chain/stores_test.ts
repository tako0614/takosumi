import assert from "node:assert/strict";
import {
  assertPreparedArtifactReusable,
  InMemoryPreparedArtifactStore,
  InMemoryProtectedReferenceStore,
  type PreparedArtifact,
} from "./mod.ts";

const artifact: PreparedArtifact = {
  id: "artifact_1",
  digest: "sha256:artifact",
  storageRef: "s3://prepared/artifact_1",
  expiresAt: "2026-04-27T01:00:00.000Z",
  sourceDigest: "sha256:source",
  buildInputDigest: "sha256:build-input",
  buildEnvironmentDigest: "sha256:build-env",
  resolvedGraphDigest: "sha256:graph",
  packageResolutionDigest: "sha256:packages-a",
  createdAt: "2026-04-27T00:00:00.000Z",
};

Deno.test("prepared artifact reuse is rejected when package resolution digest differs", () => {
  assert.throws(
    () =>
      assertPreparedArtifactReusable(artifact, {
        sourceDigest: artifact.sourceDigest,
        buildInputDigest: artifact.buildInputDigest,
        buildEnvironmentDigest: artifact.buildEnvironmentDigest,
        resolvedGraphDigest: artifact.resolvedGraphDigest,
        packageResolutionDigest: "sha256:packages-b",
        artifactDigest: artifact.digest,
        now: "2026-04-27T00:05:00.000Z",
        readSetValid: true,
        approvalStateValid: true,
      }),
    /PreparedArtifact cannot be reused/,
  );
});

Deno.test("protected reference blocks prepared artifact GC", async () => {
  const artifacts = new InMemoryPreparedArtifactStore();
  const references = new InMemoryProtectedReferenceStore();

  await artifacts.put(artifact);
  await references.put({
    id: "protected_1",
    refType: "PreparedArtifact",
    refId: artifact.id,
    reason: "rollback-window",
    expiresAt: "2026-04-27T02:00:00.000Z",
    createdAt: "2026-04-27T00:00:00.000Z",
  });

  assert.equal(
    await artifacts.deleteIfUnprotected(
      artifact.id,
      references,
      "2026-04-27T00:30:00.000Z",
    ),
    false,
  );
  assert.equal((await artifacts.get(artifact.id))?.id, artifact.id);

  assert.equal(
    await artifacts.deleteIfUnprotected(
      artifact.id,
      references,
      "2026-04-27T02:00:00.001Z",
    ),
    true,
  );
});
