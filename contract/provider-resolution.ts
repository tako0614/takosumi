import type { ProviderCredentialOwnership } from "./connections.ts";
import {
  PROVIDER_ENV_MATERIALIZATIONS,
  type ProviderEnvMaterialization,
} from "./provider-envs.ts";
import type { IsoTimestamp } from "./types.ts";

export const PROVIDER_DELIVERY_MODES = PROVIDER_ENV_MATERIALIZATIONS;

export type ProviderDeliveryMode = ProviderEnvMaterialization;

export function isProviderDeliveryMode(
  value: unknown,
): value is ProviderDeliveryMode {
  return (
    typeof value === "string" &&
    PROVIDER_DELIVERY_MODES.includes(value as ProviderDeliveryMode)
  );
}

export const PROVIDER_RESOLUTION_STATUSES = [
  "resolved_provider_env",
  "blocked_missing_env",
  "blocked_policy",
] as const;

export type ProviderResolutionStatus =
  (typeof PROVIDER_RESOLUTION_STATUSES)[number];

export function isProviderResolutionStatus(
  value: unknown,
): value is ProviderResolutionStatus {
  return (
    typeof value === "string" &&
    PROVIDER_RESOLUTION_STATUSES.includes(value as ProviderResolutionStatus)
  );
}

export type ProviderRequirementDiscoverySource =
  | "required_providers"
  | "provider_block"
  | "generated_root";

export type ProviderRequirementPhase =
  | "init"
  | "plan"
  | "apply"
  | "destroy"
  | "drift_check";

export interface ProviderRequirement {
  readonly providerSource: string;
  readonly providerName: string;
  readonly alias?: string;
  readonly versionConstraint?: string;
  readonly modulePath: string;
  readonly discoveredFrom: ProviderRequirementDiscoverySource;
  readonly requiredForPhases: readonly ProviderRequirementPhase[];
}

export interface BaseProviderResolutionEvidence {
  readonly kind: "provider_env" | "blocked";
  readonly provider: string;
  readonly envId?: string;
  readonly materialization?: ProviderEnvMaterialization;
}

export interface ProviderEnvResolutionEvidence extends BaseProviderResolutionEvidence {
  readonly kind: "provider_env";
  readonly envId: string;
  readonly materialization: "oauth" | "secret";
  readonly requiredEnvNames: readonly string[];
}

export interface BlockedProviderResolutionEvidence extends BaseProviderResolutionEvidence {
  readonly kind: "blocked";
  readonly reason: string;
}

export type ProviderResolutionEvidence =
  | ProviderEnvResolutionEvidence
  | BlockedProviderResolutionEvidence;

export interface ProviderResolution {
  readonly requirement: ProviderRequirement;
  readonly status: ProviderResolutionStatus;
  readonly envId?: string;
  readonly materialization?: ProviderEnvMaterialization;
  readonly blockedReason?: string;
  readonly evidence: ProviderResolutionEvidence;
}

export const PUBLIC_PROVIDER_RESOLUTION_STATUSES = [
  "resolved_provider_connection",
  "blocked_missing_connection",
  "blocked_policy",
] as const;

export type PublicProviderResolutionStatus =
  (typeof PUBLIC_PROVIDER_RESOLUTION_STATUSES)[number];

export interface BasePublicProviderResolutionEvidence {
  readonly kind: "provider_connection" | "blocked";
  readonly provider: string;
  readonly connectionId?: string;
  readonly ownership?: ProviderCredentialOwnership;
}

export interface PublicProviderConnectionResolutionEvidence extends BasePublicProviderResolutionEvidence {
  readonly kind: "provider_connection";
  readonly connectionId: string;
  readonly ownership: ProviderCredentialOwnership;
  readonly requiredEnvNames: readonly string[];
}

export interface PublicBlockedProviderResolutionEvidence extends BasePublicProviderResolutionEvidence {
  readonly kind: "blocked";
  readonly reason: string;
}

export type PublicProviderResolutionEvidence =
  | PublicProviderConnectionResolutionEvidence
  | PublicBlockedProviderResolutionEvidence;

export interface PublicProviderResolution {
  readonly requirement: ProviderRequirement;
  readonly status: PublicProviderResolutionStatus;
  readonly connectionId?: string;
  readonly ownership?: ProviderCredentialOwnership;
  readonly blockedReason?: string;
  readonly evidence: PublicProviderResolutionEvidence;
}

export type RunEnvironmentPhase =
  | "init"
  | "plan"
  | "apply"
  | "destroy_plan"
  | "destroy_apply"
  | "drift_check";

export type RunEnvironmentFilePurpose =
  | "credential"
  | "provider_override"
  | "cli_config"
  | "backend_config"
  | "input";

export interface RunEnvironmentFile {
  readonly path: string;
  readonly purpose: RunEnvironmentFilePurpose;
  readonly secret: boolean;
}

export interface RunEnvironment {
  readonly runId: string;
  readonly phase: RunEnvironmentPhase;
  readonly generatedRootRef: string;
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly RunEnvironmentFile[];
  readonly providerResolutions: readonly ProviderResolution[];
  readonly allowedEgressProfileId: string;
  readonly redactionProfileId: string;
  readonly stateBackendRef: string;
  readonly dependencySnapshotId?: string;
  readonly savedPlanDigest?: string;
}

export interface RuntimeGrantProjection {
  readonly grantId: string;
  readonly serviceExportId: string;
  readonly serviceBindingId: string;
  readonly installationId: string;
  readonly capability: string;
  readonly expiresAt?: IsoTimestamp;
  readonly rotationPolicyId?: string;
}
