import type { JsonValue } from "./types.ts";
import type { SourceGitConnectionKind } from "./sources.ts";
import { INTERNAL_V1_PREFIX } from "./api-surface.ts";

// INTERNAL deploy-control seam — Connections surface under `/internal/v1`
// (reached in-process / by the account plane, NOT edge-public). Provider-owned
// setup and OAuth helpers are selected by opaque helper ids; Core never grows a
// route matrix for individual vendors.
export const CONNECTIONS_PATH = `${INTERNAL_V1_PREFIX}/connections` as const;
export const CONNECTION_SETUP_PATH =
  `${INTERNAL_V1_PREFIX}/connections/setups/:setupId` as const;
export const CONNECTION_OAUTH_START_PATH =
  `${INTERNAL_V1_PREFIX}/connections/oauth/:helperId/start` as const;
export const CONNECTION_OAUTH_CALLBACK_PATH =
  `${INTERNAL_V1_PREFIX}/connections/oauth/:helperId/callback` as const;
export const CONNECTION_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/connections/${encodeURIComponent(id)}`;
export const CONNECTION_TEST_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/connections/${encodeURIComponent(id)}/test`;
export const CONNECTION_REVOKE_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/connections/${encodeURIComponent(id)}/revoke`;

export type ConnectionScopeKind = "operator" | "workspace";

/**
 * Operational credential state machine (vault authority). The public read view
 * projects this through {@link publicProviderConnectionStatus}.
 */
export type ConnectionStatus =
  "pending" | "verified" | "revoked" | "expired" | "error";

/**
 * Open recipe reference that controls env/file/pre-run materialization.
 * Operators may install recipes unknown to this build; Core therefore treats
 * both identifiers as opaque, versionable tokens rather than a closed enum.
 */
export interface ProviderConnectionRecipeRef {
  readonly id: string;
  readonly authMode: string;
  /**
   * Opaque at-rest secret partition selected by the recipe/connection. Core
   * persists this value and never derives a closed cloud family at open time.
   */
  readonly secretPartition?: string;
  /** Resolved delivery names pinned when the connection is created. */
  readonly envNames?: readonly string[];
  readonly fileEnvNames?: readonly string[];
  readonly requiredEnvGroups?: readonly (readonly string[])[];
  /**
   * Installed recipe capability allowing caller-declared env/file names. This
   * is copied from the resolved recipe definition; callers cannot enable it by
   * choosing a reserved recipe id.
   */
  readonly declaredEnv?: boolean;
  /** Explicit pre-run driver token selected by the recipe, if any. */
  readonly preRunAction?: string;
}

/** True when the installed recipe permits caller-declared env/file names. */
export function usesDeclaredEnvCredentialRecipe(
  connection: Pick<ProviderConnection, "credentialRecipe">,
): boolean {
  return connection.credentialRecipe?.declaredEnv === true;
}

/** Opaque audit/UI label. CredentialRecipe is the sole execution authority. */
export type ProviderConnectionMaterialization = string;

export function isProviderConnectionMaterialization(
  value: unknown,
): value is ProviderConnectionMaterialization {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !/\s/u.test(value) &&
    value !== "gateway" &&
    value !== "runner_token"
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
  /**
   * Opaque non-secret settings consumed only by the explicitly selected
   * provider helper/runtime driver. Core validates JSON shape and secret-like
   * keys but does not interpret a vendor schema.
   */
  readonly providerSettings?: Readonly<Record<string, JsonValue>>;
  /**
   * Opaque operator-owned profile that authorizes this row as a public managed
   * Provider Connection. The same exact token is declared by the receiving
   * platform extension and is used as the run-token audience. Core never
   * derives it from a provider address, hostname, or `providerConfig` value.
   */
  readonly managedProviderProfile?: string;
  /**
   * Public hostname namespace owned by this managed target. A hosted operator
   * may use a different namespace per environment without rewriting repository
   * install metadata (for example an operator-managed staging namespace).
   */
  readonly managedPublicBaseDomain?: string;
}

/** Returns the explicit managed-provider profile, normalized for comparison. */
export function managedProviderProfile(
  scopeHints: ConnectionScopeHints | undefined,
): string | undefined {
  const profile = scopeHints?.managedProviderProfile;
  return typeof profile === "string" && profile.trim().length > 0
    ? profile.trim()
    : undefined;
}

/**
 * Public managed capacity is opt-in service-side configuration. An opaque
 * provider-block value such as `providerConfig.base_url` is never authority to
 * expose an operator credential or let a pending row back a Workspace Run.
 */
export function isPublicManagedProviderConnection(
  connection: Pick<ProviderConnection, "scope" | "workspaceId" | "scopeHints">,
): boolean {
  return (
    connection.scope === "operator" &&
    connection.workspaceId === undefined &&
    connection.scopeHints?.managedProvider === true &&
    managedProviderProfile(connection.scopeHints) !== undefined
  );
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
 *   - `materialization` is an opaque inert audit/UI label. It never selects a
 *     verifier, mint driver, admission path, env name, file, or pre-run action;
 *     those semantics belong exclusively to `credentialRecipe`.
 *   - `envNames` is the credential's declared env-name set (the former
 *     `ProviderEnv.requiredEnvNames`).
 */
export interface ProviderConnection {
  readonly id: string;
  readonly workspaceId?: string;
  readonly provider: string;
  readonly providerSource: string;
  /** Canonical credential materialization authority for provider connections. */
  readonly credentialRecipe?: ProviderConnectionRecipeRef;
  /**
   * Resolved opaque at-rest partition persisted with any sealed credential
   * material. New credential registrations require it; credentialless
   * metadata connections may omit it. Vault open fails closed when absent and
   * never derives a provider family at read time.
   */
  readonly secretPartition?: string;
  /** Source-phase transport discriminator; absent for Provider Connections. */
  readonly kind?: SourceGitConnectionKind;
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

export interface ListProviderConnectionsResponse {
  readonly providerConnections: readonly ProviderConnection[];
}

/**
 * Provider-address (or alias) -> Provider Connection mapping for one
 * Capsule. The binding points directly at the selected Provider Connection;
 * no parallel resolver entity or alias identifier exists.
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
  readonly capsuleId: string;
  readonly environment: string;
  readonly bindings: ProviderBindings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateConnectionRequest {
  readonly workspaceId?: string;
  readonly provider: string;
  /** Explicit recipe/mode selected by a setup helper or generic create flow. */
  readonly credentialRecipe?: ProviderConnectionRecipeRef;
  /** Source-phase transport discriminator; Provider Connections use a recipe. */
  readonly kind?: SourceGitConnectionKind;
  readonly displayName?: string;
  readonly scope?: ConnectionScopeKind;
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  /**
   * Opaque audit/UI label stored on the connection. Defaults to `secret` and
   * has no execution or admission semantics.
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

/**
 * Provider-neutral input to an explicitly selected provider-owned setup
 * helper. The helper returns a normal {@link CreateConnectionRequest}; helper
 * metadata never becomes a second credential authority.
 */
export interface ConnectionSetupRequest {
  readonly workspaceId?: string;
  readonly provider?: string;
  readonly displayName?: string;
  readonly scope?: ConnectionScopeKind;
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  readonly values: Readonly<Record<string, string>>;
  readonly files?: readonly CreateConnectionFile[];
}

export interface ConnectionOAuthStartRequest {
  readonly workspaceId?: string;
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
