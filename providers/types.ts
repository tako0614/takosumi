/**
 * Guided provider setup metadata.
 *
 * Known providers have optional guided Credential Recipe metadata. This
 * registry is not an execution allowlist: unknown providers use the same
 * OpenTofu runner and generic env/file Provider Connections.
 *
 * This file is the leaf of the dependency graph: it imports only the public
 * contract types, so `core`, `worker`, `rootgen`, and the deploy targets can all
 * depend on the registry without a cycle.
 */
import type { ProviderConnectionKind } from "takosumi-contract/connections";
import type { ProviderCredentialArg } from "takosumi-contract/provider-env-rules";

export interface GuidedProviderSetup {
  /** Stable setup id. */
  readonly id: string;
  readonly displayName: string;
  /** Fully-qualified OpenTofu provider sources covered by this setup helper. */
  readonly providerAddresses: readonly string[];
  /** Connection kinds whose driver this provider implements. */
  readonly connectionKinds: readonly ProviderConnectionKind[];
  /**
   * Per-alias credential env-name -> OpenTofu provider-argument mapping for the
   * per-alias credential split (e.g. Cloudflare `CLOUDFLARE_API_TOKEN` ->
   * `api_token`). Empty for a provider that keeps a credential-free shared-env
   * alias. Sourced byte-for-byte from `PROVIDER_CREDENTIAL_ARG_MAP` in
   * `provider-env-rules` (the dependency-free table the runner container also
   * reads); the registry imports it so per-provider credential data has a single
   * source.
   */
  readonly credentialArgs: readonly ProviderCredentialArg[];
  /**
   * Every credential env name this provider may supply, from the
   * `provider-env-rules` table. Empty for a provider with no env-rule entry.
   */
  readonly credentialEnvNames: readonly string[];
}
