import { conflict } from "../../shared/errors.ts";
import type {
  PreparedArtifact,
  PreparedArtifactReuseExpectation,
  PreparedArtifactReuseRejectionReason,
  PreparedArtifactReuseValidation,
} from "./types.ts";

export function validatePreparedArtifactReuse(
  artifact: PreparedArtifact,
  expectation: PreparedArtifactReuseExpectation,
): PreparedArtifactReuseValidation {
  const rejectionReasons: PreparedArtifactReuseRejectionReason[] = [];

  if (!expectation.readSetValid) rejectionReasons.push("read-set-invalid");
  if (artifact.sourceDigest !== expectation.sourceDigest) {
    rejectionReasons.push("source-digest-mismatch");
  }
  if (artifact.buildInputDigest !== expectation.buildInputDigest) {
    rejectionReasons.push("build-input-digest-mismatch");
  }
  if (artifact.buildEnvironmentDigest !== expectation.buildEnvironmentDigest) {
    rejectionReasons.push("build-environment-digest-mismatch");
  }
  if (artifact.resolvedGraphDigest !== expectation.resolvedGraphDigest) {
    rejectionReasons.push("resolved-graph-digest-mismatch");
  }
  if (
    artifact.packageResolutionDigest !== expectation.packageResolutionDigest
  ) {
    rejectionReasons.push("package-resolution-digest-mismatch");
  }
  if (artifact.digest !== expectation.artifactDigest) {
    rejectionReasons.push("artifact-digest-mismatch");
  }
  if (artifact.expiresAt <= expectation.now) {
    rejectionReasons.push("artifact-expired");
  }
  if (!expectation.approvalStateValid) {
    rejectionReasons.push("approval-state-invalid");
  }

  return {
    reusable: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

export function assertPreparedArtifactReusable(
  artifact: PreparedArtifact,
  expectation: PreparedArtifactReuseExpectation,
): void {
  const validation = validatePreparedArtifactReuse(artifact, expectation);
  if (validation.reusable) return;
  throw conflict("PreparedArtifact cannot be reused", {
    artifactId: artifact.id,
    rejectionReasons: validation.rejectionReasons,
  });
}
