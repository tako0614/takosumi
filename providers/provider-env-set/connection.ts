/**
 * Provider Env Set connection driver (registration-side validation).
 *
 * A Provider Env Set Connection (`kind: "provider_env_set"`) is a Space-owned
 * carrier of write-only provider env values for any OpenTofu provider that is
 * not a Takosumi-provided managed default. Its registration shape has no
 * per-provider env-name allowlist (unlike a managed provider with an
 * `provider-env-rules` entry): the only constraint is that each variable name is
 * a valid uppercase environment-variable identifier and each value is a string,
 * and that the env set is Space-scoped (never operator-scoped).
 *
 * This is the extracted, self-contained form of the structural validation in
 * the vault's `#registerGenericProviderEnvSet`. The crypto / sealing / store
 * writes stay in core (the vault seals and persists); this driver answers the
 * pure "is this a valid Provider Env Set registration?" question so the registry
 * can own the generic-provider rules in one place.
 *
 * Behavior is byte-identical to the in-vault path: the same precondition checks,
 * the same uppercase-identifier regex, and the same sorted env-name projection.
 */
import type { CreateConnectionRequest } from "takosumi-contract/connections";

/** Uppercase environment-variable identifier rule (`FOO`, `FOO_BAR`, `_BAR`). */
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Validation error for a Provider Env Set registration. The `code` mirrors the
 * deploy-control error codes the vault raises so the caller can translate it
 * identically to the in-vault `ConnectionVaultError`.
 */
export class ProviderEnvSetConnectionError extends Error {
  readonly code: "invalid_argument" | "failed_precondition";

  constructor(
    code: ProviderEnvSetConnectionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProviderEnvSetConnectionError";
    this.code = code;
  }
}

/** The validated, normalized result of a Provider Env Set registration check. */
export interface ProviderEnvSetRegistration {
  /** Owning Space id (always present — env sets are Space-scoped). */
  readonly spaceId: string;
  /** Declared variable values, untouched (sealed by the core crypto path). */
  readonly values: Readonly<Record<string, string>>;
  /** Sorted variable names, the `Connection.envNames` projection. */
  readonly envNames: readonly string[];
}

/**
 * Validate a Provider Env Set registration request and project its env names.
 *
 * Enforces the same structural rules as the in-vault generic env-set path:
 *   - Space-scoped only (a present spaceId and a non-`operator` scope).
 *   - `values` is a plain object with at least one entry.
 *   - every name matches the uppercase env-var identifier rule.
 *   - every value is a string.
 *
 * The crypto / sealing / store writes are NOT done here — the core vault owns
 * those. This returns the data core needs to seal and persist the connection.
 */
export function validateProviderEnvSetRegistration(
  input: CreateConnectionRequest,
): ProviderEnvSetRegistration {
  if (!input.spaceId || input.scope === "operator") {
    throw new ProviderEnvSetConnectionError(
      "failed_precondition",
      "user provider env sets for unknown providers must be Space-scoped",
    );
  }
  const values = input.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new ProviderEnvSetConnectionError(
      "invalid_argument",
      "values must be an object of { variableName: value }",
    );
  }
  const envNames = Object.keys(values);
  if (envNames.length === 0) {
    throw new ProviderEnvSetConnectionError(
      "invalid_argument",
      "values must supply at least one provider env name",
    );
  }
  for (const name of envNames) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new ProviderEnvSetConnectionError(
        "invalid_argument",
        `env name ${name} must be an uppercase environment variable name`,
      );
    }
    if (typeof values[name] !== "string") {
      throw new ProviderEnvSetConnectionError(
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
