/**
 * Service-side Capsule execution configuration.
 *
 * InstallConfig describes execution policy, variable mapping, output
 * allowlist, policy, and presentation metadata for a Capsule. Capsule ledger
 * records live in `./capsules.ts`; this module intentionally exports no retired
 * Capsule aliases.
 *
 * A SourceSnapshot is analyzed and then executed without Takosumi rewriting.
 * User repos carry NO Takosumi manifest or reserved schema.
 */

import type { CapsuleInterfaceBlueprint } from "./interfaces.ts";
import type { ScopeBoundaryPolicy } from "./plan-scope.ts";
import type { JsonValue } from "./types.ts";

export type { Capsule, PublicCapsule, CapsuleStatus } from "./capsules.ts";
export type {
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
} from "./connections.ts";

export type OutputValueType =
  "string" | "url" | "hostname" | "number" | "boolean" | "json";

/** One outputAllowlist entry: project raw output `from` under the entry key. */
export interface OutputAllowlistEntry {
  readonly from: string;
  readonly type: OutputValueType;
  readonly required?: boolean;
  /**
   * Re-export this child-module output from the Takosumi-generated root as a
   * sensitive OpenTofu output. Sensitive outputs remain only in encrypted
   * OpenTofu state/raw runner artifacts and are ineligible for Interface,
   * Workspace, and explicit public Output projections.
   */
  readonly sensitive?: boolean;
}

/** One explicit source-build command executed without provider credentials. */
export interface SourceBuildCommand {
  readonly argv: readonly string[];
  /** Relative to the checked-out Git Source root. Defaults to the Source root. */
  readonly workingDirectory?: string;
}

/**
 * Optional user-approved source preparation for a plain OpenTofu Capsule.
 * Commands run in the isolated runner before every plan/apply/destroy and must
 * produce the declared relative paths before OpenTofu reads the child module.
 * Resource creation remains owned by the Git-hosted OpenTofu module.
 */
export interface SourceBuildConfig {
  readonly commands: readonly SourceBuildCommand[];
  readonly outputs: readonly string[];
}

/** Stable lifecycle-command capability token used by policy and runner actions. */
export const CAPSULE_LIFECYCLE_COMMAND_CAPABILITY =
  "capsule.lifecycle.command.v1" as const;

/**
 * Stable Run error code when a required Capsule lifecycle action did not reach
 * terminal success. The action phase/result is carried by Run audit evidence;
 * clients must not recover it by parsing the human-readable diagnostic.
 */
export const CAPSULE_LIFECYCLE_ACTION_FAILED_ERROR_CODE =
  "capsule_lifecycle_action_failed" as const;

export type InstallConfigLifecyclePhase = "post_apply" | "pre_destroy";
export type InstallConfigLifecycleExecutor = "runner" | "operator";

/**
 * One versioned, service-side Capsule lifecycle action.
 *
 * This record is stored in Takosumi's InstallConfig. It is never discovered
 * from a repository manifest or OpenTofu Output. Commands are deliberately
 * argv arrays rather than shell strings and may carry only non-secret env.
 * A pinned `post_apply` action must return terminal `succeeded` before the
 * Capsule becomes active and its Interface blueprints can materialize. Any
 * other result leaves the provider-applied StateVersion/Output committed but
 * terminalizes the Apply Run as failed and the Capsule as error. A pinned
 * `pre_destroy` action must terminal-succeed before provider destroy starts.
 */
export interface InstallConfigLifecycleCommandAction {
  readonly apiVersion: "takosumi.dev/v1alpha1";
  readonly kind: "command";
  readonly id: string;
  readonly phase: InstallConfigLifecyclePhase;
  readonly executor: InstallConfigLifecycleExecutor;
  readonly command: readonly string[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  /**
   * Must be allowed by InstallConfig policy. A `runner` action additionally
   * requires the selected RunnerProfile to advertise it; an `operator` action
   * is executed by the separately composed operator activator and does not
   * inherit RunnerProfile execution authority.
   */
  readonly runnerCapability: string;
  /**
   * Opt in to dispatch-only ProviderConnection material. Runner commands only;
   * operator actions use the operator activator's own explicit environment.
   */
  readonly useProviderCredentials?: boolean;
}

export type InstallConfigLifecycleAction = InstallConfigLifecycleCommandAction;

/**
 * Allocation mode for one operator-managed public hostname.
 *
 * `scoped` is the default address whose DNS label is namespaced by the
 * Workspace handle. `vanity` keeps the requested one-label name unchanged and
 * consumes one owner-account vanity slot. User-owned custom domains remain
 * ordinary `public_endpoint` URL/route variables and use the selected target's
 * ownership-verification lifecycle.
 */
export type ManagedPublicHostnameMode = "scoped" | "vanity";

export interface ManagedPublicHostnameAllocation {
  readonly mode: ManagedPublicHostnameMode;
}

/**
 * In-process operator request for claiming one managed public hostname.
 * Identity is always resolved from the referenced Capsule and Workspace;
 * callers never supply an owner account id.
 */
export interface ManagedPublicHostnameClaimRequest {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly requestedLabel: string;
  readonly managedPublicBaseDomain: string;
}

/** Non-disclosing result returned to compatibility and managed-target adapters. */
export type ManagedPublicHostnameClaimResult =
  | {
      readonly ok: true;
      readonly hostname: string;
      readonly mode: ManagedPublicHostnameMode;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_context"
        | "invalid_label"
        | "unavailable"
        | "slot_limit_reached";
      readonly limit?: number;
    };

/** Optional composition port exposed by an operator-hosted Takosumi process. */
export type ManagedPublicHostnameClaimer = (
  request: ManagedPublicHostnameClaimRequest,
) => Promise<ManagedPublicHostnameClaimResult>;

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
     * temporary credentials. Static provider secrets are an explicit supported
     * recipe choice unless this policy is enabled.
     */
    readonly requireTemporary?: boolean;
    /**
     * Require the mint evidence to include provider-enforced expiry / TTL.
     */
    readonly requireTtlEnforced?: boolean;
  };
  /** Explicit authority for service-side lifecycle command execution. */
  readonly lifecycleActions?: {
    readonly allowedExecutors: readonly InstallConfigLifecycleExecutor[];
    readonly allowedRunnerCapabilities: readonly string[];
    readonly allowProviderCredentials?: boolean;
  };
  readonly scopeBoundary?: ScopeBoundaryPolicy;
  readonly quota?: Readonly<Record<string, number>>;
}

/** Backup/export configuration. */
export interface BackupConfig {
  readonly enabled: boolean;
  readonly mode:
    "none" | "artifact_export" | "provider_snapshot" | "custom_command";
  /**
   * Exact operator-installed producer adapter. Required for
   * `provider_snapshot`; provider names and environment-variable suffixes never
   * select a producer.
   */
  readonly adapterId?: string;
  readonly command?: readonly string[];
  readonly outputPath?: string;
}

/** Operator-defined discovery grouping. It has no execution-policy meaning. */
export type InstallConfigStoreSurface = string;
/** Operator-defined discovery kind. It has no execution-policy meaning. */
export type InstallConfigStoreKind = string;
export type InstallConfigVariableDefault =
  | {
      readonly source: "literal";
      readonly value: JsonValue;
    }
  | { readonly source: "capsule_name" }
  | { readonly source: "workspace_scoped_capsule_name" };

export interface InstallConfigStoreText {
  readonly ja: string;
  readonly en: string;
}

/**
 * Open presentation hint token. The bundled dashboard enhances known hints
 * and safely renders unknown operator-installed hints as a generic input;
 * execution and validation authority never comes from this field.
 */
export type InstallConfigVariableInputFormat = string;

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
      /** Explicit application callback path; Takosumi never assumes one. */
      readonly callbackPath: string;
      readonly scopes?: readonly string[];
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

/**
 * Authenticated Capsule context projected into ordinary OpenTofu variables at
 * Run preparation time. Keys are dot-separated variable paths (for example
 * `env.APP_CAPSULE_ID`); values select only non-secret ledger identities.
 */
export type InstallContextVariableValue = "workspace_id" | "capsule_id";
export type InstallContextVariableMapping = Readonly<
  Record<string, InstallContextVariableValue>
>;

export interface InstallConfigStoreSource {
  readonly url: string;
  /** Optional display hint only; never part of InstallConfig selection. */
  readonly ref?: string;
  readonly path: string;
}

/**
 * Service-side presentation for one ordinary OpenTofu input variable.
 *
 * This is Takosumi DB configuration. It is deliberately not nested under
 * Store metadata and is never adopted from a Store listing or repository
 * metadata file.
 */
export interface InstallConfigVariablePresentation {
  readonly name: string;
  readonly type?: "string" | "number" | "boolean" | "json";
  readonly format?: InstallConfigVariableInputFormat;
  readonly required?: boolean;
  readonly advanced?: boolean;
  readonly secret?: boolean;
  readonly defaultValue?: InstallConfigVariableDefault;
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
}

/**
 * Service-side install configuration. Workspace-neutral rows are operator
 * catalog presentation only; their Git pointer is metadata, never an execution
 * shortcut or bundled-module authority.
 */
export interface InstallConfig {
  readonly id: string;
  readonly workspaceId?: string;
  readonly name: string;
  /** Path inside the SourceSnapshot that contains the OpenTofu Capsule. */
  readonly modulePath?: string;
  readonly sourceBuild?: SourceBuildConfig;
  /**
   * Versioned lifecycle actions owned by Takosumi service configuration.
   * OpenTofu Outputs remain ordinary return values and are never interpreted
   * as lifecycle declarations.
   */
  readonly lifecycleActions?: readonly InstallConfigLifecycleAction[];
  /** Managed hostname allocation choice. Absent means `scoped`. */
  readonly managedPublicHostname?: ManagedPublicHostnameAllocation;
  /**
   * Service-side runner preference for this Capsule. This is operator policy
   * selected at install/deploy time, not repo metadata.
   */
  readonly runnerId?: string;
  /** Internal service-side config rows are addressable by id but not selectable. */
  readonly internal?: {
    readonly reason: "per_install_overrides";
  };
  readonly variableMapping: Readonly<Record<string, unknown>>;
  /**
   * Service-owned context mapping. This does not read repository metadata or
   * Outputs and cannot inject credentials.
   */
  readonly installContextVariableMapping?: InstallContextVariableMapping;
  /**
   * Optional service-side UI declaration for ordinary OpenTofu variables.
   * Store and repository metadata can never add, replace, or default these
   * entries.
   */
  readonly variablePresentation?: readonly InstallConfigVariablePresentation[];
  /**
   * Optional service-side semantic projections used by Takosumi UX and
   * automation. This declaration is DB-owned and is not repository discovery
   * metadata or an OpenTofu Output convention.
   */
  readonly installExperience?: InstallConfigInstallExperience;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly policy: PolicyConfig;
  readonly backup?: BackupConfig;
  readonly store?: InstallConfigStoreMetadata;
  /**
   * Takosumi DB-owned runtime declarations proposed for Capsules created from
   * this config. This is service configuration, never a repository manifest or
   * an OpenTofu Output convention.
   */
  readonly interfaceBlueprints?: readonly CapsuleInterfaceBlueprint[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public InstallConfig projection returned by `/api` and dashboard session routes. */
export type PublicInstallConfig = Omit<InstallConfig, "runnerId" | "internal">;

/**
 * Exact artifact kind for a service-side InstallConfig patch.
 *
 * The artifact is an operator-selected DB contribution. It is never searched
 * for in a Git repository, selected from a release automatically, or treated
 * as an OpenTofu manifest/output schema.
 */
export const INSTALL_CONFIG_PATCH_V1_KIND =
  "takosumi.install-config-patch@v1" as const;

/**
 * Versioned mutable subset accepted by the operator InstallConfig patch API.
 * Identity, ownership, Git source selection, runner choice, Store metadata,
 * and timestamps remain owned by the targeted Takosumi InstallConfig row.
 */
export interface InstallConfigPatchV1 {
  readonly kind: typeof INSTALL_CONFIG_PATCH_V1_KIND;
  readonly variableMapping?: Readonly<Record<string, JsonValue>>;
  readonly variablePresentation?: readonly InstallConfigVariablePresentation[];
  readonly installExperience?: InstallConfigInstallExperience;
  readonly outputAllowlist?: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly interfaceBlueprints?: readonly CapsuleInterfaceBlueprint[];
  readonly lifecycleActions?: readonly InstallConfigLifecycleAction[];
  /** Replaces only `policy.lifecycleActions`; all other policy stays intact. */
  readonly lifecycleActionPolicy?: PolicyConfig["lifecycleActions"] | null;
}
