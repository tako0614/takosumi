/**
 * Installation + InstallConfig contract (`installations` / `install_configs`).
 *
 * An Installation is the OpenTofu execution unit directly under a Space
 * (`@space/name`): one Installation = one generated root + one OpenTofu
 * tfstate + outputs + deployments. The
 * App/Environment/InstallProfile lanes model is retired; `environment` is a
 * column on the Installation (UNIQUE(space_id, name, environment)).
 *
 * A SourceSnapshot is normalized as an OpenTofu Capsule before plan /
 * apply. InstallConfig is the service-side DB record describing Capsule
 * execution policy (trust, normalization policy, variable mapping, output
 * allowlist, policy). User repos carry NO Takosumi manifest.
 */

import type { ProviderBindings } from "./provider-bindings.ts";
import type { CapsuleCompatibilityLevel } from "./capsules.ts";

/**
 * Internal compatibility discriminator. `core` is the Space base Capsule
 * emitting shared outputs. `opentofu_root` is retained only so old direct-root
 * ledger rows can be read; new InstallConfigs are rejected at the domain-service
 * boundary.
 */
export type InstallType =
  | "core"
  | "opentofu_module"
  | "opentofu_root"
  | "app_source";

export type TrustLevel = "official" | "trusted" | "space" | "raw";

export type InstallationStatus =
  | "pending"
  | "active"
  | "stale"
  | "error"
  | "disabled"
  | "destroyed";

export type OutputValueType =
  | "string"
  | "url"
  | "hostname"
  | "number"
  | "boolean"
  | "json";

/** One outputAllowlist entry: project raw output `from` under the entry key. */
export interface OutputAllowlistEntry {
  readonly from: string;
  readonly type: OutputValueType;
  readonly required?: boolean;
}

/** Compatibility app-source build phase config (runs in the Container with no credentials). */
export interface InstallBuildConfig {
  readonly enabled: boolean;
  readonly workingDirectory?: string;
  readonly commands: readonly string[];
  readonly artifactPath?: string;
}

/**
 * Policy attached to an InstallConfig. Layered evaluation happens
 * service-side over the OpenTofu plan JSON; this record carries the per-config
 * allowlists and knobs. Extended by later policy layers (scope boundary,
 * quota) without breaking the stored shape.
 */
export interface PolicyConfig {
  readonly allowedProviders?: readonly string[];
  readonly allowedResourceTypes?: readonly string[];
  readonly allowedDataSourceTypes?: readonly string[];
  readonly allowedProvisionerTypes?: readonly string[];
  readonly destructiveChanges?: {
    readonly requireExplicitConfirmation: boolean;
  };
  readonly providerLockfile?: {
    /**
     * Require the runner to return a digest for the reviewed provider lockfile
     * after `tofu init`. Used by the §25 provider mirror / lockfile layer.
     */
    readonly requireDigest: boolean;
  };
  readonly providerInstallation?: {
    /**
     * Require actual-install attestation that every required provider was
     * installed from the runner's configured filesystem mirror. This blocks
     * accidental registry/network fallback when an Installation policy expects
     * offline provider installation.
     */
    readonly requireMirror: boolean;
  };
  readonly providerCredentials?: {
    /**
     * Require provider credential mint evidence to show provider-specific
     * temporary credentials. Static provider secrets remain a compatibility
     * path unless this policy is enabled.
     */
    readonly requireTemporary?: boolean;
    /**
     * Require the mint evidence to include provider-enforced expiry / TTL.
     */
    readonly requireTtlEnforced?: boolean;
    /**
     * Require credentials to be delivered only through generated-root variables.
     */
    readonly requireRootOnly?: boolean;
  };
  readonly scopeBoundary?: {
    /**
     * `strict` denies scoped provider resources when the plan projection lacks
     * the metadata needed to prove the resource is inside the boundary.
     */
    readonly mode?: "permissive" | "strict";
    readonly cloudflare?: {
      readonly accountIds?: readonly string[];
      readonly zoneIds?: readonly string[];
    };
    readonly aws?: {
      readonly accountIds?: readonly string[];
      readonly regions?: readonly string[];
    };
  };
  readonly quota?: Readonly<Record<string, number>>;
}

/** Backup/export configuration. */
export interface BackupConfig {
  readonly enabled: boolean;
  readonly mode:
    | "none"
    | "artifact_export"
    | "provider_snapshot"
    | "custom_command";
  readonly command?: readonly string[];
  readonly outputPath?: string;
}

export interface NormalizationConfig {
  readonly allowBackendRewrite: boolean;
  readonly allowProviderLift: boolean;
  readonly allowAliasInjection: boolean;
}

/**
 * Service-side install configuration. `spaceId` is absent for
 * built-in first-party configs shared across Spaces.
 */
export interface InstallConfig {
  readonly id: string;
  readonly spaceId?: string;
  readonly name: string;
  readonly installType: InstallType;
  readonly trustLevel: TrustLevel;
  /** Path inside the SourceSnapshot that contains the OpenTofu Capsule. */
  readonly modulePath?: string;
  readonly normalization?: NormalizationConfig;
  readonly build?: InstallBuildConfig;
  readonly variableMapping: Readonly<Record<string, unknown>>;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly policy: PolicyConfig;
  readonly backup?: BackupConfig;
  /**
   * Internal seam: binds a built-in first-party config to its bundled module.
   * New runs normalize the bundled module into generatedRoot.moduleFiles, the
   * same dispatch shape used by Git-sourced OpenTofu Capsules. Absent for
   * space-authored configs.
   */
  readonly templateBinding?: {
    readonly templateId: string;
    readonly templateVersion: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public InstallConfig projection returned by `/api` and dashboard session routes. */
export type PublicInstallConfig = Omit<
  InstallConfig,
  "installType" | "templateBinding"
>;

/**
 * Installation ledger record.
 * 1 Installation = Capsule + generated root + tfstate + outputs;
 * `currentStateGeneration` is the
 * generation guard cursor and `currentOutputSnapshotId` the latest projection.
 */
export interface Installation {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly slug: string;
  /**
   * Registered git {@link Source} this Installation tracks. Absent for
   * upload-origin Installations created by `takosumi deploy`, which deploy a
   * `SourceSnapshot(origin=upload)` directly with no Source. A git Source is an
   * optional attachment (the `wrangler deploy` vs Workers-Builds relationship),
   * not a precondition for an Installation to exist.
   */
  readonly sourceId?: string;
  readonly installType: InstallType;
  readonly installConfigId: string;
  readonly environment: string;
  readonly currentDeploymentId?: string;
  readonly currentStateGeneration: number;
  readonly currentOutputSnapshotId?: string;
  readonly compatibilityReportId?: string;
  readonly compatibilityStatus?: CapsuleCompatibilityLevel;
  readonly status: InstallationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public Installation projection returned by `/api` and dashboard session routes. */
export type PublicInstallation = Omit<Installation, "installType">;

/**
 * Internal per-Installation provider-binding record.
 *
 * The physical table is still named `deployment_profiles` for compatibility;
 * the public model is Connection + ProviderBinding resolution.
 */
export interface DeploymentProfile {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly bindings: ProviderBindings;
  readonly createdAt: string;
  readonly updatedAt: string;
}
