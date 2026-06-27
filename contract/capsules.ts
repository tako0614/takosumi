/**
 * OpenTofu Capsule compatibility contract.
 *
 * A Capsule is not a Takosumi-specific source manifest. It is the normalized
 * view of a plain Git-hosted OpenTofu configuration that can be called as a
 * child module from a Takosumi generated root.
 */

import type { PublicRun, Run } from "./runs.ts";
import type {
  ProviderRequirement,
  ProviderResolution,
  PublicProviderResolution,
} from "./provider-resolution.ts";

export type CapsuleCompatibilityLevel =
  | "ready"
  | "auto_capsulized"
  | "needs_patch"
  | "unsupported";

export type CapsuleCompatibility = CapsuleCompatibilityLevel;

export type CapsuleFindingSeverity = "info" | "warning" | "error";

export interface CapsuleGateFinding {
  readonly severity: CapsuleFindingSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly suggestion?: string;
}

export interface CapsuleProviderRequirement {
  readonly source: string;
  readonly versionConstraint?: string;
  readonly aliases: readonly string[];
  readonly allowed: boolean;
}

export interface CapsuleResourceSummary {
  readonly type: string;
  readonly count?: number;
  readonly allowed: boolean;
}

export interface CapsuleDataSourceSummary {
  readonly type: string;
  readonly allowed: boolean;
}

export interface CapsuleProvisionerSummary {
  readonly type: string;
  readonly allowed: boolean;
}

export interface CapsuleCompatibilityReport {
  readonly id: string;
  readonly sourceId?: string;
  readonly installationId?: string;
  readonly sourceSnapshotId: string;
  readonly level: CapsuleCompatibilityLevel;
  readonly findings: readonly CapsuleGateFinding[];
  readonly providers: readonly CapsuleProviderRequirement[];
  readonly resources: readonly CapsuleResourceSummary[];
  readonly dataSources: readonly CapsuleDataSourceSummary[];
  readonly provisioners: readonly CapsuleProvisionerSummary[];
  readonly providerRequirements?: readonly ProviderRequirement[];
  readonly providerResolutions?: readonly ProviderResolution[];
  readonly normalizedObjectKey?: string;
  readonly normalizedDigest?: string;
  readonly createdAt: string;
}

export interface CapsuleGateResult {
  readonly level: CapsuleCompatibilityLevel;
  readonly findings: readonly CapsuleGateFinding[];
  readonly providers: readonly CapsuleProviderRequirement[];
  readonly resources: readonly CapsuleResourceSummary[];
  readonly dataSources: readonly CapsuleDataSourceSummary[];
  readonly provisioners: readonly CapsuleProvisionerSummary[];
}

export interface CreateSourceCompatibilityCheckRequest {
  readonly sourceSnapshotId?: string;
  /** Safe relative OpenTofu module path inside the SourceSnapshot archive. */
  readonly modulePath?: string;
  readonly installationId?: string;
  /**
   * Curated InstallConfig to gate the pre-install compatibility check against,
   * used when no Installation exists yet (e.g. the dashboard's "選んで入れる"
   * catalog deep-link). Its bounded policy (`allowedResourceTypes` …) is merged
   * with the Space policy as a ceiling and applied to the Capsule Gate, so a
   * vetted first-party module is gated by its own minimal allowlist WITHOUT
   * widening the instance-wide default allowlist. Ignored when `installationId`
   * is also present (the Installation's own InstallConfig wins).
   */
  readonly installConfigId?: string;
}

export interface CapsuleCompatibilityReportResponse {
  readonly report: CapsuleCompatibilityReport;
  readonly run?: Run;
}

export type PublicCapsuleCompatibilityReport = Omit<
  CapsuleCompatibilityReport,
  "providerResolutions"
> & {
  readonly providerResolutions?: readonly PublicProviderResolution[];
};

export interface PublicCapsuleCompatibilityReportResponse {
  readonly report: PublicCapsuleCompatibilityReport;
  readonly run?: PublicRun;
}
