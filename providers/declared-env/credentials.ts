/**
 * Secret-backed declared-env credential driver (provider-agnostic).
 *
 * This reusable driver handles any ProviderConnection whose installed recipe
 * declares the `declaredEnv` capability. Such a connection carries write-only
 * provider env values and credential files for arbitrary OpenTofu providers.
 * The connection's own `envNames` / `fileEnvNames` are the declared recipe for
 * known and unknown providers alike. There is no per-provider arg
 * mapping: each declared variable is passed straight through to the runner
 * process under its real environment-variable name, and declared file env names
 * receive the runner-local credential file path.
 *
 * The crypto / secret-opening stays in core (the vault opens the sealed blob
 * and hands the decrypted values in); this optional driver maps already-opened
 * values/files to the runner-facing env/file map and provider-credential mint
 * evidence. Its contract is intentionally provider-neutral:
 *   - A recipe without `declaredEnv` contributes nothing (returns
 *     `undefined`), so rootgen emits a credential-free alias.
 *   - A declared-env connection that is not Workspace-scoped is a precondition
 *     failure (operator-scoped declared-env provider credentials are not allowed).
 *   - Each string value `NAME` becomes `NAME`; non-string values are
 *     skipped (defensive — the open path already filters to strings).
 */
import {
  type ProviderConnection,
  usesDeclaredEnvCredentialRecipe,
} from "takosumi-contract/connections";
import type { MintedFile } from "takosumi-contract/sources";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";

/**
 * Error raised when a declared-env connection violates a structural
 * precondition (for example, operator scope). The `code` mirrors the
 * deploy-control error codes so the Vault can expose one stable error surface.
 */
export class DeclaredEnvCredentialDriverError extends Error {
  readonly code: "failed_precondition" | "invalid_argument";

  constructor(
    message: string,
    code: DeclaredEnvCredentialDriverError["code"] = "failed_precondition",
  ) {
    super(message);
    this.name = "DeclaredEnvCredentialDriverError";
    this.code = code;
  }
}

/** Successful mint output: the process env map plus mint evidence. */
export interface DeclaredEnvCredentialMintResult {
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly MintedFile[];
  readonly evidence: ProviderCredentialMintEvidence;
}

/**
 * Mint the declared env/file credential material for one connection.
 *
 * @param connection the resolved ProviderConnection row (already re-validated by the
 *   vault for existence + Workspace ownership + verified status).
 * @param values the connection's already-decrypted `{ name: value }` map. The
 *   vault opens the sealed blob; this driver never touches crypto.
 * @returns the process env map and mint evidence, or `undefined` when the
 *   recipe does not declare `declaredEnv` (no generic process-env delivery
 *   applies).
 */
export function mintDeclaredEnvCredentialVariables(
  connection: ProviderConnection,
  values: Readonly<Record<string, string>>,
  files: readonly MintedFile[],
): DeclaredEnvCredentialMintResult | undefined {
  if (!usesDeclaredEnvCredentialRecipe(connection)) return undefined;
  if (connection.scope !== "workspace") {
    throw new DeclaredEnvCredentialDriverError(
      `declared-env provider connection ${connection.id} must be Workspace-scoped`,
    );
  }
  const fileEnvNames = new Set(connection.fileEnvNames ?? []);
  const allowed = new Set(
    connection.envNames.filter((name) => !fileEnvNames.has(name)),
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string") continue;
    if (!allowed.has(name)) {
      throw new DeclaredEnvCredentialDriverError(
        `env name ${name} is not allowed for provider ${connection.provider}`,
        "invalid_argument",
      );
    }
    env[name] = value;
  }
  const allowedFileEnvNames = fileEnvNames;
  const mintedFiles = files.map((file) => {
    if (file.envName && !allowedFileEnvNames.has(file.envName)) {
      throw new DeclaredEnvCredentialDriverError(
        `file env name ${file.envName} is not allowed for provider ${connection.provider}`,
        "invalid_argument",
      );
    }
    return { ...file };
  });
  return {
    env,
    files: mintedFiles,
    evidence: {
      provider: connection.provider,
      connectionId: connection.id,
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    },
  };
}
