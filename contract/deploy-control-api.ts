/**
 * Public Takosumi deploy-control contract facade.
 *
 * Takosumi v1 public vocabulary is Space / Source / Connection / Provider
 * Template / Provider Env Set / OpenTofu Capsule / Capsule
 * Normalizer / Compatibility Report / Capsule Gate / Installation /
 * InstallConfig / DeploymentProfile / ProviderBinding / Dependency /
 * SourceSnapshot / DependencySnapshot / StateSnapshot / Run / RunGroup /
 * Deployment / OutputSnapshot / Backup / Billing / Activity / Security records.
 *
 * Internal in-process compatibility DTOs for the legacy `/v1` seam live in
 * `internal-deploy-control-api.ts` and are intentionally not re-exported here.
 */

export * from "./activity.ts";
export * from "./backups.ts";
export * from "./billing.ts";
export * from "./provider-bindings.ts";
export * from "./capsules.ts";
export * from "./connections.ts";
export * from "./dependencies.ts";
export type {
  TakosumiApiErrorCode,
  TakosumiApiErrorEnvelope,
  TakosumiApiErrorHttpStatus,
} from "./deploy-control-errors.ts";
export * from "./deployments.ts";
export * from "./install-link.ts";
export type {
  BackupConfig,
  DeploymentProfile,
  InstallBuildConfig,
  InstallationStatus,
  NormalizationConfig,
  OutputAllowlistEntry,
  OutputValueType,
  PolicyConfig,
  PublicInstallConfig as InstallConfig,
  PublicInstallation as Installation,
  TrustLevel,
} from "./installations.ts";
export * from "./output-snapshots.ts";
export * from "./providers.ts";
export * from "./runs.ts";
export * from "./security.ts";
export * from "./sources.ts";
export * from "./spaces.ts";
