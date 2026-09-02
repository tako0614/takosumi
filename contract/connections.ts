import type { JsonValue } from "./types.ts";
import { containsSecretLikeString, isSecretKey } from "./redaction.ts";
import type {
  CredentialRecipeRunIssuance,
  CredentialRecipeRuntimeInputs,
} from "./credential-recipes.ts";
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
  /**
   * Server-resolved run-scoped sensitive input protocol pinned from the
   * installed mode. Value-free: it names only the two provider-block arguments
   * this provider reads, never a value or a value source.
   */
  readonly runtimeInputs?: CredentialRecipeRuntimeInputs;
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
}

/**
 * Host-owned credential verification attestation. Provider drivers may declare
 * a bounded verifier id in their trusted host composition, but a driver result
 * or request cannot write this field directly.
 */
export interface ProviderConnectionCredentialVerification {
  readonly kind: "takosumi.credential-verification@v1";
  /**
   * Canonical host-attested abilities proved by this verification. The array is
   * bounded, sorted, and unique; verifierId remains provenance only.
   */
  readonly capabilities?: readonly string[];
  readonly verifierId: string;
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
   * Current bounded non-secret policy owned by a release-projected run-issued
   * connection. Resolution copies it into each ProviderBinding and pins it in
   * the Plan digest; it never contains credential material.
   */
  readonly runCredentialSettings?: Readonly<Record<string, JsonValue>>;
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
  readonly credentialVerification?: ProviderConnectionCredentialVerification;
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
  /**
   * Canonical non-secret parameters consumed only by the selected run-issued
   * Credential Recipe driver. Credential material is forbidden here.
   */
  readonly runCredentialSettings?: Readonly<Record<string, JsonValue>>;
}

const MAX_RUN_CREDENTIAL_SETTINGS_BYTES = 4_096;
const MAX_RUN_CREDENTIAL_SETTINGS_DEPTH = 6;
const MAX_RUN_CREDENTIAL_SETTINGS_ENTRIES = 64;
const MAX_RUN_CREDENTIAL_SETTING_STRING = 1_024;

/** Validates, sorts, bounds, and freezes non-secret per-binding driver input. */
export function canonicalRunCredentialSettings(
  value: unknown,
  field = "runCredentialSettings",
): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw new Error(`${field} must be a JSON object when provided`);
  }
  const canonical = canonicalRunCredentialObject(value, field, 0);
  if (Object.keys(canonical).length === 0) return undefined;
  if (
    new TextEncoder().encode(JSON.stringify(canonical)).byteLength >
    MAX_RUN_CREDENTIAL_SETTINGS_BYTES
  ) {
    throw new Error(`${field} exceeds ${MAX_RUN_CREDENTIAL_SETTINGS_BYTES} bytes`);
  }
  return canonical;
}

function canonicalRunCredentialObject(
  value: Readonly<Record<string, unknown>>,
  path: string,
  depth: number,
): Readonly<Record<string, JsonValue>> {
  if (depth > MAX_RUN_CREDENTIAL_SETTINGS_DEPTH) {
    throw new Error(`${path} exceeds the maximum nesting depth`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_RUN_CREDENTIAL_SETTINGS_ENTRIES) {
    throw new Error(`${path} has too many entries`);
  }
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`${path}.${key} must be a valid identifier`);
    }
    if (isSecretKey(key)) {
      throw new Error(`${path}.${key} is credential-shaped`);
    }
    result[key] = canonicalRunCredentialValue(
      value[key],
      `${path}.${key}`,
      depth + 1,
    );
  }
  return Object.freeze(result);
}

function canonicalRunCredentialValue(
  value: unknown,
  path: string,
  depth: number,
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite JSON number`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_RUN_CREDENTIAL_SETTING_STRING) {
      throw new Error(
        `${path} exceeds ${MAX_RUN_CREDENTIAL_SETTING_STRING} characters`,
      );
    }
    if (containsSecretLikeString(value)) {
      throw new Error(`${path} contains a secret-like value`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_RUN_CREDENTIAL_SETTINGS_DEPTH) {
      throw new Error(`${path} exceeds the maximum nesting depth`);
    }
    if (value.length > MAX_RUN_CREDENTIAL_SETTINGS_ENTRIES) {
      throw new Error(`${path} has too many entries`);
    }
    return Object.freeze(
      value.map((entry, index) =>
        canonicalRunCredentialValue(entry, `${path}[${index}]`, depth + 1),
      ),
    ) as JsonValue[];
  }
  if (isJsonObject(value)) {
    return canonicalRunCredentialObject(value, path, depth);
  }
  throw new Error(`${path} must be a JSON value`);
}

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
