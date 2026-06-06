/**
 * Installation + InstallConfig contract (Core Specification §5 / §10 / §11 /
 * §27 `installations` / `install_configs`).
 *
 * An Installation is the OpenTofu execution unit directly under a Space
 * (`@space/name`): one Installation = one OpenTofu root/state. The
 * App/Environment/InstallProfile lanes model is retired; `environment` is a
 * column on the Installation (UNIQUE(space_id, name, environment)).
 *
 * An InstallConfig is the service-side DB record describing how a Source is
 * treated (install type, trust, build, variable mapping, output allowlist,
 * policy). User repos carry NO Takosumi manifest.
 */

import type { CapabilityBindings } from "./capability-bindings.ts";

/** Spec §10. `core` is the Space base Installation emitting shared outputs. */
export type InstallType =
  | "core"
  | "opentofu_module"
  | "opentofu_root"
  | "app_source";

export type TrustLevel = "official" | "trusted" | "space" | "raw";

export type InstallationStatus =
  | "installing"
  | "active"
  | "stale"
  | "error"
  | "destroying"
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

/** `app_source` build phase config (runs in the Container with no credentials). */
export interface InstallBuildConfig {
  readonly enabled: boolean;
  readonly workingDirectory?: string;
  readonly commands: readonly string[];
  readonly artifactPath?: string;
}

/**
 * Policy attached to an InstallConfig (spec §25). Layered evaluation happens
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
  readonly quota?: Readonly<Record<string, number>>;
}

/** Spec §33. Backup implementation is post-MVP; the shape is canonical now. */
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

/**
 * Service-side install configuration (spec §11). `spaceId` is absent for
 * official catalog configs shared across Spaces.
 */
export interface InstallConfig {
  readonly id: string;
  readonly spaceId?: string;
  readonly name: string;
  readonly installType: InstallType;
  readonly trustLevel: TrustLevel;
  readonly modulePath?: string;
  readonly build?: InstallBuildConfig;
  readonly variableMapping: Readonly<Record<string, unknown>>;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly policy: PolicyConfig;
  readonly backup?: BackupConfig;
  /**
   * Internal seam: binds an official catalog config to its template (the
   * rootgen module baked into the runner image). Absent for space-authored
   * configs. Reworked when the install types land (conformance M5).
   */
  readonly templateBinding?: {
    readonly templateId: string;
    readonly templateVersion: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Installation ledger record (spec §5 / §27 `installations`).
 * 1 Installation = 1 OpenTofu root/state; `currentStateGeneration` is the
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
  readonly status: InstallationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Per-Installation capability binding record (spec §9 / §27
 * `deployment_profiles`).
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
