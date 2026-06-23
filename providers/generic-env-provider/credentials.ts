/**
 * Secret-backed generic-env provider connection driver (provider-agnostic).
 *
 * A generic-env provider Connection (`kind: "generic_env_provider"`) carries
 * write-only provider env values for arbitrary OpenTofu providers. Known
 * providers can still use built-in env allowlists; unknown providers use the
 * connection's own `envNames` as the declared recipe. There is no per-provider
 * arg mapping: each declared variable is passed straight through to the
 * generated root as `TF_VAR_<name>`.
 *
 * This driver is the extracted, self-contained form of the vault's
 * `#mintCustomProviderVariables` logic. The crypto / secret-opening stays in
 * core (the vault opens the sealed blob and hands the decrypted values in); this
 * driver maps already-opened values to the runner-facing `TF_VAR_*` env map and
 * the provider-credential mint evidence.
 *
 * Behavior is byte-identical to the in-vault path:
 *   - A non-`generic_env_provider` connection contributes nothing (returns
 *     `undefined`), so rootgen emits a credential-free alias.
 *   - A `generic_env_provider` connection that is not Space-scoped is a precondition
 *     failure (operator-scoped generic-env provider credentials are not allowed).
 *   - Each string value `NAME` becomes `TF_VAR_NAME`; non-string values are
 *     skipped (defensive — the open path already filters to strings).
 */
import type { Connection } from "takosumi-contract/connections";
import {
  allowedEnvNamesForProvider,
  providerEnvRule,
} from "takosumi-contract/provider-env-rules";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";

/**
 * Error raised when a generic-env provider connection violates a structural
 * precondition (e.g. an operator-scoped generic-env provider credential). The `code` mirrors the
 * deploy-control error codes the vault raises so the caller can translate it
 * identically to the in-vault `ConnectionVaultError`.
 */
export class GenericEnvProviderDriverError extends Error {
  readonly code: "failed_precondition" | "invalid_argument";

  constructor(
    message: string,
    code: GenericEnvProviderDriverError["code"] = "failed_precondition",
  ) {
    super(message);
    this.name = "GenericEnvProviderDriverError";
    this.code = code;
  }
}

/** Successful mint output: the `TF_VAR_*` env map plus mint evidence. */
export interface GenericEnvProviderMintResult {
  readonly env: Readonly<Record<string, string>>;
  readonly evidence: ProviderCredentialMintEvidence;
}

/**
 * Mint the generic-env credential variables for one connection.
 *
 * @param connection the resolved Connection row (already re-validated by the
 *   vault for existence + space ownership + verified status).
 * @param values the connection's already-decrypted `{ name: value }` map. The
 *   vault opens the sealed blob; this driver never touches crypto.
 * @param alias the OpenTofu provider alias declared by the generated root, if
 *   any. Accepted for parity with the per-alias provider-credential drivers;
 *   the generic passthrough does not vary by alias.
 * @returns the `TF_VAR_<name>` env map and mint evidence, or `undefined` when
 *   the connection is not a `generic_env_provider` (no per-alias split applies, so
 *   the runner admits no shared provider credential env for it).
 */
export function mintGenericEnvProviderVariables(
  connection: Connection,
  values: Readonly<Record<string, string>>,
  alias: string | undefined,
): GenericEnvProviderMintResult | undefined {
  void alias;
  if (connection.kind !== "generic_env_provider") return undefined;
  if (connection.scope !== "space") {
    throw new GenericEnvProviderDriverError(
      `generic-env provider connection ${connection.id} must be Space-scoped`,
    );
  }
  const rule = providerEnvRule(connection.provider);
  const allowed = new Set(
    rule
      ? allowedEnvNamesForProvider(connection.provider)
      : connection.envNames,
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string") continue;
    if (!allowed.has(name)) {
      throw new GenericEnvProviderDriverError(
        `env name ${name} is not allowed for provider ${connection.provider}`,
        "invalid_argument",
      );
    }
    env[`TF_VAR_${name}`] = value;
  }
  return {
    env,
    evidence: {
      providerEnvId: connection.id,
      provider: connection.provider,
      connectionId: connection.id,
      delivery: "generated_root_variable",
      rootOnly: true,
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    },
  };
}
