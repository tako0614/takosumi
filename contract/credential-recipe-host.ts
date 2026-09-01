import type {
  ConnectionScopeHints,
  ProviderBinding,
  ProviderConnection,
} from "./connections.ts";
import {
  canonicalRunCredentialSettings,
  isCapsuleRunCredentialIssuance,
} from "./connections.ts";
import type { CredentialRecipe } from "./credential-recipes.ts";
import { canonicalProviderSource, sameProviderSource } from "./provider-env-rules.ts";
import type { ProviderCredentialMintEvidence } from "./security.ts";
import type { MintedFile } from "./sources.ts";

export type CredentialDriverFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Canonical non-secret Run authority delivered to a trusted recipe driver. */
export interface CredentialRecipeDriverRunContext {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly installingPrincipalId: string;
  readonly phase: "plan" | "apply" | "destroy";
  /** Canonical lifecycle intent re-read from the Run ledger. */
  readonly lifecycleIntent: "provision" | "destroy";
}

/** The only token property a trusted recipe driver may select. */
export interface CredentialRecipeRunCredentialRequest {
  readonly ttlSeconds?: number;
}

export interface CredentialRecipeIssuedRunCredential {
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

/**
 * Closed, non-secret semantic output from trusted host code.
 *
 * This is deliberately not an arbitrary variable or environment map. Core may
 * consume the URL only through an accepted InstallConfig
 * `public_endpoint.variables.url` projection.
 */
export interface CredentialRecipeDriverPublicInputs {
  readonly httpEndpointUrl: string;
  /** Opaque provider-owned reservation identity; Core never interprets it. */
  readonly reservationRef: string;
}

/** Exact semantic request Core may present to a trusted recipe driver. */
export interface CredentialRecipeDriverPublicInputRequest {
  readonly httpEndpointUrl: {
    /**
     * Non-secret idempotency identity derived from immutable Capsule lifecycle
     * coordinates. It contains no Workspace, account, session, or Run identity.
     */
    readonly clientIdempotencyKey: string;
    /**
     * Exact Plan-known semantic compiled from
     * `http.endpoint deliver.variables.subdomain`. Provider drivers may use
     * it as the requested public label, but Core never supplies provider
     * resource names such as Worker or endpoint identifiers.
     */
    readonly requestedSubdomain: string;
    /** Present on re-read/release; allocated and owned only by the provider. */
    readonly reservationRef?: string;
  };
}

export const CREDENTIAL_RECIPE_HTTP_ENDPOINT_PUBLIC_INPUT_CAPABILITY =
  "http_endpoint_url" as const;

export type CredentialRecipeDriverPublicInputCapability =
  typeof CREDENTIAL_RECIPE_HTTP_ENDPOINT_PUBLIC_INPUT_CAPABILITY;

/** Exact trusted owner pinned privately with the provider reservation. */
export interface CredentialRecipeDriverPublicInputOwner {
  readonly providerSource: string;
  readonly connectionId: string;
  readonly recipeId: string;
  readonly authMode: string;
  /** Bounded non-secret binding settings required to replay the same driver. */
  readonly runCredentialSettings?: ProviderBinding["runCredentialSettings"];
}

export interface CredentialRecipeDriverPublicInputReleaseResult {
  readonly status: "released" | "already_absent";
  readonly reservationRef: string;
}

/** Runtime validator for the one closed reservation request shape. */
export function assertCredentialRecipeDriverPublicInputRequest(
  value: unknown,
  options: { readonly requireReservationRef?: boolean } = {},
): CredentialRecipeDriverPublicInputRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Credential Recipe public input request must be an object");
  }
  exactKeys(value, ["httpEndpointUrl"], "Credential Recipe public input request");
  const endpoint = (value as { readonly httpEndpointUrl?: unknown })
    .httpEndpointUrl;
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw new TypeError(
      "Credential Recipe public input request.httpEndpointUrl must be an object",
    );
  }
  exactKeys(
    endpoint,
    ["clientIdempotencyKey", "requestedSubdomain", "reservationRef"],
    "Credential Recipe public input request.httpEndpointUrl",
  );
  const request = endpoint as {
    readonly clientIdempotencyKey?: unknown;
    readonly requestedSubdomain?: unknown;
    readonly reservationRef?: unknown;
  };
  if (
    typeof request.clientIdempotencyKey !== "string" ||
    !/^endpoint_request_[a-f0-9]{64}$/u.test(request.clientIdempotencyKey)
  ) {
    throw new TypeError(
      "Credential Recipe public input clientIdempotencyKey is invalid",
    );
  }
  if (!isBoundedRequestedSubdomain(request.requestedSubdomain)) {
    throw new TypeError(
      "Credential Recipe public input requestedSubdomain is invalid",
    );
  }
  if (
    request.reservationRef !== undefined &&
    !isBoundedOpaqueReservationRef(request.reservationRef)
  ) {
    throw new TypeError(
      "Credential Recipe public input reservationRef is invalid",
    );
  }
  if (options.requireReservationRef && request.reservationRef === undefined) {
    throw new TypeError(
      "Credential Recipe public input reservationRef is required",
    );
  }
  return Object.freeze({
    httpEndpointUrl: Object.freeze({
      clientIdempotencyKey: request.clientIdempotencyKey,
      requestedSubdomain: request.requestedSubdomain,
      ...(request.reservationRef !== undefined
        ? { reservationRef: request.reservationRef }
        : {}),
    }),
  });
}

export type CredentialRecipeIssueRunCredential = (
  request: CredentialRecipeRunCredentialRequest,
) => Promise<CredentialRecipeIssuedRunCredential>;

interface CredentialRecipeDriverBaseContext {
  readonly connection: ProviderConnection;
  /** Canonical non-secret parameters from this exact ProviderBinding. */
  readonly runCredentialSettings?: ProviderBinding["runCredentialSettings"];
  readonly values: Readonly<Record<string, string>>;
  readonly files: readonly MintedFile[];
  readonly fetch: CredentialDriverFetch;
  readonly now: () => Date;
  readonly staticEvidence: () => ProviderCredentialMintEvidence;
}

/**
 * Separate non-secret reservation lane. It intentionally has no canonical Run
 * identity or credential issuer and therefore cannot receive account/session
 * identity or mint runner credentials.
 */
export interface CredentialRecipeDriverPublicInputContext
{
  /** Trusted host scope only; the driver must not forward it to provider RPC. */
  readonly workspaceId: string;
  readonly connection: ProviderConnection;
  /** Canonical bounded non-secret parameters from this exact binding. */
  readonly runCredentialSettings?: ProviderBinding["runCredentialSettings"];
  readonly values: Readonly<Record<string, string>>;
  readonly files: readonly MintedFile[];
  readonly fetch: CredentialDriverFetch;
  readonly now: () => Date;
  readonly publicInputRequest: CredentialRecipeDriverPublicInputRequest;
}

/**
 * Only a canonical Run context carries an issuer capability. Identity claims
 * and signing material are never part of this public driver surface.
 */
export type CredentialRecipeDriverContext =
  | (CredentialRecipeDriverBaseContext & {
      readonly run?: undefined;
      readonly issueRunCredential?: undefined;
    })
  | (CredentialRecipeDriverBaseContext & {
      readonly run: CredentialRecipeDriverRunContext;
      readonly issueRunCredential: CredentialRecipeIssueRunCredential;
    });

export interface CredentialRecipeDriverMintResult {
  readonly env: Readonly<Record<string, string>>;
  readonly files?: readonly MintedFile[];
  readonly evidence: ProviderCredentialMintEvidence;
}

/** Runtime validator for the closed trusted-driver semantic output. */
export function assertCredentialRecipeDriverPublicInputs(
  value: unknown,
): CredentialRecipeDriverPublicInputs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Credential Recipe publicInputs must be an object");
  }
  exactKeys(
    value,
    ["httpEndpointUrl", "reservationRef"],
    "Credential Recipe publicInputs",
  );
  const httpEndpointUrl = (
    value as { readonly httpEndpointUrl?: unknown }
  ).httpEndpointUrl;
  const reservationRef = (
    value as { readonly reservationRef?: unknown }
  ).reservationRef;
  if (typeof httpEndpointUrl !== "string") {
    throw new TypeError(
      "Credential Recipe publicInputs.httpEndpointUrl must be an exact HTTPS origin",
    );
  }
  let url: URL;
  try {
    url = new URL(httpEndpointUrl);
  } catch {
    throw new TypeError(
      "Credential Recipe publicInputs.httpEndpointUrl must be an exact HTTPS origin",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== httpEndpointUrl ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Credential Recipe publicInputs.httpEndpointUrl must be an exact HTTPS origin",
    );
  }
  if (!isBoundedOpaqueReservationRef(reservationRef)) {
    throw new TypeError(
      "Credential Recipe publicInputs.reservationRef must be a bounded opaque reference",
    );
  }
  return Object.freeze({ httpEndpointUrl, reservationRef });
}

function isBoundedOpaqueReservationRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 1_024 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isBoundedRequestedSubdomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  );
}

export function assertCredentialRecipeDriverPublicInputReleaseResult(
  value: unknown,
  expectedReservationRef: string,
): CredentialRecipeDriverPublicInputReleaseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Credential Recipe public input release must be an object");
  }
  exactKeys(
    value,
    ["reservationRef", "status"],
    "Credential Recipe public input release",
  );
  const result = value as {
    readonly status?: unknown;
    readonly reservationRef?: unknown;
  };
  if (
    (result.status !== "released" && result.status !== "already_absent") ||
    result.reservationRef !== expectedReservationRef
  ) {
    throw new TypeError(
      "Credential Recipe public input release must confirm the exact reservation",
    );
  }
  return Object.freeze({
    status: result.status,
    reservationRef: expectedReservationRef,
  });
}

/**
 * Non-secret scope metadata learned from a successful trusted verification.
 * Core treats these keys as opaque JSON and re-validates their bounded shape
 * before persisting them on the Provider Connection.
 */
export type CredentialRecipeVerifiedScopeHints = Pick<
  ConnectionScopeHints,
  "moduleInputDefaults" | "providerSettings"
>;

/**
 * Trusted ownership declaration for metadata returned by a verifier. A driver
 * may only return keys it declares here; Vault uses the same closed declaration
 * to clear verifier-owned keys when a later re-test fails.
 */
export interface CredentialRecipeVerifiedScopeHintKeys {
  readonly moduleInputDefaults?: readonly string[];
  readonly providerSettings?: readonly string[];
}

export interface CredentialRecipeDriverVerifyResult {
  readonly ok: boolean;
  readonly detail?: string;
  /** Persisted only when `ok` is true and Core accepts the bounded shape. */
  readonly verifiedScopeHints?: CredentialRecipeVerifiedScopeHints;
}

export interface CredentialRecipeRuntimeDriver {
  /** Host-pinned bounded label persisted in provider credential evidence. */
  readonly evidenceIssuer: string;
  /** Optional host-composed verifier identity for successful verification. */
  readonly verifierId?: string;
  /**
   * Host-owned capability claims persisted only after this verifier succeeds.
   * Runtime verification results cannot add or widen these claims.
   */
  readonly verificationCapabilities?: readonly string[];
  /** Closed key ownership for verifier-produced non-secret scope hints. */
  readonly verifiedScopeHintKeys?: CredentialRecipeVerifiedScopeHintKeys;
  /** Explicit opt-in; owner selection ignores every driver without it. */
  readonly publicInputCapabilities?: readonly CredentialRecipeDriverPublicInputCapability[];
  resolvePublicInputs?(
    input: CredentialRecipeDriverPublicInputContext,
  ): Promise<CredentialRecipeDriverPublicInputs>;
  releasePublicInputs?(
    input: CredentialRecipeDriverPublicInputContext,
  ): Promise<CredentialRecipeDriverPublicInputReleaseResult>;
  verify?(
    input: CredentialRecipeDriverContext,
  ): Promise<CredentialRecipeDriverVerifyResult>;
  mint?(
    input: CredentialRecipeDriverContext,
  ): Promise<CredentialRecipeDriverMintResult>;
}

export type CredentialRecipeDriverRegistry = Readonly<
  Record<string, CredentialRecipeRuntimeDriver>
>;

/**
 * Fixed operator Provider Connection declared by a trusted host composition.
 * Runtime fields are derived from the installed Credential Recipe and driver;
 * this declaration carries no credential or execution authority.
 */
export interface FixedOperatorProviderConnectionDeclaration {
  readonly id: string;
  readonly providerSource: string;
  readonly displayName?: string;
  /** Bounded non-secret settings copied to every binding of this connection. */
  readonly runCredentialSettings?: ProviderBinding["runCredentialSettings"];
  readonly credentialRecipe: {
    readonly id: string;
    readonly authMode: string;
  };
}

/** Descriptive alias for callers that do not use the fixed-id terminology. */
export type OperatorProviderConnectionDeclaration =
  FixedOperatorProviderConnectionDeclaration;

/** Trusted code-only recipe + driver contribution installed by a host. */
export interface CredentialRecipeHostComposition {
  readonly credentialRecipes: readonly CredentialRecipe[];
  readonly credentialRecipeDrivers: CredentialRecipeDriverRegistry;
  /**
   * Explicit host authority for providers that require a ProviderConnection
   * in the generic default Capsule policy. Recipe and connection presence do
   * not imply this requirement; every entry is an exact canonical source.
   */
  readonly credentialRequiredProviderSources?: readonly string[];
  readonly operatorProviderConnections?: readonly FixedOperatorProviderConnectionDeclaration[];
}

export function credentialRecipeDriverKey(recipe: {
  readonly id: string;
  readonly authMode: string;
}): string {
  return `${recipe.id}/${recipe.authMode}`;
}

/**
 * Pure additive composition validation. Recipe ids and exact recipe/mode
 * driver keys have one owner; run-issued modes require the closed descriptor,
 * a preRun action, and both verify and mint methods.
 */
export function resolveCredentialRecipeHostComposition(
  contribution: CredentialRecipeHostComposition | undefined,
  base: CredentialRecipeHostComposition,
): CredentialRecipeHostComposition {
  if (contribution !== undefined) {
    if (
      typeof contribution !== "object" ||
      contribution === null ||
      Array.isArray(contribution) ||
      !Array.isArray(contribution.credentialRecipes) ||
      !isCredentialRecipeDriverRegistry(
        contribution.credentialRecipeDrivers,
      ) ||
      (contribution.credentialRequiredProviderSources !== undefined &&
        !Array.isArray(contribution.credentialRequiredProviderSources)) ||
      (contribution.operatorProviderConnections !== undefined &&
        !Array.isArray(contribution.operatorProviderConnections))
    ) {
      throw new TypeError(
        "Credential Recipe host contribution must be a code-only recipe and driver object",
      );
    }
  }
  if (
    !Array.isArray(base.credentialRecipes) ||
    !isCredentialRecipeDriverRegistry(base.credentialRecipeDrivers) ||
    (base.credentialRequiredProviderSources !== undefined &&
      !Array.isArray(base.credentialRequiredProviderSources)) ||
    (base.operatorProviderConnections !== undefined &&
      !Array.isArray(base.operatorProviderConnections))
  ) {
    throw new TypeError("base Credential Recipe composition is invalid");
  }

  const credentialRequiredProviderSources = sortedCredentialProviderSources(
    validateCredentialRequiredProviderSources(
      base.credentialRequiredProviderSources,
      "base Credential Recipe composition",
    ),
    validateCredentialRequiredProviderSources(
      contribution?.credentialRequiredProviderSources,
      "Credential Recipe host contribution",
    ),
  );

  const recipes = [
    ...base.credentialRecipes,
    ...(contribution?.credentialRecipes ?? []),
  ];
  const recipeOwners = new Set<string>();
  for (const recipe of recipes) {
    if (!isCredentialRecipe(recipe) || recipeOwners.has(recipe.id)) {
      throw new TypeError(
        `Credential Recipe id ${credentialRecipeId(recipe)} must have one host owner`,
      );
    }
    recipeOwners.add(recipe.id);
  }

  const drivers: Record<
    string,
    CredentialRecipeDriverRegistry[string]
  > = { ...base.credentialRecipeDrivers };
  for (const [key, driver] of Object.entries(
    contribution?.credentialRecipeDrivers ?? {},
  )) {
    if (Object.prototype.hasOwnProperty.call(drivers, key)) {
      throw new TypeError(
        `Credential Recipe driver ${key} must have one host owner`,
      );
    }
    drivers[key] = driver;
  }

  for (const [key, driver] of Object.entries(drivers)) {
    if (!isBoundedControlFreeText(driver.evidenceIssuer)) {
      throw new TypeError(
        `Credential Recipe driver ${key} requires a bounded control-free evidenceIssuer`,
      );
    }
    if (!hasValidCredentialVerificationDescriptor(driver)) {
      throw new TypeError(
        `Credential Recipe driver ${key} has an invalid credential verification descriptor`,
      );
    }
    if (!hasValidPublicInputDescriptor(driver)) {
      throw new TypeError(
        `Credential Recipe driver ${key} has an invalid public input descriptor`,
      );
    }
  }

  for (const recipe of recipes) {
    for (const [authMode, mode] of Object.entries(recipe.authModes) as Array<
      [string, CredentialRecipe["authModes"][string]]
    >) {
      if (mode.runIssuance === undefined) continue;
      const key = credentialRecipeDriverKey({ id: recipe.id, authMode });
      const driver = drivers[key];
      if (
        !isCapsuleRunCredentialIssuance(mode.runIssuance) ||
        typeof mode.preRun?.type !== "string" ||
        !mode.preRun.type.trim() ||
        typeof driver?.verify !== "function" ||
        typeof driver.mint !== "function"
      ) {
        throw new TypeError(
          `run-issued Credential Recipe ${key} requires the exact descriptor, preRun action, and verify plus mint driver`,
        );
      }
    }
  }

  const operatorProviderConnections = [
    ...(base.operatorProviderConnections ?? []),
    ...(contribution?.operatorProviderConnections ?? []),
  ];
  const operatorConnectionIds = new Set<string>();
  for (const declaration of operatorProviderConnections) {
    validateFixedOperatorProviderConnectionDeclaration(
      declaration,
      recipes,
      drivers,
      operatorConnectionIds,
    );
  }

  return Object.freeze({
    credentialRecipes: Object.freeze([...recipes]),
    credentialRecipeDrivers: Object.freeze({ ...drivers }),
    ...(credentialRequiredProviderSources.length > 0
      ? {
          credentialRequiredProviderSources: Object.freeze(
            credentialRequiredProviderSources,
          ),
        }
      : {}),
    operatorProviderConnections: Object.freeze([
      ...operatorProviderConnections,
    ]),
  });
}

const CANONICAL_PROVIDER_SOURCE_PATTERN =
  /^[a-z0-9.-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/u;

function validateCredentialRequiredProviderSources(
  value: unknown,
  label: string,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${label}.credentialRequiredProviderSources must be an array`,
    );
  }
  for (const source of value) {
    if (
      typeof source !== "string" ||
      !CANONICAL_PROVIDER_SOURCE_PATTERN.test(source) ||
      canonicalProviderSource(source) !== source
    ) {
      throw new TypeError(
        `${label}.credentialRequiredProviderSources must contain exact canonical provider sources`,
      );
    }
  }
  return value;
}

function sortedCredentialProviderSources(
  ...sourceLists: readonly (readonly string[])[]
): string[] {
  return Array.from(new Set(sourceLists.flat())).sort();
}

/** Validate one fixed-id declaration against the resolved host composition. */
export function validateFixedOperatorProviderConnectionDeclaration(
  declaration: FixedOperatorProviderConnectionDeclaration,
  recipes: readonly CredentialRecipe[],
  drivers: CredentialRecipeDriverRegistry,
  seenIds: Set<string> = new Set(),
): void {
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  ) {
    throw new TypeError("operator Provider Connection declaration must be an object");
  }
  exactKeys(
    declaration,
    [
      "id",
      "providerSource",
      "displayName",
      "runCredentialSettings",
      "credentialRecipe",
    ],
    "operator Provider Connection declaration",
  );
  try {
    canonicalRunCredentialSettings(
      declaration.runCredentialSettings,
      "operator Provider Connection declaration runCredentialSettings",
    );
  } catch {
    throw new TypeError(
      "operator Provider Connection declaration runCredentialSettings is invalid",
    );
  }
  if (!/^conn_[0-9A-Za-z]{8,64}$/u.test(declaration.id)) {
    throw new TypeError(
      "operator Provider Connection declaration id must be a canonical conn_ id",
    );
  }
  if (seenIds.has(declaration.id)) {
    throw new TypeError(
      `operator Provider Connection declaration id ${declaration.id} must be unique`,
    );
  }
  seenIds.add(declaration.id);
  if (
    typeof declaration.providerSource !== "string" ||
    canonicalProviderSource(declaration.providerSource) !==
      declaration.providerSource
  ) {
    throw new TypeError(
      "operator Provider Connection declaration providerSource must be canonical",
    );
  }
  if (declaration.displayName !== undefined) {
    if (!isBoundedControlFreeText(declaration.displayName)) {
      throw new TypeError(
        "operator Provider Connection declaration displayName is invalid",
      );
    }
  }
  if (
    !declaration.credentialRecipe ||
    typeof declaration.credentialRecipe !== "object" ||
    Array.isArray(declaration.credentialRecipe)
  ) {
    throw new TypeError(
      "operator Provider Connection declaration credentialRecipe is invalid",
    );
  }
  exactKeys(
    declaration.credentialRecipe,
    ["id", "authMode"],
    "operator Provider Connection declaration credentialRecipe",
  );
  if (
    !isBoundedToken(declaration.credentialRecipe.id) ||
    !isBoundedToken(declaration.credentialRecipe.authMode)
  ) {
    throw new TypeError(
      "operator Provider Connection declaration credentialRecipe values are invalid",
    );
  }
  const recipe = recipes.find(
    (candidate) => candidate.id === declaration.credentialRecipe.id,
  );
  const mode = recipe?.authModes[declaration.credentialRecipe.authMode];
  const driver = drivers[
    credentialRecipeDriverKey(declaration.credentialRecipe)
  ];
  if (!recipe || !mode || !isCapsuleRunCredentialIssuance(mode.runIssuance)) {
    throw new TypeError(
      `operator Provider Connection declaration ${declaration.id} requires an installed run-issued Credential Recipe`,
    );
  }
  if (
    recipe.terraformSource !== "*" &&
    !recipe.terraformSource.some((source) =>
      sameProviderSource(source, declaration.providerSource),
    )
  ) {
    throw new TypeError(
      `operator Provider Connection declaration ${declaration.id} providerSource is not declared by its recipe`,
    );
  }
  if (
    !mode.preRun ||
    typeof mode.preRun.type !== "string" ||
    !mode.preRun.type.trim() ||
    typeof driver?.verify !== "function" ||
    typeof driver.mint !== "function"
  ) {
    throw new TypeError(
      `operator Provider Connection declaration ${declaration.id} requires preRun plus verify and mint driver methods`,
    );
  }
}

function isCredentialRecipe(value: unknown): value is CredentialRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recipe = value as Partial<CredentialRecipe>;
  return (
    typeof recipe.id === "string" &&
    recipe.id.trim().length > 0 &&
    typeof recipe.displayName === "string" &&
    recipe.displayName.trim().length > 0 &&
    recipe.authModes !== null &&
    typeof recipe.authModes === "object" &&
    !Array.isArray(recipe.authModes)
  );
}

function credentialRecipeId(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as { readonly id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id;
  }
  return "(invalid)";
}

function isCredentialRecipeDriverRegistry(
  value: unknown,
): value is CredentialRecipeDriverRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([key, driver]) =>
      key.trim().length > 0 &&
      Boolean(driver) &&
      typeof driver === "object" &&
      !Array.isArray(driver) &&
      typeof (driver as { readonly evidenceIssuer?: unknown }).evidenceIssuer ===
        "string" &&
      ((driver as { readonly verify?: unknown }).verify === undefined ||
        typeof (driver as { readonly verify?: unknown }).verify ===
          "function") &&
      ((driver as { readonly mint?: unknown }).mint === undefined ||
        typeof (driver as { readonly mint?: unknown }).mint === "function") &&
      ((driver as { readonly resolvePublicInputs?: unknown })
          .resolvePublicInputs === undefined ||
        typeof (driver as { readonly resolvePublicInputs?: unknown })
            .resolvePublicInputs === "function") &&
      ((driver as { readonly releasePublicInputs?: unknown })
          .releasePublicInputs === undefined ||
        typeof (driver as { readonly releasePublicInputs?: unknown })
            .releasePublicInputs === "function"),
  );
}

function hasValidPublicInputDescriptor(
  driver: CredentialRecipeRuntimeDriver,
): boolean {
  const capabilities = driver.publicInputCapabilities;
  const hasResolve = typeof driver.resolvePublicInputs === "function";
  const hasRelease = typeof driver.releasePublicInputs === "function";
  if (capabilities === undefined) return !hasResolve && !hasRelease;
  return (
    Array.isArray(capabilities) &&
    capabilities.length === 1 &&
    capabilities[0] ===
      CREDENTIAL_RECIPE_HTTP_ENDPOINT_PUBLIC_INPUT_CAPABILITY &&
    hasResolve &&
    hasRelease
  );
}

function isBoundedControlFreeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  );
}

function hasValidCredentialVerificationDescriptor(
  driver: CredentialRecipeRuntimeDriver,
): boolean {
  const verifierId = driver.verifierId;
  const capabilities = driver.verificationCapabilities;
  const declaresVerificationAuthority =
    verifierId !== undefined ||
    capabilities !== undefined ||
    driver.verifiedScopeHintKeys !== undefined;
  if (declaresVerificationAuthority && typeof driver.verify !== "function") {
    return false;
  }
  if (
    verifierId !== undefined &&
    !/^[a-z0-9][a-z0-9._/@-]{0,127}$/u.test(verifierId)
  ) {
    return false;
  }
  if (capabilities === undefined) return true;
  return (
    verifierId !== undefined &&
    Array.isArray(capabilities) &&
    capabilities.length > 0 &&
    capabilities.length <= 64 &&
    capabilities.every(
      (capability) =>
        typeof capability === "string" &&
        /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(capability),
    )
  );
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}
