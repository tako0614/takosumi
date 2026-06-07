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
 * execution policy (trust, normalizer policy, variable mapping, output
 * allowlist, policy). User repos carry NO Takosumi manifest.
 */

import type { CapabilityBindings } from "./capability-bindings.ts";
import type { CapsuleCompatibilityLevel } from "./capsules.ts";

/** Compatibility install type. `core` is the Space base Capsule emitting shared outputs. */
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
  readonly destructiveChanges?: {
    readonly requireExplicitConfirmation: boolean;
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

/** Compatibility alias for older code while runtime field names are migrated. */
export type NormalizerPolicy = NormalizationConfig;

/**
 * Service-side install configuration. `spaceId` is absent for
 * official catalog configs shared across Spaces.
 */
export interface InstallConfig {
  readonly id: string;
  readonly spaceId?: string;
  readonly name: string;
  /**
   * Compatibility field for the pre-Capsule implementation. New Capsule-native
   * code should treat every install as a generated-root Capsule and use
   * `capsulePath` + `normalizerPolicy`; this remains until runtime branching is
   * fully retired.
   */
  readonly installType: InstallType;
  readonly trustLevel: TrustLevel;
  /** Path inside the SourceSnapshot that contains the OpenTofu Capsule. */
  readonly capsulePath?: string;
  readonly normalization?: NormalizationConfig;
  /** Compatibility alias. Prefer normalization. */
  readonly normalizerPolicy?: NormalizerPolicy;
  /** Compatibility alias for older template/rootgen paths. Prefer capsulePath. */
  readonly modulePath?: string;
  readonly build?: InstallBuildConfig;
  readonly variableMapping: Readonly<Record<string, unknown>>;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly policy: PolicyConfig;
  readonly backup?: BackupConfig;
  /**
   * Internal seam: binds an official catalog config to its template (the
   * rootgen module baked into the runner image). Absent for space-authored
   * configs. Retained as a compatibility seam while explicit install-type
   * branching is retired.
   */
  readonly templateBinding?: {
    readonly templateId: string;
    readonly templateVersion: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

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
  readonly sourceId: string;
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

/**
 * Per-Installation capability binding record (`deployment_profiles`).
 */
export interface DeploymentProfile {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly bindings: CapabilityBindings;
  readonly createdAt: string;
  readonly updatedAt: string;
}
