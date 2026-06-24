/**
 * Generic-env provider connection driver (registration-side validation).
 *
 * A generic-env provider Connection (`kind: "generic_env_provider"`) is a
 * Space-owned carrier of write-only provider env values and credential files.
 * The submitted env names themselves become the explicit per-Connection
 * Credential Recipe, regardless of whether Takosumi also has a guided recipe
 * for that provider. Every env name must be a valid uppercase
 * environment-variable identifier, every value/file content must be a string,
 * and runner/runtime-reserved names are rejected.
 * The connection is always Space-scoped (never operator-scoped).
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
import type {
  CreateConnectionFile,
  CreateConnectionRequest,
} from "takosumi-contract/connections";
import {
  isProviderEnvName,
  isReservedProviderEnvName,
} from "takosumi-contract/provider-env-rules";

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
  /** Declared provider credential files, untouched (sealed by the core crypto path). */
  readonly files: readonly GenericEnvProviderFile[];
  /** Sorted variable names, the `Connection.envNames` projection. */
  readonly envNames: readonly string[];
  /** Sorted env names that receive materialized file paths at run time. */
  readonly fileEnvNames: readonly string[];
}

export interface GenericEnvProviderFile {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  readonly envName?: string;
}

/**
 * Validate a generic-env provider registration request and project its env names.
 *
 * Enforces the same structural rules as the in-vault generic-env provider path:
 *   - Space-scoped only (a present spaceId and a non-`operator` scope).
 *   - `values` is a plain object, and values or files supply at least one
 *     credential.
 *   - every name matches the uppercase env-var identifier rule.
 *   - every value is a string.
 *   - each credential file uses a basename path and safe file mode.
 *
 * The crypto / sealing / store writes are NOT done here — the core vault owns
 * those. This returns the data core needs to seal and persist the connection.
 */
export function validateGenericEnvProviderRegistration(
  input: CreateConnectionRequest,
): GenericEnvProviderRegistration {
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
  const files = validateGenericEnvProviderFiles(input.files ?? []);
  if (envNames.length === 0 && files.length === 0) {
    throw new GenericEnvProviderConnectionError(
      "invalid_argument",
      "values or files must supply at least one provider credential",
    );
  }
  for (const name of envNames) {
    if (!isProviderEnvName(name)) {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `env name ${name} must be an uppercase environment variable name`,
      );
    }
    if (isReservedProviderEnvName(name)) {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `env name ${name} is reserved for the runner runtime`,
      );
    }
    if (typeof values[name] !== "string") {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `value for ${name} must be a string`,
      );
    }
  }
  const fileEnvNames = files
    .map((file) => file.envName)
    .filter((envName): envName is string => typeof envName === "string")
    .sort();
  for (const envName of fileEnvNames) {
    if (envNames.includes(envName)) {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `env name ${envName} cannot be supplied both as a value and a credential file path`,
      );
    }
  }
  return {
    spaceId: input.spaceId,
    values,
    files,
    envNames: [...envNames, ...fileEnvNames].sort(),
    fileEnvNames,
  };
}

function validateGenericEnvProviderFiles(
  files: readonly CreateConnectionFile[],
): readonly GenericEnvProviderFile[] {
  if (!Array.isArray(files)) {
    throw new GenericEnvProviderConnectionError(
      "invalid_argument",
      "files must be an array of provider credential file definitions",
    );
  }
  return files.map((file) => {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        "credential file must be an object",
      );
    }
    if (!isSafeCredentialFileName(file.path)) {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `credential file path ${String(file.path)} is unsafe`,
      );
    }
    if (typeof file.content !== "string") {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `credential file ${file.path} content must be a string`,
      );
    }
    const mode = file.mode ?? 0o600;
    if (!isSafeCredentialFileMode(mode)) {
      throw new GenericEnvProviderConnectionError(
        "invalid_argument",
        `credential file ${file.path} mode is unsafe`,
      );
    }
    const envName = file.envName;
    if (envName !== undefined) {
      if (!isProviderEnvName(envName)) {
        throw new GenericEnvProviderConnectionError(
          "invalid_argument",
          `file env name ${envName} must be an uppercase environment variable name`,
        );
      }
      if (isReservedProviderEnvName(envName)) {
        throw new GenericEnvProviderConnectionError(
          "invalid_argument",
          `file env name ${envName} is reserved for the runner runtime`,
        );
      }
    }
    return {
      path: file.path,
      content: file.content,
      mode,
      ...(envName ? { envName } : {}),
    };
  });
}

function isSafeCredentialFileName(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path !== "." &&
    path !== ".."
  );
}

function isSafeCredentialFileMode(mode: unknown): mode is number {
  return (
    Number.isInteger(mode) &&
    typeof mode === "number" &&
    mode >= 0o400 &&
    mode <= 0o700 &&
    (mode & 0o077) === 0
  );
}
