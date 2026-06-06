/**
 * Core Specification §6 lane contracts: App / Environment / InstallProfile /
 * DeploymentProfile, plus the unified {@link Run} facade (§6.8).
 *
 * These are ADDITIVE to the existing public deploy-control vocabulary
 * (`Installation` / `PlanRun` / `ApplyRun` / `Deployment` / `DeploymentOutput`).
 * The unified `Run` is a projection over the internal PlanRun / ApplyRun /
 * SourceSyncRun records; the internal classes stay canonical and the facade maps
 * them. See `src/service/domains/deploy-control/projection_run.ts`.
 *
 * Security: none of these types ever carry secret material. InstallProfile holds
 * only public install configuration (policy ids, output allowlist names, module
 * source coordinates); credential values live in Connection secret blobs.
 */

import type { OpenTofuOperation } from "./deploy-control-api.ts";

// ---------------------------------------------------------------------------
// Install type / trust level (shared with §6.6)
// ---------------------------------------------------------------------------

export type InstallType = "app_source" | "opentofu_module" | "opentofu_root";

export const INSTALL_TYPES: readonly InstallType[] = [
  "app_source",
  "opentofu_module",
  "opentofu_root",
] as const;

export type InstallProfileTrustLevel =
  | "official"
  | "trusted"
  | "customer"
  | "raw";

// ---------------------------------------------------------------------------
// App (spec §6.3)
// ---------------------------------------------------------------------------

/**
 * An App binds a {@link Source} to one install type. It is Space-scoped and may
 * carry an InstallProfile (the "how to deploy" config). Environments hang off an
 * App and carry the execution targets.
 */
export interface App {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly sourceId: string;
  readonly installType: InstallType;
  readonly installProfileId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const APPS_PATH = "/v1/apps" as const;
export const APP_PATH = (id: string): string =>
  `/v1/apps/${encodeURIComponent(id)}`;

export interface CreateAppRequest {
  readonly spaceId: string;
  readonly name: string;
  readonly sourceId: string;
  readonly installType: InstallType;
  readonly installProfileId?: string;
}

export interface PatchAppRequest {
  readonly name?: string;
  readonly installProfileId?: string | null;
}

export interface AppResponse {
  readonly app: App;
}

export interface ListAppsResponse {
  readonly apps: readonly App[];
}

// ---------------------------------------------------------------------------
// Environment (spec §6.4)
// ---------------------------------------------------------------------------

/**
 * One execution target of an App: a `production` / `preview` / `staging` lane
 * with its own ref, path, automation flags, and current Deployment pointer.
 * `requireApproval` generalizes the deploy-control approval gate: when true, a
 * plan run must be explicitly approved before its apply may run.
 */
export interface Environment {
  readonly id: string;
  readonly appId: string;
  readonly name: string;
  readonly ref: string;
  readonly path: string;
  readonly autoSync: boolean;
  readonly autoPlan: boolean;
  readonly autoApply: boolean;
  readonly requireApproval: boolean;
  readonly currentDeploymentId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Spec §6.4 automation defaults keyed by the well-known environment name.
 * `production` is approval-gated and never auto-applies; `preview` auto-applies
 * with no approval. Any other name falls back to the conservative production
 * defaults.
 */
export interface EnvironmentAutomationDefaults {
  readonly autoSync: boolean;
  readonly autoPlan: boolean;
  readonly autoApply: boolean;
  readonly requireApproval: boolean;
}

export const PRODUCTION_ENVIRONMENT_DEFAULTS: EnvironmentAutomationDefaults = {
  autoSync: true,
  autoPlan: true,
  autoApply: false,
  requireApproval: true,
} as const;

export const PREVIEW_ENVIRONMENT_DEFAULTS: EnvironmentAutomationDefaults = {
  autoSync: true,
  autoPlan: true,
  autoApply: true,
  requireApproval: false,
} as const;

/** Resolves the §6.4 automation defaults for a named environment. */
export function environmentDefaultsForName(
  name: string,
): EnvironmentAutomationDefaults {
  return name.trim().toLowerCase() === "preview"
    ? PREVIEW_ENVIRONMENT_DEFAULTS
    : PRODUCTION_ENVIRONMENT_DEFAULTS;
}

export const APP_ENVIRONMENTS_PATH = (appId: string): string =>
  `/v1/apps/${encodeURIComponent(appId)}/environments`;
export const ENVIRONMENT_PATH = (id: string): string =>
  `/v1/environments/${encodeURIComponent(id)}`;

export interface CreateEnvironmentRequest {
  readonly name: string;
  /** Defaults to the Source's defaultRef when omitted. */
  readonly ref?: string;
  /** Defaults to the Source's defaultPath when omitted. */
  readonly path?: string;
  readonly autoSync?: boolean;
  readonly autoPlan?: boolean;
  readonly autoApply?: boolean;
  readonly requireApproval?: boolean;
}

export interface PatchEnvironmentRequest {
  readonly ref?: string;
  readonly path?: string;
  readonly autoSync?: boolean;
  readonly autoPlan?: boolean;
  readonly autoApply?: boolean;
  readonly requireApproval?: boolean;
}

export interface EnvironmentResponse {
  readonly environment: Environment;
}

export interface ListEnvironmentsResponse {
  readonly environments: readonly Environment[];
}

// ---------------------------------------------------------------------------
// InstallProfile (spec §6.6)
// ---------------------------------------------------------------------------

export interface InstallProfileModuleSource {
  readonly type: "git" | "r2_archive";
  readonly url?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly objectKey?: string;
  readonly digest?: string;
}

export interface InstallProfileBuild {
  readonly enabled: boolean;
  readonly workingDirectory?: string;
  readonly commands: readonly string[];
  readonly artifactPath?: string;
}

export interface InstallProfileOutputProjection {
  readonly from: string;
  readonly type: "string" | "url" | "hostname" | "number" | "boolean" | "json";
  readonly required?: boolean;
}

/**
 * Service-side install configuration (NOT an in-repo manifest). Seeded from the
 * official template catalog at bootstrap with `trustLevel: "official"`; the
 * template registry stays the seed source of truth.
 */
export interface InstallProfile {
  readonly id: string;
  readonly name: string;
  readonly installType: InstallType;
  readonly trustLevel: InstallProfileTrustLevel;
  readonly moduleSource?: InstallProfileModuleSource;
  readonly build?: InstallProfileBuild;
  readonly variableMapping: Readonly<Record<string, unknown>>;
  readonly outputAllowlist: Readonly<Record<string, InstallProfileOutputProjection>>;
  readonly policyId: string;
  /**
   * Source binding back to the official template catalog when this profile was
   * seeded from a template. Absent for operator-authored profiles.
   */
  readonly templateBinding?: {
    readonly templateId: string;
    readonly templateVersion: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const INSTALL_PROFILES_PATH = "/v1/install-profiles" as const;
export const INSTALL_PROFILE_PATH = (id: string): string =>
  `/v1/install-profiles/${encodeURIComponent(id)}`;

export interface ListInstallProfilesResponse {
  readonly installProfiles: readonly InstallProfile[];
}

export interface InstallProfileResponse {
  readonly installProfile: InstallProfile;
}

// ---------------------------------------------------------------------------
// DeploymentProfile (spec §6.7)
// ---------------------------------------------------------------------------

export type ConnectionBindingMode =
  | "service"
  | "customer"
  | "manual"
  | "disabled";

export type DeploymentProfileProvider =
  | "cloudflare"
  | "aws"
  | "gcp"
  | "azure"
  | "kubernetes"
  | "docker";

export interface ConnectionBinding {
  readonly mode: ConnectionBindingMode;
  readonly connectionId?: string;
  readonly provider?: DeploymentProfileProvider;
  readonly region?: string;
  readonly scope?: Readonly<Record<string, unknown>>;
}

export type ConnectionBindingSlot =
  | "source"
  | "compute"
  | "dns"
  | "storage"
  | "database"
  | "secrets";

export const CONNECTION_BINDING_SLOTS: readonly ConnectionBindingSlot[] = [
  "source",
  "compute",
  "dns",
  "storage",
  "database",
  "secrets",
] as const;

/** Per-Environment Connection binding (§6.7). One row per Environment. */
export interface DeploymentProfile {
  readonly id: string;
  readonly environmentId: string;
  readonly bindings: {
    readonly [slot in ConnectionBindingSlot]?: ConnectionBinding;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const DEPLOYMENT_PROFILE_PATH = (environmentId: string): string =>
  `/v1/environments/${encodeURIComponent(environmentId)}/deployment-profile`;

export interface PutDeploymentProfileRequest {
  readonly bindings: {
    readonly [slot in ConnectionBindingSlot]?: ConnectionBinding;
  };
}

export interface DeploymentProfileResponse {
  readonly deploymentProfile: DeploymentProfile;
}

// ---------------------------------------------------------------------------
// Unified Run facade (spec §6.8)
// ---------------------------------------------------------------------------

export type RunType =
  | "source_sync"
  | "plan"
  | "apply"
  | "destroy_plan"
  | "destroy_apply"
  | "drift_check";

export type UnifiedRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * The spec §6.8 unified Run. A projection over the internal SourceSyncRun /
 * PlanRun / ApplyRun records. `waiting_approval` generalizes the deploy-control
 * `requiresConfirmation` / `requireApproval` gate; a destroy is modeled as
 * `destroy_plan` (always lands in `waiting_approval`) followed by
 * `destroy_apply`.
 */
export interface Run {
  readonly id: string;
  readonly spaceId: string;
  readonly appId?: string;
  readonly environmentId?: string;
  readonly type: RunType;
  readonly status: UnifiedRunStatus;
  readonly sourceSnapshotId?: string;
  readonly baseStateGeneration?: number;
  readonly planDigest?: string;
  readonly planArtifactKey?: string;
  readonly policyStatus?: "pass" | "warn" | "deny";
  readonly errorCode?: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface RunResponse {
  readonly run: Run;
}

export const RUN_PATH = (id: string): string =>
  `/v1/runs/${encodeURIComponent(id)}`;
export const RUN_APPROVE_PATH = (id: string): string =>
  `/v1/runs/${encodeURIComponent(id)}/approve`;
export const RUN_CANCEL_PATH = (id: string): string =>
  `/v1/runs/${encodeURIComponent(id)}/cancel`;
export const ENVIRONMENT_PLAN_PATH = (environmentId: string): string =>
  `/v1/environments/${encodeURIComponent(environmentId)}/plan`;
export const ENVIRONMENT_DESTROY_PLAN_PATH = (environmentId: string): string =>
  `/v1/environments/${encodeURIComponent(environmentId)}/destroy-plan`;
export const ENVIRONMENT_DEPLOYMENTS_PATH = (environmentId: string): string =>
  `/v1/environments/${encodeURIComponent(environmentId)}/deployments`;

/**
 * The internal operation a unified run maps to. `plan` with `-destroy` is a
 * `destroy_plan`; the apply that runs the destroy plan is `destroy_apply`.
 */
export function runTypeForOperation(
  operation: OpenTofuOperation,
  phase: "plan" | "apply",
): RunType {
  if (operation === "destroy") {
    return phase === "plan" ? "destroy_plan" : "destroy_apply";
  }
  return phase;
}
