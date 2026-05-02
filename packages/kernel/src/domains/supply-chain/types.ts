import type { IsoTimestamp } from "../../shared/time.ts";

export type SupplyChainRecordId = string;
export type PreparedArtifactId = string;
export type ProtectedReferenceId = string;
export type Digest = string;

export interface SupplyChainRecord {
  readonly id: SupplyChainRecordId;
  readonly sourceDigest?: Digest;
  readonly buildInputDigest?: Digest;
  readonly buildEnvironmentDigest?: Digest;
  readonly artifactDigest?: Digest;
  readonly packageResolutionDigest: Digest;
  readonly providerPackageDigests: readonly Digest[];
  readonly resourceContractPackageDigests: readonly Digest[];
  readonly dataContractPackageDigests?: readonly Digest[];
  readonly nativeSchemaDigests: readonly Digest[];
  readonly provenanceRef?: string;
  readonly signatureRefs?: readonly string[];
  readonly createdAt: IsoTimestamp;
}

export interface PreparedArtifact {
  readonly id: PreparedArtifactId;
  readonly digest: Digest;
  readonly storageRef: string;
  readonly expiresAt: IsoTimestamp;
  readonly sourceDigest: Digest;
  readonly buildInputDigest: Digest;
  readonly buildEnvironmentDigest: Digest;
  readonly resolvedGraphDigest: Digest;
  readonly packageResolutionDigest: Digest;
  readonly provenanceRef?: string;
  readonly signatureRef?: string;
  readonly createdAt: IsoTimestamp;
}

export type ProtectedReferenceReason =
  | "current-activation"
  | "rollback-window"
  | "prepared-plan"
  | "migration-resume"
  | "audit-retention"
  | "materialization-record"
  | "package-resolution"
  | "supply-chain-record";

export interface ProtectedReference {
  readonly id: ProtectedReferenceId;
  readonly refType: string;
  readonly refId: string;
  readonly reason: ProtectedReferenceReason;
  readonly expiresAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}

export interface ArtifactMirrorPolicy {
  readonly mirrorExternalImages: boolean;
  readonly retainForRollbackWindow: boolean;
}

export interface MirroredArtifactRef {
  readonly sourceArtifactRef: string;
  readonly sourceArtifactDigest: Digest;
  readonly mirroredArtifactRef?: string;
  readonly retentionDeadline?: IsoTimestamp;
  readonly provenanceRef?: string;
  readonly packageResolutionDigest: Digest;
}

export interface PreparedArtifactReuseExpectation {
  readonly sourceDigest: Digest;
  readonly buildInputDigest: Digest;
  readonly buildEnvironmentDigest: Digest;
  readonly resolvedGraphDigest: Digest;
  readonly packageResolutionDigest: Digest;
  readonly artifactDigest: Digest;
  readonly now: IsoTimestamp;
  readonly readSetValid: boolean;
  readonly approvalStateValid: boolean;
}

export type PreparedArtifactReuseRejectionReason =
  | "read-set-invalid"
  | "source-digest-mismatch"
  | "build-input-digest-mismatch"
  | "build-environment-digest-mismatch"
  | "resolved-graph-digest-mismatch"
  | "package-resolution-digest-mismatch"
  | "artifact-digest-mismatch"
  | "artifact-expired"
  | "approval-state-invalid";

export interface PreparedArtifactReuseValidation {
  readonly reusable: boolean;
  readonly rejectionReasons: readonly PreparedArtifactReuseRejectionReason[];
}
