/**
 * Structural validation for any installed Credential Recipe that declares the
 * open `declaredEnv` capability.
 *
 * This belongs to the Vault boundary rather than a reference provider package:
 * a host-defined recipe can opt into the same write-only env/file carrier
 * without selecting a built-in provider id. Provider adapters remain free to
 * supply guided setup and runtime drivers, but they do not own this generic
 * admission rule.
 */
import type {
  CreateConnectionFile,
  CreateConnectionRequest,
} from "takosumi-contract/connections";
import {
  isProviderEnvName,
  isReservedProviderEnvName,
} from "takosumi-contract/provider-env-rules";

export class DeclaredEnvRegistrationError extends Error {
  readonly code: "invalid_argument" | "failed_precondition";

  constructor(
    code: DeclaredEnvRegistrationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "DeclaredEnvRegistrationError";
    this.code = code;
  }
}

export interface DeclaredEnvRegistration {
  readonly workspaceId: string;
  readonly values: Readonly<Record<string, string>>;
  readonly files: readonly DeclaredEnvFile[];
  readonly envNames: readonly string[];
  readonly fileEnvNames: readonly string[];
}

export interface DeclaredEnvFile {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  readonly envName?: string;
}

export function validateDeclaredEnvRegistration(
  input: CreateConnectionRequest,
): DeclaredEnvRegistration {
  const workspaceId = input.workspaceId;
  if (!workspaceId || input.scope === "operator") {
    throw new DeclaredEnvRegistrationError(
      "failed_precondition",
      "declared-env provider connections must be Workspace-scoped",
    );
  }
  const values = input.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new DeclaredEnvRegistrationError(
      "invalid_argument",
      "values must be an object of { variableName: value }",
    );
  }
  const envNames = Object.keys(values);
  const files = validateDeclaredEnvFiles(input.files ?? []);
  if (envNames.length === 0 && files.length === 0) {
    throw new DeclaredEnvRegistrationError(
      "invalid_argument",
      "values or files must supply at least one provider credential",
    );
  }
  for (const name of envNames) {
    if (!isProviderEnvName(name)) {
      throw new DeclaredEnvRegistrationError(
        "invalid_argument",
        `env name ${name} must be an uppercase environment variable name`,
      );
    }
    if (isReservedProviderEnvName(name)) {
      throw new DeclaredEnvRegistrationError(
        "invalid_argument",
        `env name ${name} is reserved for the runner runtime`,
      );
    }
    if (typeof values[name] !== "string") {
      throw new DeclaredEnvRegistrationError(
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
      throw new DeclaredEnvRegistrationError(
        "invalid_argument",
        `env name ${envName} cannot be supplied both as a value and a credential file path`,
      );
    }
  }
  return {
    workspaceId,
    values,
    files,
    envNames: [...envNames, ...fileEnvNames].sort(),
    fileEnvNames,
  };
}

function validateDeclaredEnvFiles(
  files: readonly CreateConnectionFile[],
): readonly DeclaredEnvFile[] {
  if (!Array.isArray(files)) {
    throw new DeclaredEnvRegistrationError(
      "invalid_argument",
      "files must be an array of provider credential file definitions",
    );
  }
  return files.map((file) => {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      throw new DeclaredEnvRegistrationError(
        "invalid_argument",
        "credential file must be an object",
      );
    }
    if (!isSafeCredentialFileName(file.path)) {
      throw new DeclaredEnvRegistrationError(
        "invalid_argument",
        `credential file path ${String(file.path)} is unsafe`,
      );
    }
    if (typeof file.content !== "string") {
      throw new DeclaredEnvRegistrationError(
        "invalid_argument",
        `credential file ${file.path} content must be a string`,
      );
    }
    const mode = file.mode ?? 0o600;
    if (!isSafeCredentialFileMode(mode)) {
      throw new DeclaredEnvRegistrationError(
        "invalid_argument",
        `credential file ${file.path} mode is unsafe`,
      );
    }
    const envName = file.envName;
    if (envName !== undefined) {
      if (!isProviderEnvName(envName)) {
        throw new DeclaredEnvRegistrationError(
          "invalid_argument",
          `file env name ${envName} must be an uppercase environment variable name`,
        );
      }
      if (isReservedProviderEnvName(envName)) {
        throw new DeclaredEnvRegistrationError(
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
