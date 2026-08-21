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

import type {
  CapsuleInterfaceBlueprint,
  CapsuleRequiredInterface,
  CapsuleResourceInterfaceBindingProposal,
} from "./interfaces.ts";
import type { InstallConfigHostRuntimeMaterialization } from "./host-runtime-materialization.ts";
export type { InstallConfigHostRuntimeMaterialization } from "./host-runtime-materialization.ts";
import type { ScopeBoundaryPolicy } from "./plan-scope.ts";
import type { RepositoryManifestInterfaceApiVersion } from "./repository-manifest.ts";
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
  /**
   * Optional first-apply cleanup pairing. This is valid only on a
   * `pre_destroy` action and names the exact `post_apply` action whose
   * dispatch is being compensated for. A missing or invalid pairing never
   * widens destroy authority; the runner keeps the normal output requirement.
   */
  readonly cleanupFor?: string;
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

/**
 * One immutable application-owned migration bundle selected by an
 * InstallConfig. `manifestPath` is resolved only inside the reviewed source
 * snapshot; SQL bytes are never an OpenTofu value or public Run field.
 */
export interface InstallConfigResourceMigrationBundle {
  readonly format: "takosumi.resource-migrations/v1";
  readonly manifestPath: string;
  readonly digest: `sha256:${string}`;
}

/**
 * A typed post-apply database migration. The declaration pins the OpenTofu
 * Resource address owned by the Capsule. The action and bundle digest are
 * Plan-pinned. The operator resolves the exact canonical Resource id,
 * generation, revision, and structured Capsule owner from server-side records
 * immediately before execution; OpenTofu Outputs are never target authority.
 */
export interface InstallConfigResourceMigrationAction {
  readonly apiVersion: "takosumi.dev/v1alpha1";
  readonly kind: "resource_migration";
  readonly id: string;
  readonly phase: "post_apply";
  readonly executor: "operator";
  readonly runnerCapability: string;
  readonly target: {
    readonly resourceAddress: string;
  };
  readonly bundle: InstallConfigResourceMigrationBundle;
  readonly timeoutSeconds?: number;
}

export type InstallConfigLifecycleAction =
  InstallConfigLifecycleCommandAction | InstallConfigResourceMigrationAction;

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
  /**
   * Exact hostname the caller is about to persist. The controller validates it
   * against the Capsule-derived allocation before mutating the reservation.
   */
  readonly expectedHostname: string;
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
     * Exact provider sources that require a ProviderConnection for this
     * InstallConfig. This is service-side execution configuration, not provider
     * brand inference or a provider execution allowlist.
     */
    readonly requiredProviders?: readonly string[];
    /** Exact host-composed destinations this InstallConfig may use. */
    readonly allowedConnectionIds?: readonly string[];
    /** Destinations excluded by this profile (for example managed vs BYOC). */
    readonly forbiddenConnectionIds?: readonly string[];
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
  /**
   * Explicit host/operator authority for repository-owned install-UX
   * declarations. An absent or empty permission allowlist grants no Interface
   * binding permissions; repository metadata can never widen this policy.
   */
  readonly repositoryInstallUx?: {
    readonly allowedInterfacePermissions: readonly string[];
    /** Delivery mechanisms repository-owned Interface requests may use. */
    readonly allowedInterfaceDeliveryTypes?: readonly string[];
    /**
     * Optional operator gate for repository-owned install UX. When set, a
     * SourceSnapshot without this exact manifest API version cannot be used
     * for preview or Capsule creation.
     */
    readonly requiredManifestApiVersion?: RepositoryManifestInterfaceApiVersion;
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

export const INSTALL_CONFIG_DEPLOYMENT_PROFILE_KEY_MAX_LENGTH = 128;

/**
 * Public, DB-owned choice shown after a product listing has been selected.
 * `key` is an opaque equality token; clients must not infer provider, module,
 * or environment semantics from it.
 */
export interface InstallConfigDeploymentProfile {
  readonly key: string;
  readonly label: InstallConfigStoreText;
  readonly description: InstallConfigStoreText;
  readonly order: number;
  readonly recommended: boolean;
  /** Product-owned management surface opened after the Takosumi Run completes. */
  readonly management?: {
    readonly kind: "external_console";
    readonly href: string;
    readonly label: InstallConfigStoreText;
  };
}

/** Runtime guard shared by request parsing and public dashboard projections. */
export function isInstallConfigDeploymentProfile(
  value: unknown,
): value is InstallConfigDeploymentProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const required = ["key", "label", "description", "order", "recommended"];
  if (
    !required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => ![...required, "management"].includes(key))
  ) {
    return false;
  }
  return (
    isInstallConfigDeploymentProfileKey(record.key) &&
    isExactInstallConfigStoreText(record.label) &&
    isExactInstallConfigStoreText(record.description) &&
    typeof record.order === "number" &&
    Number.isFinite(record.order) &&
    typeof record.recommended === "boolean" &&
    (record.management === undefined || isDeploymentProfileManagement(record.management))
  );
}

function isDeploymentProfileManagement(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (!hasExactKeys(record, ["kind", "href", "label"])) return false;
  if (
    record.kind !== "external_console" ||
    typeof record.href !== "string" ||
    !isExactInstallConfigStoreText(record.label)
  ) {
    return false;
  }
  try {
    const href = new URL(record.href);
    return href.protocol === "https:" && href.username === "" && href.password === "";
  } catch {
    return false;
  }
}

export function isInstallConfigDeploymentProfileKey(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= INSTALL_CONFIG_DEPLOYMENT_PROFILE_KEY_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  );
}

/** More than one profile is valid only with unique keys and one recommendation. */
export function installConfigDeploymentProfileSetIsValid(
  profiles: readonly InstallConfigDeploymentProfile[],
): boolean {
  if (!profiles.every(isInstallConfigDeploymentProfile)) return false;
  if (new Set(profiles.map((profile) => profile.key)).size !== profiles.length) {
    return false;
  }
  return (
    profiles.length <= 1 ||
    profiles.filter((profile) => profile.recommended).length === 1
  );
}

export function compareInstallConfigDeploymentProfiles(
  left: InstallConfigDeploymentProfile,
  right: InstallConfigDeploymentProfile,
): number {
  if (left.recommended !== right.recommended) {
    return left.recommended ? -1 : 1;
  }
  const order = left.order - right.order;
  if (order !== 0) return order;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function isExactInstallConfigStoreText(
  value: unknown,
): value is InstallConfigStoreText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    hasExactKeys(record, ["ja", "en"]) &&
    typeof record.ja === "string" &&
    record.ja.trim().length > 0 &&
    record.ja.length <= 500 &&
    typeof record.en === "string" &&
    record.en.trim().length > 0 &&
    record.en.length <= 500
  );
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
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

/**
 * DB-owned grouping compiled from an accepted repository install-UX proposal.
 * Input names may reference only accepted `variablePresentation` entries; the
 * group carries no provider, secret, lifecycle, or execution authority.
 */
export interface InstallConfigInstallFeature {
  readonly id: string;
  readonly label: InstallConfigStoreText;
  readonly optional: boolean;
  readonly inputs: readonly string[];
}

export interface InstallConfigRepositoryInstallUxState {
  readonly status: "accepted";
}

export interface InstallConfigInstallExperience {
  readonly projections?: readonly InstallConfigInstallProjection[];
  readonly features?: readonly InstallConfigInstallFeature[];
  /** Public-safe marker that this DB-owned configuration was compiled. */
  readonly repositoryInstallUx?: InstallConfigRepositoryInstallUxState;
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
 * Operator-owned selector for an InstallConfig's executable Source coordinate.
 *
 * Unlike `store.source`, this field is service policy rather than presentation
 * metadata. A TCS listing may be compared with it, but can never create or
 * override it.
 */
export interface InstallConfigSourceSelector {
  readonly url: string;
  readonly path: string;
}

/**
 * Canonical comparison shared by the Store UI and the Capsule authority
 * boundary. Git's optional `.git` suffix and harmless relative-path spelling
 * do not change a repository coordinate. URL fragments and trailing slashes
 * are presentation noise; query strings remain part of the executable URL.
 */
export function normalizeInstallConfigSourceUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return value
      .trim()
      .replace(/\/+$/u, "")
      .replace(/\.git$/iu, "");
  }
}

export function normalizeInstallConfigSourcePath(value: string): string {
  return (
    value
      .trim()
      .replace(/^\/+|\/+$/gu, "")
      .replace(/^\.\//u, "") || "."
  );
}

export function installConfigSourceCoordinateMatches(
  selector: InstallConfigSourceSelector | undefined,
  coordinate: { readonly url: string; readonly path: string },
): boolean {
  const selectorUrl = selector?.url.trim();
  const selectorPath = selector?.path.trim();
  const sourceUrl = coordinate.url.trim();
  const sourcePath = coordinate.path.trim();
  return Boolean(
    selectorUrl &&
    selectorPath &&
    sourceUrl &&
    sourcePath &&
    installConfigSourcePathIsComparable(selectorPath) &&
    installConfigSourcePathIsComparable(sourcePath) &&
    normalizeInstallConfigSourceUrl(selectorUrl) ===
      normalizeInstallConfigSourceUrl(sourceUrl) &&
    normalizeInstallConfigSourcePath(selectorPath) ===
      normalizeInstallConfigSourcePath(sourcePath),
  );
}

function installConfigSourcePathIsComparable(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\0") &&
    !value.split(/[\\/]+/u).some((part) => part === "..")
  );
}

/**
 * Service-side presentation for one ordinary OpenTofu input variable.
 *
 * This is Takosumi DB configuration. It is deliberately not nested under
 * Store metadata. A Store listing can never supply it; Takosumi may compile a
 * strictly validated proposal captured from an immutable repository snapshot
 * into this DB-owned shape before a reviewed Plan.
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
  /** DB-owned install choice under one canonical product listing. */
  readonly deploymentProfile?: InstallConfigDeploymentProfile;
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
  readonly sourceSelector?: InstallConfigSourceSelector;
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
    /** Immutable proposal provenance; never selectable through public APIs. */
    readonly sourceSnapshotId?: string;
    readonly repositoryInstallUxDigest?: string;
  };
  readonly variableMapping: Readonly<Record<string, unknown>>;
  /**
   * Service-owned context mapping. This does not read repository metadata or
   * Outputs and cannot inject credentials.
   */
  readonly installContextVariableMapping?: InstallContextVariableMapping;
  /**
   * Optional service-side UI declaration for ordinary OpenTofu variables.
   * Store metadata can never add, replace, or default these entries. An
   * immutable repository install-UX proposal has no direct authority: only the
   * compatibility/policy compiler's persisted result may contribute entries.
   */
  readonly variablePresentation?: readonly InstallConfigVariablePresentation[];
  /**
   * Optional service-side semantic projections used by Takosumi UX and
   * automation. This declaration is DB-owned and is not Store discovery
   * metadata or an OpenTofu Output convention. A repository proposal becomes
   * effective only after exact-snapshot compilation into this record.
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
  /**
   * Binding-only service proposals for Resource-owned Interfaces declared by
   * portable IaC. This field never carries an Interface document or spec.
   */
  readonly resourceInterfaceBindingProposals?: readonly CapsuleResourceInterfaceBindingProposal[];
  /**
   * Host Interface contracts this Capsule runtime must be authorized to use.
   * The exact Interface and pairwise OIDC Principal are resolved by the host;
   * this record carries no Interface id or credential.
   */
  readonly requiredInterfaces?: readonly CapsuleRequiredInterface[];
  /**
   * DB-owned, provider-neutral runtime materialization requirements. Core
   * forwards only opaque secret/capability refs where required; Resource
   * bindings carry no runtime credential and resolved values remain inside the
   * host.
   */
  readonly hostRuntimeMaterialization?: InstallConfigHostRuntimeMaterialization;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public InstallConfig projection returned by `/api` and dashboard session routes. */
export type PublicInstallConfig = Omit<
  InstallConfig,
  | "runnerId"
  | "internal"
  | "resourceInterfaceBindingProposals"
  | "requiredInterfaces"
  | "hostRuntimeMaterialization"
>;

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
