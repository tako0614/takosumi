/**
 * Public Takosumi deploy-control contract facade.
 *
 * Takosumi's final customer-facing vocabulary is Workspace / Project /
 * Capsule / Source / ProviderConnection / CredentialRecipe / ProviderBinding /
 * Secret / Run / Plan / Apply / Destroy / StateVersion / Output / Runner /
 * AuditEvent / Operator.
 *
 * This facade exports those canonical names plus transient deprecated aliases
 * (Space / Installation / Deployment / OutputSnapshot / StateSnapshot) used by
 * the current dashboard and operator tooling while the wire surface migrates; do
 * not introduce the deprecated names as new public product nouns.
 *
 * Internal in-process compatibility DTOs for the account-plane workload seam live in
 * `internal-deploy-control-api.ts` and are intentionally not re-exported here.
 */

export * from "./activity.ts";
export * from "./backups.ts";
export * from "./billing.ts";
export type {
  CapsuleProviderConnectionBinding,
  CapsuleProviderConnectionBindings,
  CapsuleProviderConnectionSet,
  // @deprecated pre-rename binding alias names.
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
  InstallationProviderConnectionSet,
  ListProviderConnectionsResponse,
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
  ProviderConnection,
  ProviderConnectionStatus,
} from "./connections.ts";
export type {
  ProviderRequirement,
  ProviderRequirementDiscoverySource,
  ProviderRequirementPhase,
  PublicBlockedProviderResolutionEvidence as BlockedProviderResolutionEvidence,
  PublicProviderConnectionResolutionEvidence as ProviderConnectionResolutionEvidence,
  PublicProviderResolution as ProviderResolution,
  PublicProviderResolutionEvidence as ProviderResolutionEvidence,
  PublicProviderResolutionStatus as ProviderResolutionStatus,
} from "./provider-resolution.ts";
export { PUBLIC_PROVIDER_RESOLUTION_STATUSES as PROVIDER_RESOLUTION_STATUSES } from "./provider-resolution.ts";
export type {
  Capsule,
  CapsuleStatus,
  CapsuleCompatibility,
  CapsuleCompatibilityLevel,
  CapsuleDataSourceSummary,
  CapsuleFindingSeverity,
  CapsuleGateFinding,
  CapsuleGateResult,
  CapsuleProviderRequirement,
  CapsuleProvisionerSummary,
  PublicCapsule,
  PublicCapsuleCompatibilityReport as CapsuleCompatibilityReport,
  PublicCapsuleCompatibilityReportResponse as CapsuleCompatibilityReportResponse,
  CapsuleResourceSummary,
  CreateSourceCompatibilityCheckRequest,
} from "./capsules.ts";
export type { Project, PublicProject } from "./projects.ts";
export type { StateVersion } from "./state-versions.ts";
export type {
  Output,
  PublicOutput,
  OutputShare,
  OutputShareEntry,
  OutputShareStatus,
} from "./outputs.ts";
export * from "./connections.ts";
export * from "./dependencies.ts";
export type {
  TakosumiApiErrorCode,
  TakosumiApiErrorEnvelope,
  TakosumiApiErrorHttpStatus,
} from "./deploy-control-errors.ts";
/** @deprecated retired Deployment ledger projection; kept for audit reads. */
export type {
  DeploymentStatus,
  PublicDeployment,
  PublicDeployment as Deployment,
  StateVersion as StateSnapshot,
} from "./deployments.ts";
export type {
  BackupConfig,
  InstallConfigCatalogDefault,
  InstallConfigCatalogInput,
  InstallConfigCatalogKind,
  InstallConfigCatalogMetadata,
  InstallConfigCatalogSource,
  InstallConfigCatalogSurface,
  InstallConfigCatalogText,
  InstallConfigSourceKind,
  InstallBuildConfig,
  InstallPrebuiltArtifactConfig,
  CapsuleStatus as InstallationStatus,
  NormalizationConfig,
  OutputAllowlistEntry,
  OutputValueType,
  PolicyConfig,
  PublicInstallConfig as InstallConfig,
  PublicCapsule as Installation,
  TrustLevel,
} from "./installations.ts";
/** @deprecated `OutputSnapshot` is renamed to `Output`. */
export type {
  PublicOutput as PublicOutputSnapshot,
  PublicOutput as OutputSnapshot,
} from "./outputs.ts";
export * from "./providers.ts";
export type {
  ArtifactRecord,
  PublicRun as Run,
  RunCostInfo,
  RunCostResponse,
  RunDiagnostic,
  RunEventsResponse,
  RunGroup,
  RunGroupResponse,
  RunGroupStatus,
  RunGroupType,
  RunLogsResponse,
  RunPolicyStatus,
  RunStatus,
  RunType,
} from "./runs.ts";
export * from "./security.ts";
export * from "./sources.ts";
export * from "./workspaces.ts";
/** @deprecated `Space` is renamed to `Workspace`. */
export type {
  Workspace as Space,
  WorkspaceType as SpaceType,
  CapsuleFullName as InstallationFullName,
} from "./workspaces.ts";
/** @deprecated `formatInstallationFullName` is renamed to `formatCapsuleFullName`. */
export { formatCapsuleFullName as formatInstallationFullName } from "./workspaces.ts";
