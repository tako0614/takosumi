/**
 * Capsule ledger record + OpenTofu Capsule compatibility contract
 * (`capsules` / compatibility reports).
 *
 * A Capsule is the OpenTofu execution unit directly under a Workspace / Project
 * (`@workspace/name`): one Capsule = one OpenTofu root execution + one tfstate +
 * outputs. The App/Environment/InstallProfile lanes model is retired;
 * `environment` is a column on the Capsule (UNIQUE(project_id, name,
 * environment)).
 *
 * The compatibility report is not a Takosumi-specific source manifest; it is a
 * read-only analysis of a plain Git-hosted OpenTofu configuration. The original
 * SourceSnapshot remains the execution source and is never rewritten by this
 * check. InstallConfig (see
 * `./install-configs.ts`) is the service-side DB record describing Capsule
 * execution policy. User repos carry NO Takosumi manifest.
 */

import type { PublicRun, Run } from "./runs.ts";
import type {
  ProviderRequirement,
  ProviderResolution,
  PublicProviderResolution,
} from "./provider-resolution.ts";

export type {
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
} from "./connections.ts";

// ---------------------------------------------------------------------------
// Capsule ledger record
// ---------------------------------------------------------------------------

/**
 * `error` can retain the latest provider-applied StateVersion/Output while a
 * required post-apply lifecycle action has failed or stayed non-terminal. It
 * is never runtime Ready; a later successful reviewed plan/apply is the generic
 * recovery path back to `active`.
 */
export type CapsuleStatus =
  "pending" | "active" | "stale" | "error" | "disabled" | "destroyed";

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
  /**
   * Owning Project. Capsules live under a Project; a default Project
   * (`prj_default_<workspaceId>`) is backfilled per Workspace for pre-Project
   * rows.
   */
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  /**
   * Registered Git {@link Source} this Capsule tracks. Capsule authoring is
   * Git-only; immutable archives are runner transport, not another Source kind.
   */
  readonly sourceId: string;
  readonly installConfigId: string;
  readonly environment: string;
  readonly currentStateVersionId?: string;
  readonly currentStateGeneration: number;
  readonly currentOutputId?: string;
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
  "currentOutputId" | "autoUpdateAttemptSourceSnapshotId"
>;

// ---------------------------------------------------------------------------
// Capsule compatibility report
// ---------------------------------------------------------------------------

export type CapsuleCompatibilityLevel = "ready" | "needs_patch" | "unsupported";

export type CapsuleCompatibility = CapsuleCompatibilityLevel;

export type CapsuleFindingSeverity = "info" | "warning" | "error";

export type CapsuleFindingCompatibilityImpact =
  "none" | "needs_patch" | "unsupported";

export interface CapsuleGateFinding {
  readonly severity: CapsuleFindingSeverity;
  /** Structured aggregate effect; consumers must not infer it from `code`. */
  readonly compatibilityImpact: CapsuleFindingCompatibilityImpact;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly suggestion?: string;
  /** Structured presentation context; consumers must not parse `message`. */
  readonly context?: Readonly<Record<string, string>>;
}

export interface CapsuleProviderRequirement {
  readonly source: string;
  readonly versionConstraint?: string;
  readonly aliases: readonly string[];
  readonly allowed: boolean;
  /**
   * Explicit service-side decision that this provider needs a
   * ProviderConnection for this run context. HCL source names alone never imply
   * credentials; absent/false means the compatibility analyzer made no such
   * requirement.
   */
  readonly credentialRequired?: boolean;
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

/**
 * OpenTofu metadata for one root-module Output discovered by compatibility
 * analysis. The generated-root path must preserve `sensitive`; an `ephemeral`
 * Output cannot be re-exported from a root module and therefore makes the
 * Capsule incompatible with Takosumi's persisted Output ledger.
 */
export interface CapsuleRootModuleOutputDeclaration {
  readonly name: string;
  /** `null` means static analysis could not prove the constant boolean. */
  readonly sensitive: boolean | null;
  /** `null` means static analysis could not prove the constant boolean. */
  readonly ephemeral: boolean | null;
}

export interface CapsuleCompatibilityReport {
  readonly id: string;
  readonly sourceId: string;
  readonly capsuleId?: string;
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
  readonly rootModuleOutputs?: readonly CapsuleRootModuleOutputDeclaration[];
  readonly providerRequirements?: readonly ProviderRequirement[];
  readonly providerResolutions?: readonly ProviderResolution[];
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
  /**
   * Curated InstallConfig to gate the pre-install compatibility check against,
   * used when no Capsule exists yet (e.g. the dashboard's "選んで入れる"
   * Store deep-link). Its bounded policy (`allowedResourceTypes` …) is merged
   * with Workspace policy as a ceiling and applied to the Capsule Gate without
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
