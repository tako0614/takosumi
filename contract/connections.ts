import type { JsonValue } from "./types.ts";
import { INTERNAL_V1_PREFIX } from "./api-surface.ts";

// INTERNAL deploy-control seam — Connections surface under `/internal/v1`
// (reached in-process / by the account plane, NOT edge-public). Connection
// creation is split into kind-specific subroutes; the base path is the
// operator/space listing.
export const CONNECTIONS_PATH = `${INTERNAL_V1_PREFIX}/connections` as const;
export const CONNECTIONS_SOURCE_HTTPS_TOKEN_PATH =
  `${INTERNAL_V1_PREFIX}/connections/source/https-token` as const;
export const CONNECTIONS_SOURCE_SSH_KEY_PATH =
  `${INTERNAL_V1_PREFIX}/connections/source/ssh-key` as const;
export const CONNECTIONS_CLOUDFLARE_TOKEN_PATH =
  `${INTERNAL_V1_PREFIX}/connections/cloudflare/token` as const;
export const CONNECTIONS_AWS_ASSUME_ROLE_PATH =
  `${INTERNAL_V1_PREFIX}/connections/aws/assume-role` as const;
export const CONNECTIONS_GENERIC_ENV_PROVIDER_PATH =
  `${INTERNAL_V1_PREFIX}/connections/generic-env-provider` as const;
export const CONNECTIONS_CLOUDFLARE_OAUTH_START_PATH =
  `${INTERNAL_V1_PREFIX}/connections/cloudflare/oauth/start` as const;
export const CONNECTIONS_CLOUDFLARE_OAUTH_CALLBACK_PATH =
  `${INTERNAL_V1_PREFIX}/connections/cloudflare/oauth/callback` as const;
export const CONNECTIONS_GCP_OAUTH_START_PATH =
  `${INTERNAL_V1_PREFIX}/connections/gcp/oauth/start` as const;
export const CONNECTIONS_GCP_OAUTH_CALLBACK_PATH =
  `${INTERNAL_V1_PREFIX}/connections/gcp/oauth/callback` as const;
export const CONNECTIONS_GCP_IMPERSONATION_PATH =
  `${INTERNAL_V1_PREFIX}/connections/gcp/impersonation` as const;
export const CONNECTIONS_GCP_SERVICE_ACCOUNT_JSON_PATH =
  `${INTERNAL_V1_PREFIX}/connections/gcp/service-account-json` as const;
export const CONNECTION_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/connections/${encodeURIComponent(id)}`;
export const CONNECTION_TEST_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/connections/${encodeURIComponent(id)}/test`;
export const CONNECTION_REVOKE_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/connections/${encodeURIComponent(id)}/revoke`;

export type ConnectionScopeKind = "operator" | "space";

/**
 * Operational credential state machine (vault authority). The public read view
 * projects this through {@link publicProviderConnectionStatus}.
 */
export type ConnectionStatus =
  "pending" | "verified" | "revoked" | "expired" | "error";

/**
 * Single Provider Connection kind axis. The vault routes mint/verify drivers
 * from this one value, and the
 * `oauth` vs `secret` distinction is carried by the stored
 * {@link ProviderConnectionMaterialization}.
 */
export const PROVIDER_CONNECTION_KINDS = [
  "source_git_https_token",
  "source_git_ssh_key",
  "cloudflare_oauth",
  "cloudflare_api_token",
  "aws_assume_role",
  "gcp_oauth_bootstrap",
  "gcp_service_account_json",
  "gcp_service_account_impersonation",
  "static_secret",
  "generic_env_provider",
  "manual",
] as const;

export type ProviderConnectionKind = (typeof PROVIDER_CONNECTION_KINDS)[number];

export const PROVIDER_CONNECTION_MATERIALIZATIONS = [
  "oauth",
  "secret",
] as const;

export type ProviderConnectionMaterialization =
  (typeof PROVIDER_CONNECTION_MATERIALIZATIONS)[number];

export function isProviderConnectionMaterialization(
  value: unknown,
): value is ProviderConnectionMaterialization {
  return (
    typeof value === "string" &&
    PROVIDER_CONNECTION_MATERIALIZATIONS.includes(
      value as ProviderConnectionMaterialization,
    )
  );
}

/** Public read-view status for a Provider Connection. */
export type ProviderConnectionStatus =
  "ready" | "needs_setup" | "expired" | "blocked";

export const PROVIDER_CONNECTION_STATUSES = [
  "ready",
  "needs_setup",
  "expired",
  "blocked",
] as const;

/**
 * Projects the operational {@link ConnectionStatus} onto the public
 * {@link ProviderConnectionStatus} read view. Kept byte-stable so the resolved
 * provider-binding digest (plan→apply TOCTOU pin) is unchanged across the
 * credential-model collapse.
 */
export function publicProviderConnectionStatus(
  status: ConnectionStatus,
): ProviderConnectionStatus {
  switch (status) {
    case "verified":
      return "ready";
    case "expired":
      return "expired";
    case "revoked":
      return "blocked";
    default:
      return "needs_setup";
  }
}

export interface ConnectionScopeHints {
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly workersSubdomain?: string;
  /**
   * Marks an operator-scoped Provider Connection as a public managed-provider
   * compatibility endpoint, not as a raw operator credential. Only rows with
   * this marker may be projected into Workspace provider choices.
   */
  readonly managedProvider?: boolean;
  /**
   * Non-secret provider-block arguments supplied by this Connection. Keys are
   * provider schema arguments (for example `base_url`); values are rendered as
   * escaped HCL literals by the generated root. Credential-shaped fields are
   * rejected by the vault; secrets belong in Connection values/files.
   */
  readonly providerConfig?: Readonly<Record<string, JsonValue>>;
  /**
   * Optional non-secret defaults offered to child module variables. Takosumi
   * only forwards keys the module actually declares, and explicit Capsule
   * values always win. Credential-shaped fields are rejected by the vault.
   */
  readonly moduleInputDefaults?: Readonly<Record<string, JsonValue>>;
  readonly managedProviderProfile?: string;
  /**
   * Public hostname namespace owned by this managed target. A hosted operator
   * may use a different namespace per environment without rewriting repository
   * install metadata (for example app-staging.takos.jp in staging).
   */
  readonly managedPublicBaseDomain?: string;
  readonly cloudflareTokenVending?: CloudflareTokenVendingConfig;
  readonly repoUrl?: string;
  readonly username?: string;
  readonly knownHostsEntry?: string;
  readonly awsRoleArn?: string;
  readonly awsExternalId?: string;
  readonly awsRegion?: string;
  readonly gcpServiceAccountEmail?: string;
  readonly gcpProjectId?: string;
  readonly templateId?: string;
}

export interface CloudflareTokenVendingConfig {
  readonly policies: readonly CloudflareTokenPolicy[];
  readonly ttlSeconds?: number;
  readonly namePrefix?: string;
  readonly condition?: Readonly<Record<string, JsonValue>>;
}

export interface CloudflareTokenPolicy {
  readonly id?: string;
  readonly effect: "allow" | "deny";
  readonly permission_groups: readonly CloudflarePermissionGroup[];
  readonly resources: Readonly<Record<string, JsonValue>>;
}

export interface CloudflarePermissionGroup {
  readonly id: string;
  readonly meta?: Readonly<Record<string, string>>;
  readonly name?: string;
}

/**
 * Unified stored Provider Connection credential record.
 *
 * This single type replaces the former `Connection` (rich internal substrate),
 * `ProviderConnection` (slim public façade), and `ProviderEnv` (resolver record
 * with `materialization`). One row per credential is stored in the `connections`
 * store; the sealed secret material lives in the per-connection secret blob, not
 * on this row.
 *
 *   - `status` is the operational vault state machine; the public read view maps
 *     it through {@link publicProviderConnectionStatus}.
 *   - `materialization` (oauth | secret) is stored at register time (folded from
 *     the former `ProviderEnv.materialization`); it labels OAuth-minted vs
 *     static-secret credentials and feeds the resolved-binding digest.
 *   - `envNames` is the credential's declared env-name set (the former
 *     `ProviderEnv.requiredEnvNames`).
 */
export interface ProviderConnection {
  readonly id: string;
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly provider: string;
  readonly providerSource: string;
  readonly kind?: ProviderConnectionKind;
  readonly scope: ConnectionScopeKind;
  readonly displayName?: string;
  readonly status: ConnectionStatus;
  readonly materialization: ProviderConnectionMaterialization;
  readonly envNames: readonly string[];
  readonly fileEnvNames?: readonly string[];
  readonly scopeHints?: ConnectionScopeHints;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
}

/** @deprecated migration-debt alias for the unified {@link ProviderConnection}. */
export type Connection = ProviderConnection;

export interface ListProviderConnectionsResponse {
  readonly providerConnections: readonly ProviderConnection[];
}

/**
 * Provider-address (or alias) -> Provider Connection mapping for one
 * Capsule. The single binding shape; replaces the former
 * `CapsuleProviderConnectionBinding` (connectionId) and
 * `CapsuleProviderEnvBinding` (envId) pair (they always pointed at the same
 * row, since `ProviderEnv.id == Connection.id`).
 */
export interface ProviderBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly connectionId: string;
  readonly region?: string;
}

export type ProviderBindings = readonly ProviderBinding[];

/** One binding set per (capsule, environment). */
export interface ProviderBindingSet {
  readonly id: string;
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId: string;
  readonly capsuleId: string;
  /** @deprecated Use capsuleId. */
  readonly installationId: string;
  readonly environment: string;
  readonly bindings: ProviderBindings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** @deprecated migration-debt alias for {@link ProviderBinding}. */
export type CapsuleProviderConnectionBinding = ProviderBinding;
/** @deprecated migration-debt alias for {@link ProviderBindings}. */
export type CapsuleProviderConnectionBindings = ProviderBindings;
/** @deprecated migration-debt alias for {@link ProviderBindingSet}. */
export type CapsuleProviderConnectionSet = ProviderBindingSet;
/** @deprecated migration-debt alias for {@link ProviderBinding}. */
export type CapsuleProviderEnvBinding = ProviderBinding;
/** @deprecated migration-debt alias for {@link ProviderBindings}. */
export type CapsuleProviderEnvBindings = ProviderBindings;
/** @deprecated migration-debt alias for {@link ProviderBindingSet}. */
export type CapsuleProviderEnvBindingSet = ProviderBindingSet;

// --- transient deprecated `Installation*` binding aliases (pre-rename names) ---
/** @deprecated use {@link CapsuleProviderConnectionBinding}. */
export type InstallationProviderConnectionBinding = ProviderBinding;
/** @deprecated use {@link CapsuleProviderConnectionBindings}. */
export type InstallationProviderConnectionBindings = ProviderBindings;
/** @deprecated use {@link CapsuleProviderConnectionSet}. */
export type InstallationProviderConnectionSet = ProviderBindingSet;
/** @deprecated use {@link CapsuleProviderEnvBinding}. */
export type InstallationProviderEnvBinding = ProviderBinding;
/** @deprecated use {@link CapsuleProviderEnvBindings}. */
export type InstallationProviderEnvBindings = ProviderBindings;
/** @deprecated use {@link CapsuleProviderEnvBindingSet}. */
export type InstallationProviderEnvBindingSet = ProviderBindingSet;

export interface CreateConnectionRequest {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly provider: string;
  readonly kind?: ProviderConnectionKind;
  readonly displayName?: string;
  readonly scope?: ConnectionScopeKind;
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  /**
   * Credential materialization label stored on the connection. Defaults to
   * `secret`; the OAuth callback path supplies `oauth`.
   */
  readonly materialization?: ProviderConnectionMaterialization;
  readonly values: Readonly<Record<string, string>>;
  readonly files?: readonly CreateConnectionFile[];
}

export interface CreateConnectionFile {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
  readonly envName?: string;
}

export interface ConnectionOAuthStartRequest {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: ConnectionScopeKind;
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  readonly redirectUri?: string;
  readonly successRedirectUri?: string;
}

export interface ConnectionOAuthStartResponse {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt?: string;
}

export interface GcpImpersonationConnectionRequest {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: ConnectionScopeKind;
  readonly scopeHints: ConnectionScopeHints & {
    readonly gcpServiceAccountEmail: string;
    readonly gcpProjectId: string;
  };
  readonly expiresAt?: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface ConnectionResponse {
  readonly connection: ProviderConnection;
}

export interface ListConnectionsResponse {
  readonly connections: readonly ProviderConnection[];
  /**
   * Opaque keyset cursor for the next page when the listing was capped (spec §30
   * pagination). Absent on the last page or on an unpaginated listing (e.g. the
   * operator-scope listing). Additive: readers that ignore it are unaffected.
   */
  readonly nextCursor?: string;
}

export interface TestConnectionResponse {
  readonly status: Extract<
    ConnectionStatus,
    "verified" | "pending" | "expired"
  >;
  readonly detail?: string;
}
