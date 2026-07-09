/**
 * Capsule ledger record + OpenTofu Capsule compatibility contract
 * (`capsules` / compatibility reports).
 *
 * A Capsule is the OpenTofu execution unit directly under a Workspace / Project
 * (`@workspace/name`): one Capsule = one generated root + one OpenTofu tfstate +
 * outputs. The App/Environment/InstallProfile lanes model is retired;
 * `environment` is a column on the Capsule (UNIQUE(project_id, name,
 * environment)).
 *
 * The compatibility report is not a Takosumi-specific source manifest; it is the
 * normalized view of a plain Git-hosted OpenTofu configuration that can be called
 * as a child module from a Takosumi generated root. A SourceSnapshot is
 * normalized as an OpenTofu Capsule before plan / apply. InstallConfig (see
 * `./install-configs.ts`) is the service-side DB record describing Capsule
 * execution policy. User repos carry NO Takosumi manifest.
 *
 * (The Capsule ledger record was formerly `Installation`. The transient
 * `Installation` alias is re-exported from `./install-configs.ts` until the rename
 * converges.)
 */

import type { PublicRun, Run } from "./runs.ts";
import type {
  ProviderRequirement,
  ProviderResolution,
  PublicProviderResolution,
} from "./provider-resolution.ts";

export type {
  CapsuleProviderEnvBinding,
  CapsuleProviderEnvBindings,
  CapsuleProviderEnvBindingSet,
} from "./connections.ts";

// ---------------------------------------------------------------------------
// Capsule ledger record
// ---------------------------------------------------------------------------

/**
 * Internal compatibility discriminator. `core` is the Workspace base Capsule
 * emitting shared outputs. `opentofu_root` is retained only so old direct-root
 * ledger rows can be read; new InstallConfigs are rejected at the domain-service
 * boundary.
 */
export type InstallType =
  | "core"
  | "opentofu_module"
  | "opentofu_root"
  | "app_source";

export type CapsuleStatus =
  | "pending"
  | "active"
  | "stale"
  | "error"
  | "disabled"
  | "destroyed";

/**
 * Capsule ledger record.
 * 1 Capsule = generated root + tfstate + outputs; `currentStateGeneration` is
 * the generation guard cursor. The latest `currentOutputId` is an internal
 * ledger pointer to the encrypted raw output envelope and is projected out of
 * public Capsule reads; dashboard output reads go through Output projections or
 * OutputShare instead.
 */
export interface Capsule {
  readonly id: string;
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  /**
   * Owning Project. Capsules live under a Project; a default Project
   * (`prj_default`) is backfilled per Workspace for pre-Project rows.
   */
  readonly projectId?: string;
  readonly name: string;
  readonly slug: string;
  /**
   * Registered git {@link Source} this Capsule tracks. Absent only for legacy
   * source-less Capsules kept for internal/operator compatibility with retired
   * upload/artifact SourceSnapshots. New public Capsules should be backed by a
   * Git Source.
   */
  readonly sourceId?: string;
  readonly installType: InstallType;
  readonly installConfigId: string;
  readonly environment: string;
  readonly currentStateVersionId?: string;
  readonly currentStateGeneration: number;
  readonly currentOutputId?: string;
  /** @deprecated Use currentOutputId. */
  readonly currentOutputSnapshotId?: string;
  /** @deprecated Retired Deployment ledger pointer. */
  readonly currentDeploymentId?: string;
  readonly compatibilityReportId?: string;
  readonly compatibilityStatus?: CapsuleCompatibilityLevel;
  readonly status: CapsuleStatus;
  /**
   * Auto-update opt-in. When the tracked Source resolves a new snapshot and
   * marks this Capsule `stale`, the control plane creates the update plan run
   * itself and auto-applies it only when the plan is CLEAN (succeeded — an
   * approval-parked, destructive, or policy-blocked plan never is). Destructive
   * updates always stop as 更新があります and wait for the user.
   */
  readonly autoUpdate?: boolean;
  /**
   * Auto-update backoff marker: the SourceSnapshot id of the last automatic
   * attempt. One automatic attempt per snapshot — a failed auto-update retries
   * only on the next new snapshot (or a manual update). Internal; projected out
   * of public reads.
   */
  readonly autoUpdateAttemptSourceSnapshotId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public Capsule projection returned by `/api` and dashboard session routes. */
export type PublicCapsule = Omit<
  Capsule,
  "installType" | "currentOutputId" | "autoUpdateAttemptSourceSnapshotId"
>;

// ---------------------------------------------------------------------------
// Capsule compatibility report
// ---------------------------------------------------------------------------

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
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly sourceSnapshotId: string;
  readonly level: CapsuleCompatibilityLevel;
  readonly findings: readonly CapsuleGateFinding[];
  readonly providers: readonly CapsuleProviderRequirement[];
  readonly resources: readonly CapsuleResourceSummary[];
  readonly dataSources: readonly CapsuleDataSourceSummary[];
  readonly provisioners: readonly CapsuleProvisionerSummary[];
  /**
   * Non-secret root module interface discovered during compatibility analysis.
   * Plan creation can reuse this metadata when a preflight report is supplied,
   * avoiding another source archive expansion just to decide which ordinary
   * OpenTofu variables/outputs the generated root may project.
   */
  readonly rootModuleVariables?: readonly string[];
  readonly rootModuleOutputs?: readonly string[];
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
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  /** @deprecated Use workspace-scoped Source/Capsule identity. */
  readonly spaceId?: string;
  /**
   * Curated InstallConfig to gate the pre-install compatibility check against,
   * used when no Capsule exists yet (e.g. the dashboard's "選んで入れる"
   * catalog deep-link). Its bounded policy (`allowedResourceTypes` …) is merged
   * with the Workspace policy as a ceiling and applied to the Capsule Gate, so a
   * vetted first-party module is gated by its own minimal allowlist WITHOUT
   * widening the instance-wide default allowlist. Ignored when `capsuleId` is
   * also present (the Capsule's own InstallConfig wins).
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
