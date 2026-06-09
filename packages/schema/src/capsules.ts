/**
 * OpenTofu Capsule compatibility contract.
 *
 * A Capsule is not a Takosumi-specific source manifest. It is the normalized
 * view of a plain Git-hosted OpenTofu configuration that can be called as a
 * child module from a Takosumi generated root.
 */

import type { Run } from "./runs.ts";

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
  readonly credentialSources?: readonly ("takosumi_managed" | "user_env_set")[];
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
  readonly installationId?: string;
}

export interface CapsuleCompatibilityReportResponse {
  readonly report: CapsuleCompatibilityReport;
  readonly run?: Run;
}
