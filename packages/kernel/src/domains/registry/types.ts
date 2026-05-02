import type { Digest, JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type PackageKind =
  | "provider-package"
  | "resource-contract-package"
  | "data-contract-package"
  | "publication-contract-package"
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
