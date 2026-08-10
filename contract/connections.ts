import type { JsonValue } from "./types.ts";
import type { CredentialRecipeRunIssuance } from "./credential-recipes.ts";
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
  /** Server-resolved run-issuance authority pinned from the installed mode. */
  readonly runIssuance?: CredentialRecipeRunIssuance;
}

/** Closed check for the only run-issued credential descriptor supported by v1. */
export function isCapsuleRunCredentialIssuance(
  value: unknown,
): value is CredentialRecipeRunIssuance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record.context === "capsule-run.v1" &&
    record.operatorConnection === "workspace-bindable" &&
    record.storedMaterial === "none" &&
    isExactRunCredentialAudience(record.audience) &&
    isExactRunCredentialScopes(record.scopes)
  );
}

/** Set-exact comparison for the authority pinned on a recipe/Connection. */
export function sameCapsuleRunCredentialIssuance(
  left: unknown,
  right: unknown,
): boolean {
  if (
    !isCapsuleRunCredentialIssuance(left) ||
    !isCapsuleRunCredentialIssuance(right) ||
    left.audience !== right.audience ||
    left.scopes.length !== right.scopes.length
  ) {
    return false;
  }
  const rightScopes = new Set(right.scopes);
  return left.scopes.every((scope) => rightScopes.has(scope));
}

function isExactRunCredentialAudience(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isExactRunCredentialScopes(
  value: unknown,
): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return false;
  }
  const scopes = value as unknown[];
  return (
    scopes.every(
      (scope) =>
        typeof scope === "string" &&
        scope.length > 0 &&
        scope.length <= 256 &&
        scope.trim() === scope &&
        !/[\u0000-\u001f\u007f]/u.test(scope) &&
        scope !== "admin",
    ) && new Set(scopes).size === scopes.length
  );
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
  /** @deprecated Stored-row decode compatibility only; grants no authority. */
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
  /** @deprecated Stored-row decode compatibility only; grants no authority. */
  readonly managedProviderProfile?: string;
  /**
   * Public hostname namespace owned by this deployment target. A hosted operator
   * may use a different namespace per environment without rewriting repository
   * install metadata (for example an operator-managed staging namespace).
   */
  readonly managedPublicBaseDomain?: string;
}

/** Detects decoder-only fields so every new write can reject them explicitly. */
export function hasLegacyManagedProviderScopeHints(
  value: ConnectionScopeHints | undefined,
): boolean {
  return (
    value?.managedProvider !== undefined ||
    value?.managedProviderProfile !== undefined
  );
}

/**
 * Closed, provider-neutral admission predicate for operator run credentials.
 * Provider names, profiles, URLs, and legacy scope hints are deliberately not
 * part of this decision.
 */
export function isWorkspaceBindableOperatorConnection(
  connection: Pick<
    ProviderConnection,
    "scope" | "workspaceId" | "status" | "credentialRecipe"
  >,
): boolean {
  return (
    connection.scope === "operator" &&
    connection.workspaceId === undefined &&
    connection.status === "verified" &&
    isCapsuleRunCredentialIssuance(connection.credentialRecipe?.runIssuance)
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
  /** Exact provider source address. */
  readonly provider: string;
  /**
   * Exact child-module local provider name. Older stored bindings may omit it,
   * in which case the generated root falls back to the provider type segment.
   */
  readonly moduleLocalName?: string;
  /** Alias expected by the child module; absent means its default provider. */
  readonly childAlias?: string;
  /** Alias of the generated-root provider block; absent means its default. */
  readonly rootAlias?: string;
  /**
   * @deprecated Pre-v1 ambiguous alias retained only for stored-row
   * compatibility. New writers use `childAlias` and `rootAlias`.
   */
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
