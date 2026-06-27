/**
 * Public Takosumi deploy-control contract facade.
 *
 * Takosumi's final customer-facing vocabulary is Workspace / Project /
 * Capsule / Source / ProviderConnection / CredentialRecipe / ProviderBinding /
 * Secret / Run / Plan / Apply / Destroy / StateVersion / Output / Runner /
 * AuditEvent / Operator.
 *
 * This facade still exports some compatibility DTO names used by the current
 * dashboard and operator tooling (Space / Installation / Deployment /
 * OutputSnapshot / RunGroup / Provider Catalog). Treat those as implementation
 * compatibility aliases while the wire surface migrates; do not introduce them
 * as new public product nouns.
 *
 * Internal in-process compatibility DTOs for the account-plane workload seam live in
 * `internal-deploy-control-api.ts` and are intentionally not re-exported here.
 */

export * from "./activity.ts";
export * from "./backups.ts";
export * from "./billing.ts";
export type {
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
  CapsuleCompatibility,
  CapsuleCompatibilityLevel,
  CapsuleDataSourceSummary,
  CapsuleFindingSeverity,
  CapsuleGateFinding,
  CapsuleGateResult,
  CapsuleProviderRequirement,
  CapsuleProvisionerSummary,
  PublicCapsuleCompatibilityReport as CapsuleCompatibilityReport,
  PublicCapsuleCompatibilityReportResponse as CapsuleCompatibilityReportResponse,
  CapsuleResourceSummary,
  CreateSourceCompatibilityCheckRequest,
} from "./capsules.ts";
export * from "./connections.ts";
export * from "./dependencies.ts";
export type {
  TakosumiApiErrorCode,
  TakosumiApiErrorEnvelope,
  TakosumiApiErrorHttpStatus,
} from "./deploy-control-errors.ts";
export type {
  DeploymentStatus,
  PublicDeployment,
  PublicDeployment as Deployment,
  StateSnapshot,
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
  InstallationStatus,
  NormalizationConfig,
  OutputAllowlistEntry,
  OutputValueType,
  PolicyConfig,
  PublicInstallConfig as InstallConfig,
  PublicInstallation as Installation,
  TrustLevel,
} from "./installations.ts";
export type {
  OutputShare,
  OutputShareEntry,
  OutputShareStatus,
  PublicOutputSnapshot,
  PublicOutputSnapshot as OutputSnapshot,
} from "./output-snapshots.ts";
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
export * from "./spaces.ts";
