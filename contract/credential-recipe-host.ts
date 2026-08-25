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
    (base.operatorProviderConnections !== undefined &&
      !Array.isArray(base.operatorProviderConnections))
  ) {
    throw new TypeError("base Credential Recipe composition is invalid");
  }

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
    operatorProviderConnections: Object.freeze([
      ...operatorProviderConnections,
    ]),
  });
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
        typeof (driver as { readonly mint?: unknown }).mint === "function"),
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
