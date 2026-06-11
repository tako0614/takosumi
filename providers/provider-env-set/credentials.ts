/**
 * Provider Env Set credential driver (generic, provider-agnostic).
 *
 * A Provider Env Set is a Space-owned Connection (`kind: "provider_env_set"`)
 * carrying write-only provider env values for AWS / GCP / GitHub / Kubernetes /
 * Azure / any arbitrary OpenTofu provider that is not a Takosumi-provided
 * managed default. There is no per-provider arg mapping: each declared variable
 * is passed straight through to the generated root as `TF_VAR_<name>`.
 *
 * This driver is the extracted, self-contained form of the vault's
 * `#mintCustomProviderVariables` logic. The crypto / secret-opening stays in
 * core (the vault opens the sealed blob and hands the decrypted values in); this
 * driver maps already-opened values to the runner-facing `TF_VAR_*` env map and
 * the provider-credential mint evidence.
 *
 * Behavior is byte-identical to the in-vault path:
 *   - A non-`provider_env_set` connection contributes nothing (returns
 *     `undefined`), so rootgen emits a credential-free alias.
 *   - A `provider_env_set` connection that is not Space-scoped is a precondition
 *     failure (operator-scoped env sets are not allowed).
 *   - Each string value `NAME` becomes `TF_VAR_NAME`; non-string values are
 *     skipped (defensive — the open path already filters to strings).
 */
import type { Connection } from "takosumi-contract/connections";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";

/**
 * Error raised when a Provider Env Set connection violates a structural
 * precondition (e.g. an operator-scoped env set). The `code` mirrors the
 * deploy-control error codes the vault raises so the caller can translate it
 * identically to the in-vault `ConnectionVaultError`.
 */
export class ProviderEnvSetDriverError extends Error {
  readonly code: "failed_precondition";

  constructor(message: string) {
    super(message);
    this.name = "ProviderEnvSetDriverError";
    this.code = "failed_precondition";
  }
}

/** Successful mint output: the `TF_VAR_*` env map plus mint evidence. */
export interface ProviderEnvSetMintResult {
  readonly env: Readonly<Record<string, string>>;
  readonly evidence: ProviderCredentialMintEvidence;
}

/**
 * Mint the generic Provider Env Set credential variables for one connection.
 *
 * @param connection the resolved Connection row (already re-validated by the
 *   vault for existence + space ownership + verified status).
 * @param values the connection's already-decrypted `{ name: value }` map. The
 *   vault opens the sealed blob; this driver never touches crypto.
 * @param alias the OpenTofu provider alias declared by the generated root, if
 *   any. Accepted for parity with the per-alias provider-credential drivers;
 *   the generic passthrough does not vary by alias.
 * @returns the `TF_VAR_<name>` env map and mint evidence, or `undefined` when
 *   the connection is not a `provider_env_set` (no per-alias split applies, so
 *   the runner admits no shared provider env for it).
 */
export function mintProviderEnvSetVariables(
  connection: Connection,
  values: Readonly<Record<string, string>>,
  alias: string | undefined,
): ProviderEnvSetMintResult | undefined {
  void alias;
  if (connection.kind !== "provider_env_set") return undefined;
  if (connection.scope !== "space") {
    throw new ProviderEnvSetDriverError(
      `provider env set connection ${connection.id} must be Space-scoped`,
    );
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string") continue;
    env[`TF_VAR_${name}`] = value;
  }
  return {
    env,
    evidence: {
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
