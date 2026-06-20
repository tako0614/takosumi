/**
 * Generic-env provider connection driver (registration-side validation).
 *
 * A generic-env provider Connection (`kind: "generic_env_provider"`) is a
 * Space-owned carrier of write-only provider env values. It is allowed only for
 * providers that have an explicit `provider-env-rules` entry; each submitted
 * env name must be in that provider allowlist, be a valid uppercase
 * environment-variable identifier, and carry a string value. The connection is
 * always Space-scoped (never operator-scoped).
 *
 * This is the extracted, self-contained form of the structural validation in
 * the vault's `#registerGenericEnvProvider`. The crypto / sealing / store
 * writes stay in core (the vault seals and persists); this driver answers the
 * pure "is this a valid generic-env provider registration?" question so the
 * registry can own the generic-provider rules in one place.
 *
 * Behavior is byte-identical to the in-vault path: the same precondition checks,
 * the same uppercase-identifier regex, and the same sorted env-name projection.
 */
import type { CreateConnectionRequest } from "takosumi-contract/connections";
import {
  allowedEnvNamesForProvider,
  providerEnvRule,
} from "takosumi-contract/provider-env-rules";

/** Uppercase environment-variable identifier rule (`FOO`, `FOO_BAR`, `_BAR`). */
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Validation error for a generic-env provider registration. The `code` mirrors
 * the deploy-control error codes the vault raises so the caller can translate
 * it identically to the in-vault `ConnectionVaultError`.
 */
export class GenericEnvProviderConnectionError extends Error {
  readonly code: "invalid_argument" | "failed_precondition";

  constructor(
    code: GenericEnvProviderConnectionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GenericEnvProviderConnectionError";
    this.code = code;
  }
}

/** The validated, normalized result of a generic-env registration check. */
export interface GenericEnvProviderRegistration {
  /** Owning Space id (always present — generic-env provider credentials are Space-scoped). */
  readonly spaceId: string;
  /** Declared variable values, untouched (sealed by the core crypto path). */
  readonly values: Readonly<Record<string, string>>;
  /** Sorted variable names, the `Connection.envNames` projection. */
  readonly envNames: readonly string[];
}

/**
 * Validate a generic-env provider registration request and project its env names.
 *
 * Enforces the same structural rules as the in-vault generic-env provider path:
 *   - Space-scoped only (a present spaceId and a non-`operator` scope).
 *   - `values` is a plain object with at least one entry.
 *   - every name matches the uppercase env-var identifier rule.
 *   - every value is a string.
 *
 * The crypto / sealing / store writes are NOT done here — the core vault owns
 * those. This returns the data core needs to seal and persist the connection.
 */
export function validateGenericEnvProviderRegistration(
  input: CreateConnectionRequest,
): GenericEnvProviderRegistration {
  if (!providerEnvRule(input.provider)) {
    throw new GenericEnvProviderConnectionError(
      "failed_precondition",
      `generic-env provider ${input.provider} has no explicit env allowlist`,
    );
  }
  if (!input.spaceId || input.scope === "operator") {
    throw new GenericEnvProviderConnectionError(
      "failed_precondition",
      "generic-env provider connections must be Space-scoped",
    );
  }
  const values = input.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new GenericEnvProviderConnectionError(
      "invalid_argument",
      "values must be an object of { variableName: value }",
    );
  }
  const envNames = Object.keys(values);
  if (envNames.length === 0) {
    throw new GenericEnvProviderConnectionError(
      "invalid_argument",
      "values must supply at least one provider env name",
    );
  }
  const allowed = new Set(allowedEnvNamesForProvider(input.provider));
  for (const name of envNames) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `env name ${name} must be an uppercase environment variable name`,
      );
    }
    if (!allowed.has(name)) {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `env name ${name} is not allowed for provider ${input.provider}`,
      );
    }
    if (typeof values[name] !== "string") {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `value for ${name} must be a string`,
      );
    }
  }
  return {
    spaceId: input.spaceId,
    values,
    envNames: [...envNames].sort(),
  };
}
