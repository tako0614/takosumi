/**
 * Service-side Capsule execution configuration.
 *
 * InstallConfig describes trust, normalization policy, variable mapping, output
 * allowlist, policy, and presentation metadata for a Capsule. Capsule ledger
 * records live in `./capsules.ts`; this module intentionally exports no retired
 * Capsule aliases.
 *
 * A SourceSnapshot is normalized as an OpenTofu Capsule before plan / apply.
 * User repos carry NO Takosumi manifest.
 */

import type { InstallType } from "./capsules.ts";

export type { InstallType } from "./capsules.ts";
export type { Capsule, PublicCapsule, CapsuleStatus } from "./capsules.ts";
export type {
  CapsuleProviderEnvBinding,
  CapsuleProviderEnvBindings,
  CapsuleProviderEnvBindingSet,
} from "./connections.ts";

export type TrustLevel = "official" | "trusted" | "space" | "raw";

/**
 * Public discriminator for choosing an InstallConfig without exposing internal
 * `installType` or generated-root authoring details.
 */
export type PublicInstallConfigSourceKind =
  "generic_capsule" | "first_party_capsule";

/**
 * Stored sourceKind. The old `official_template` value may exist in pre-v1
 * rows and is normalized out of every public projection.
 */
export type InstallConfigSourceKind =
  PublicInstallConfigSourceKind | "official_template";

export type OutputValueType =
  "string" | "url" | "hostname" | "number" | "boolean" | "json";

/** One outputAllowlist entry: project raw output `from` under the entry key. */
export interface OutputAllowlistEntry {
  readonly from: string;
  readonly type: OutputValueType;
  readonly required?: boolean;
}

/**
 * Stored app-source build metadata for old rows. New Capsules should keep
 * build/download decisions inside their Git-hosted OpenTofu/Terraform module or
 * app CI/release flow; Takosumi passes ordinary Capsule inputs.
 *
 * @deprecated Internal migration read only.
 */
export interface InstallBuildConfig {
  readonly enabled: boolean;
  readonly workingDirectory?: string;
  readonly commands: readonly string[];
  readonly artifactPath?: string;
}

/**
 * Stored service-side metadata for rows that already knew a prepared file path
 * inside the SourceSnapshot. New generated-root dispatch does not expose this
 * path to the runner.
 *
 * @deprecated Internal migration read only.
 */
export interface InstallPrebuiltArtifactConfig {
  readonly path: string;
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
     * accidental registry/network fallback when a Capsule policy expects
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
    "none" | "artifact_export" | "provider_snapshot" | "custom_command";
  readonly command?: readonly string[];
  readonly outputPath?: string;
}

export interface NormalizationConfig {
  readonly allowBackendRewrite: boolean;
  readonly allowProviderLift: boolean;
  readonly allowAliasInjection: boolean;
}

export type InstallConfigStoreSurface =
  "service" | "building_block" | "example";
export type InstallConfigStoreKind = "worker" | "storage" | "site";
export type InstallConfigStoreDefault =
  "service-name" | "service-name-with-space" | "main" | "us-east-1";

export interface InstallConfigStoreText {
  readonly ja: string;
  readonly en: string;
}

export type InstallConfigStoreInputFormat =
  | "text"
  | "url"
  | "hostname"
  | "subdomain"
  | "password"
  | "token"
  | "email"
  | "sha256";

export type InstallConfigInstallProjection =
  | {
      readonly kind: "service_name";
      readonly variable: string;
    }
  | {
      readonly kind: "public_endpoint";
      readonly variables: {
        readonly subdomain?: string;
        readonly url?: string;
        readonly routePattern?: string;
      };
      readonly baseDomain?: string;
    }
  | {
      readonly kind: "initial_secret";
      readonly variable: string;
      readonly secretKind?: "password" | "password_or_hash" | "token";
      readonly optional?: boolean;
    }
  | {
      readonly kind: "oidc_client";
      readonly variables: {
        readonly issuerUrl?: string;
        readonly accountsUrl?: string;
        readonly clientId?: string;
        readonly redirectUri?: string;
      };
      readonly callbackPath?: string;
    }
  | {
      readonly kind: "artifact";
      readonly variables: {
        readonly url?: string;
        readonly sha256?: string;
      };
    };

export interface InstallConfigInstallExperience {
  readonly projections?: readonly InstallConfigInstallProjection[];
}

export interface InstallConfigStoreSource {
  readonly git: string;
  readonly path: string;
}

export interface InstallConfigStoreInput {
  readonly name: string;
  readonly type?: "string" | "number" | "boolean" | "json";
  readonly format?: InstallConfigStoreInputFormat;
  readonly required?: boolean;
  readonly advanced?: boolean;
  readonly secret?: boolean;
  readonly defaultValue?: string;
  readonly label: InstallConfigStoreText;
  readonly helper?: InstallConfigStoreText;
  readonly placeholder?: string;
}

/**
 * Public-safe app-store presentation for an InstallConfig. This is discovery
 * metadata only: Git Source, plan/apply, Provider Bindings, and SourceSnapshot
 * resolution remain the execution authority.
 */
export interface InstallConfigStoreMetadata {
  readonly templateId?: string;
  readonly templateVersion?: string;
  readonly source?: InstallConfigStoreSource;
  readonly order: number;
  readonly surface: InstallConfigStoreSurface;
  readonly kind: InstallConfigStoreKind;
  readonly provider: string;
  readonly suggestedName: string;
  readonly badge: InstallConfigStoreText;
  readonly name: InstallConfigStoreText;
  readonly description: InstallConfigStoreText;
  readonly iconUrl?: string;
  readonly inputs: readonly InstallConfigStoreInput[];
  readonly installExperience?: InstallConfigInstallExperience;
}

/**
 * Service-side install configuration. `workspaceId` is absent for built-in
 * first-party configs shared across Workspaces.
 */
export interface InstallConfig {
  readonly id: string;
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly name: string;
  readonly sourceKind?: InstallConfigSourceKind;
  readonly installType: InstallType;
  readonly trustLevel: TrustLevel;
  /** Path inside the SourceSnapshot that contains the OpenTofu Capsule. */
  readonly modulePath?: string;
  readonly normalization?: NormalizationConfig;
  readonly build?: InstallBuildConfig;
  readonly prebuiltArtifact?: InstallPrebuiltArtifactConfig;
  /**
   * Service-side runner preference for this Capsule. This is operator policy
   * selected at install/deploy time, not repo metadata.
   */
  readonly runnerId?: string;
  /** Internal service-side config rows are addressable by id but not selectable. */
  readonly internal?: {
    readonly reason: "per_install_overrides" | "resource_shape_backing_capsule";
  };
  readonly variableMapping: Readonly<Record<string, unknown>>;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly policy: PolicyConfig;
  readonly backup?: BackupConfig;
  readonly store?: InstallConfigStoreMetadata;
  /**
   * Internal seam: binds a built-in first-party config to its bundled module.
   * New runs normalize the bundled module into generatedRoot.moduleFiles, the
   * same dispatch shape used by Git-sourced OpenTofu Capsules. Absent for
   * workspace-authored configs.
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
  | "installType"
  | "templateBinding"
  | "sourceKind"
  | "runnerId"
  | "internal"
  | "build"
  | "prebuiltArtifact"
> & {
  readonly sourceKind: PublicInstallConfigSourceKind;
  readonly store?: InstallConfigStoreMetadata;
};
