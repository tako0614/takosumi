import type { Digest, JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type PackageKind =
  | "provider-package"
  | "resource-contract-package"
  | "data-contract-package"
  | "output-contract-package"
  | "native-schema"
  | "capability-profile";
export type TrustLevel = "official" | "verified" | "local" | "untrusted";
export type TrustStatus = "active" | "revoked" | "superseded";
export type ConformanceTier = "unknown" | "declared" | "tested" | "certified";

export interface PackageResolution {
  readonly ref: string;
  readonly kind: PackageKind;
  readonly digest: Digest;
  readonly registry: string;
  readonly trustRecordId?: string;
  readonly resolvedAt: IsoTimestamp;
}

export interface PackageDescriptor {
  readonly ref: string;
  readonly kind: PackageKind;
  readonly digest: Digest;
  readonly publisher: string;
  readonly version?: string;
  readonly body: JsonObject;
  readonly publishedAt: IsoTimestamp;
}

export interface TrustRecord {
  readonly id: string;
  readonly packageRef: string;
  readonly packageDigest: Digest;
  readonly packageKind: PackageKind;
  readonly trustLevel: TrustLevel;
  readonly status: TrustStatus;
  readonly conformanceTier: ConformanceTier;
  readonly verifiedBy: string;
  readonly verifiedAt: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
  readonly reason?: string;
}

export interface ProviderSupportReport {
  readonly providerPackageRef: string;
  readonly providerPackageDigest: Digest;
  readonly resourceContracts: readonly string[];
  readonly interfaceContracts?: readonly string[];
  readonly routeProtocols?: readonly string[];
  readonly capabilityProfiles: readonly string[];
  readonly conformanceTier: ConformanceTier;
  readonly limitations?: readonly string[];
}

export const CATALOG_RELEASE_SIGNATURE_ALGORITHM = "Ed25519" as const;

export type CatalogReleasePublisherKeyStatus = "active" | "revoked";

export interface CatalogReleaseSignature {
  readonly algorithm: typeof CATALOG_RELEASE_SIGNATURE_ALGORITHM;
  readonly keyId: string;
  /**
   * Base64 encoded Ed25519 signature over the canonical descriptor payload
   * excluding this `signature` field.
   */
  readonly value: string;
}

export interface CatalogReleaseEntry {
  readonly kind:
    | "shape"
    | "provider"
    | "template"
    | "descriptor"
    | "package"
    | string;
  readonly ref: string;
  readonly digest: Digest;
  readonly status?: "active" | "deprecated" | "withdrawn" | string;
  readonly metadata?: JsonObject;
}

export interface CatalogReleaseDescriptor {
  readonly releaseId: string;
  readonly publisherId: string;
  readonly descriptorRegistryDigest: Digest;
  readonly namespaceRegistryDigest?: Digest;
  readonly spaceRegistryDigest?: Digest;
  readonly implementationRegistryDigest?: Digest;
  readonly profileRegistryDigest?: Digest;
  readonly trustPolicyDigest?: Digest;
  readonly deploymentPolicyDigest?: Digest;
  readonly artifactPolicyDigest?: Digest;
  readonly spacePolicyDigest?: Digest;
  readonly protocolEquivalencePolicyDigest?: Digest;
  readonly entries?: readonly CatalogReleaseEntry[];
  readonly createdAt: IsoTimestamp;
  readonly activatedAt?: IsoTimestamp;
  readonly signature: CatalogReleaseSignature;
}

export interface CatalogReleasePublisherKey {
  readonly keyId: string;
  readonly publisherId: string;
  /** Base64 encoded raw Ed25519 public key. */
  readonly publicKeyBase64: string;
  readonly status: CatalogReleasePublisherKeyStatus;
  readonly enrolledAt: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
  readonly reason?: string;
}

export interface CatalogReleaseAdoptionVerification {
  readonly verifiedAt: IsoTimestamp;
  readonly algorithm: typeof CATALOG_RELEASE_SIGNATURE_ALGORITHM;
  readonly descriptorDigest: Digest;
  readonly publisherKeyId: string;
}

export interface CatalogReleaseAdoption {
  readonly id: string;
  readonly spaceId: string;
  readonly catalogReleaseId: string;
  readonly publisherId: string;
  readonly publisherKeyId: string;
  readonly descriptorDigest: Digest;
  readonly adoptedAt: IsoTimestamp;
  readonly rotatedFromCatalogReleaseId?: string;
  readonly verification: CatalogReleaseAdoptionVerification;
}

export type CatalogReleaseVerificationFailureReason =
  | "unsupported-signature-algorithm"
  | "publisher-key-not-enrolled"
  | "publisher-key-revoked"
  | "publisher-key-mismatch"
  | "descriptor-digest-mismatch"
  | "signature-invalid";

export interface CatalogReleaseVerificationFailure {
  readonly ok: false;
  readonly reason: CatalogReleaseVerificationFailureReason;
  readonly message: string;
  readonly descriptorDigest?: Digest;
  readonly publisherKeyId?: string;
  readonly risk: {
    readonly code: "implementation-unverified";
    readonly severity: "error";
    readonly message: string;
  };
}

export interface CatalogReleaseVerificationSuccess {
  readonly ok: true;
  readonly descriptorDigest: Digest;
  readonly publisherId: string;
  readonly publisherKeyId: string;
  readonly verifiedAt: IsoTimestamp;
}

export type CatalogReleaseVerificationResult =
  | CatalogReleaseVerificationSuccess
  | CatalogReleaseVerificationFailure;
